import { SnowflakeUtil } from "discord.js";

interface ServerData {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  onlineMembers: number;
  totalMembers: number;
  hasAnimatedIcon: boolean;
  hasAnimatedBanner: boolean;
  badges: ServerBadge[];
  boostLevel: number;
  traits: string[];
  establishedDate: string | null;
  bannerColor: string | null;
  features: string[];
  verificationLevel: number;
}

type ServerBadge = 
  | 'verified'
  | 'partnered' 
  | 'employee_only'
  | 'community'
  | 'community_boosted'
  | 'discoverable'
  | 'discoverable_boosted';

interface RawDiscordServer {
  id?: string;
  name?: string;
  description?: string;
  icon?: string;
  banner?: string;
  features?: string[];
  premium_tier?: number;
  verification_level?: number;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  created_at?: string;
  owner_id?: string;
}

interface ColorAnalysis {
  dominantColor: string;
  averageColor: string;
  isLight: boolean;
}

interface CacheEntry {
  data: ServerData;
  timestamp: number;
  expires: number;
}

export class ServerDataHelper {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  private readonly CDN_BASE = 'https://cdn.discordapp.com';
  
  // Badge priority mapping (higher = more important)
  private readonly BADGE_PRIORITIES = {
    'verified': 10,
    'partnered': 9,
    'community_boosted': 8,
    'discoverable_boosted': 8,
    'community': 7,
    'discoverable': 6,
    'employee_only': 5
  };

  /**
   * Main method to process Discord server data
   */
  async processServerData(guildId: string, discordToken?: string): Promise<ServerData> {
    // Check cache first
    const cached = this.getFromCache(guildId);
    if (cached) return cached;

    try {
      // Fetch from Discord API
      const rawData = await this.fetchServerFromAPI(guildId, discordToken);
      const processedData = await this.normalizeServerData(rawData);
      
      // Cache the result
      this.addToCache(guildId, processedData);
      
      return processedData;
    } catch (error) {
      console.error(`Failed to process server ${guildId}:`, error);
      throw new Error(`Unable to fetch server data: ${error}`);
    }
  }

  /**
   * Process Discord.js Guild object directly
   */
  async processDiscordGuild(guild: any): Promise<ServerData> {
    const cached = this.getFromCache(guild.id);
    if (cached) return cached;

    const rawData: RawDiscordServer = {
      id: guild.id,
      name: guild.name,
      description: guild.description,
      icon: guild.icon,
      banner: guild.banner,
      features: guild.features || [],
      premium_tier: guild.premiumTier,
      verification_level: guild.verificationLevel,
      approximate_member_count: guild.memberCount,
      approximate_presence_count: guild.presenceCount || Math.floor(guild.memberCount * 0.3),
      created_at: guild.createdAt?.toISOString()
    };

    const processedData = await this.normalizeServerData(rawData);
    this.addToCache(guild.id, processedData);
    
    return processedData;
  }

  /**
   * Process Discord.js Guild object directly with optional member counts from invites
   */
  guildToServerData(options: { guild: any, memberCount?: number | null, presenceCount?: number | null }): Promise<ServerData> {
    const { guild, memberCount, presenceCount } = options;
    
    // Augment the guild object with potentially missing counts from the invite data
    const augmentedGuild = {
      ...guild,
      memberCount: memberCount ?? guild.memberCount,
      presenceCount: presenceCount ?? guild.presenceCount,
      features: guild.features || [],
      premiumTier: guild.premiumTier || 0,
      verificationLevel: guild.verificationLevel || 0,
      createdAt: guild.createdAt || new Date(SnowflakeUtil.timestampFrom(guild.id))
    };
    
    return this.processDiscordGuild(augmentedGuild);
  }

  /**
   * Fetch server data from Discord API
   */
  private async fetchServerFromAPI(guildId: string, token?: string): Promise<RawDiscordServer> {
    if (!token) {
      throw new Error('Discord token required for API access');
    }

    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}?with_counts=true`, {
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Server not found or bot not in server');
      }
      throw new Error(`Discord API error: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Normalize raw Discord data into our ServerData format
   */
  private async normalizeServerData(raw: RawDiscordServer): Promise<ServerData> {
    const serverId = raw.id!;
    
    // Process URLs
    const iconUrl = await this.buildAssetUrl(serverId, raw.icon, 'icons', 256);
    const bannerUrl = await this.buildAssetUrl(serverId, raw.banner, 'banners', 1024);
    
    // Process member counts
    const totalMembers = raw.approximate_member_count || 0;
    const onlineMembers = raw.approximate_presence_count || Math.floor(totalMembers * 0.25);
    
    // Determine badges from features
    const badges = this.processBadges(raw.features || [], raw.premium_tier || 0);
    
    // Generate banner color if needed
    const bannerColor = await this.determineBannerColor(iconUrl, serverId);
    
    return {
      id: serverId,
      name: this.sanitizeName(raw.name || 'Unknown Server'),
      description: this.sanitizeDescription(raw.description || ''),
      iconUrl,
      bannerUrl,
      onlineMembers,
      totalMembers,
      hasAnimatedIcon: this.isAnimatedHash(raw.icon),
      hasAnimatedBanner: this.isAnimatedHash(raw.banner),
      badges: this.sortBadgesByPriority(badges),
      boostLevel: Math.min(raw.premium_tier || 0, 3),
      traits: this.generateTraits(raw.features || [], raw.verification_level || 0),
      establishedDate: this.formatEstablishedDate(raw.created_at),
      bannerColor,
      features: raw.features || [],
      verificationLevel: raw.verification_level || 0
    };
  }

  /**
   * Build Discord CDN asset URL
   */
  private async buildAssetUrl(
    serverId: string, 
    hash: string | null | undefined, 
    type: 'icons' | 'banners', 
    size: number
  ): Promise<string | null> {
    if (!hash) return null;
    
    const extension = this.isAnimatedHash(hash) ? 'gif' : 'png';
    const url = `${this.CDN_BASE}/${type}/${serverId}/${hash}.${extension}?size=${size}`;
    
    // Verify asset exists
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * Check if asset hash indicates animation
   */
  private isAnimatedHash(hash: string | null | undefined): boolean {
    return Boolean(hash?.startsWith('a_'));
  }

  /**
   * Process server features into badges
   */
  private processBadges(features: string[], premiumTier: number): ServerBadge[] {
    const badges: ServerBadge[] = [];
    
    // Feature to badge mapping
    const featureMap: Record<string, ServerBadge> = {
      'VERIFIED': 'verified',
      'PARTNERED': 'partnered', 
      'DISCORD_EMPLOYEE': 'employee_only',
      'COMMUNITY': 'community',
      'DISCOVERABLE': 'discoverable'
    };
    
    // Add basic badges from features
    for (const feature of features) {
      const badge = featureMap[feature];
      if (badge && !badges.includes(badge)) {
        badges.push(badge);
      }
    }
    
    // Add boosted variants for premium servers
    if (premiumTier > 0) {
      if (badges.includes('community')) {
        badges.push('community_boosted');
        badges.splice(badges.indexOf('community'), 1);
      }
      if (badges.includes('discoverable')) {
        badges.push('discoverable_boosted');
        badges.splice(badges.indexOf('discoverable'), 1);
      }
    }
    
    return badges;
  }

  /**
   * Sort badges by priority (highest first)
   */
  private sortBadgesByPriority(badges: ServerBadge[]): ServerBadge[] {
    return badges.sort((a, b) => {
      const priorityA = this.BADGE_PRIORITIES[a] || 0;
      const priorityB = this.BADGE_PRIORITIES[b] || 0;
      return priorityB - priorityA;
    });
  }

  /**
   * Generate server traits from features
   */
  private generateTraits(features: string[], verificationLevel: number): string[] {
    const traits: string[] = [];
    
    // Feature-based traits
    if (features.includes('THREADS_ENABLED')) traits.push('Threads');
    if (features.includes('PRIVATE_THREADS')) traits.push('Private Threads');
    if (features.includes('ROLE_ICONS')) traits.push('Role Icons');
    if (features.includes('BANNER')) traits.push('Server Banner');
    if (features.includes('VANITY_URL')) traits.push('Custom Invite');
    if (features.includes('COMMERCE')) traits.push('Store Channels');
    if (features.includes('NEWS')) traits.push('Announcement Channels');
    if (features.includes('MEMBER_VERIFICATION_GATE_ENABLED')) traits.push('Membership Screening');
    
    // Verification level traits
    if (verificationLevel >= 2) traits.push('High Security');
    if (verificationLevel >= 3) traits.push('Very High Security');
    
    return traits.slice(0, 5); // Limit to 5 traits
  }

  /**
   * Determine banner color from icon or generate deterministic color
   */
  private async determineBannerColor(iconUrl: string | null, serverId: string): Promise<string> {
    if (iconUrl) {
      try {
        const color = await this.extractDominantColor(iconUrl);
        if (color) return color;
      } catch (error) {
        console.warn('Failed to extract color from icon:', error);
      }
    }
    
    // Generate deterministic color from server ID
    return this.generateDeterministicColor(serverId);
  }

  /**
   * Extract dominant color from image (simplified version for Sharp)
   */
  private async extractDominantColor(imageUrl: string): Promise<string | null> {
    try {
      // This would be implemented with Sharp in the card generator
      // For now, return null to use fallback
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Generate deterministic color from server ID
   */
  private generateDeterministicColor(serverId: string): string {
    let hash = 0;
    for (let i = 0; i < serverId.length; i++) {
      const char = serverId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    // Generate RGB from hash with minimum brightness
    const r = Math.max((hash & 0xFF0000) >> 16, 80);
    const g = Math.max((hash & 0x00FF00) >> 8, 80);
    const b = Math.max(hash & 0x0000FF, 80);
    
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  /**
   * Format established date
   */
  private formatEstablishedDate(createdAt: string | undefined): string | null {
    if (!createdAt) return null;
    
    try {
      const date = new Date(createdAt);
      return date.getFullYear().toString();
    } catch {
      return null;
    }
  }

  /**
   * Sanitize server name
   */
  private sanitizeName(name: string): string {
    return name.trim().substring(0, 100);
  }

  /**
   * Sanitize description
   */
  private sanitizeDescription(description: string): string {
    return description.trim().substring(0, 300).replace(/\s+/g, ' ');
  }

  /**
   * Generate server initials for fallback icon
   */
  generateServerInitials(serverName: string): string {
    return serverName
      .split(' ')
      .map(word => word.charAt(0).toUpperCase())
      .slice(0, 3)
      .join('');
  }

  /**
   * Cache management
   */
  private addToCache(key: string, data: ServerData): void {
    const now = Date.now();
    this.cache.set(key, {
      data,
      timestamp: now,
      expires: now + this.CACHE_TTL
    });
  }

  private getFromCache(key: string): ServerData | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Clear expired cache entries
   */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expires) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      ttl: this.CACHE_TTL
    };
  }
}

export { type ServerData, type ServerBadge, type RawDiscordServer };