import sharp from 'sharp';
import { ServerData, ServerBadge } from '../Data Helper/server.js';
import { FontManager, fontManager, DiscordFontConfig } from '../Assets/fonts.js';
import { GUILD_BADGES, BOOST_ICONS, GUILD_STATUS, GuildBadgeDefinition } from '../Assets/guildBadges.js';

/**
 * Options for customizing the generated server info card.
 */
interface GenerationOptions {
  format?: 'webp' | 'png';
  quality?: number;
}

/**
 * Generates dynamic, Discord-style server preview cards using Sharp.
 * This class handles the composition of various elements like banners, icons,
 * text, and badges into a single image. It uses Sharp for all image processing.
 */
export class InfoCardGenerator {
  private fontManager: FontManager;
  private initialized = false;

  /**
   * A predefined color palette that mimics Discord's UI colors.
   */
  private readonly COLORS = {
    cardBackground: '#18191c',
    textPrimary: '#ffffff',
    textSecondary: '#dcddde',
    textMuted: '#b5bac1',
    onlineGreen: '#23a55a',
    offlineGray: '#80848e',
  };

  /**
   * Defines the fixed dimensions and layout of the card, inspired by the reference.
   */
  private readonly DIMS = {
    width: 800,
    height: 450,
    bannerHeight: 180,
    iconSize: 100,
    iconRadius: 20,
    iconOffset: { x: 40, y: 130 }, // y = bannerHeight - (iconSize / 2)
  };

  /**
   * Defines the coordinates and sizes for various layout elements.
   */
  private readonly LAYOUT = {
    name: { x: 160, y: 20 },
    badge: { size: 28 },
    stats: { x: 160, y: 65 },
    description: { x: 40, y: 115, maxWidth: 720, maxLines: 3 },
    boost: { x: 720, y: 15, size: 64 },
  };

  constructor() {
    this.fontManager = fontManager;
  }

  /**
   * Initializes the generator by ensuring the font manager is ready.
   * This must be called before any card generation.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.fontManager.isInitialized()) {
      await this.fontManager.initialize();
    }
    this.initialized = true;
  }

  /**
   * Generates a server preview card based on the provided data and options.
   * @param serverData The data for the server to be displayed.
   * @param options Customization options for the output image.
   * @returns A Promise that resolves to the image buffer.
   */
  async generateCard(serverData: ServerData, options: GenerationOptions = {}): Promise<Buffer> {
    if (!this.initialized) {
      throw new Error('InfoCardGenerator not initialized. Call initialize() first.');
    }

    const opts: Required<GenerationOptions> = {
      format: 'webp',
      quality: 90,
      ...options
    };

    const { width, height, bannerHeight } = this.DIMS;

    // Create all the visual layers of the card.
    const bannerLayer = await this.createBannerLayer(serverData);
    const profileLayer = await this.createProfileLayer(serverData);
    const iconLayer = await this.createServerIcon(serverData);
    
    const layers: sharp.OverlayOptions[] = [
      // The main card content (name, description, stats)
      { input: profileLayer, top: bannerHeight, left: 0 },
      // The server banner (or fallback color)
      { input: bannerLayer, top: 0, left: 0 },
      // The server icon, which overlaps the banner and profile sections
      { input: iconLayer, top: this.DIMS.iconOffset.y, left: this.DIMS.iconOffset.x },
    ];

    // If the server is boosted, create and add the boost level indicator.
    if (serverData.boostLevel > 0) {
      const boostIndicator = await this.createBoostIndicator(serverData.boostLevel);
      layers.push({
        input: boostIndicator,
        top: this.LAYOUT.boost.y,
        left: this.LAYOUT.boost.x
      });
    }

    // Composite all layers onto a base canvas.
    const canvas = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: this.hexToRgba(this.COLORS.cardBackground)
      }
    }).composite(layers);

    return this.applyFormat(canvas, opts);
  }

  /**
   * Fetches an image asset from a URL.
   * @param url The URL of the asset to fetch.
   * @returns A Promise resolving to the image buffer.
   */
  private async fetchAsset(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch asset: ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Creates the banner layer, fetching the server's banner or creating a fallback color.
   * @param serverData The server data.
   * @returns A Promise resolving to the banner image buffer.
   */
  private async createBannerLayer(serverData: ServerData): Promise<Buffer> {
    const { width, bannerHeight } = this.DIMS;

    if (serverData.bannerUrl) {
      try {
        const buffer = await this.fetchAsset(serverData.bannerUrl);
        // Use the first frame of an animated banner.
        const banner = sharp(buffer, { animated: true, page: 0 });
        return await banner
          .resize(width, bannerHeight, { fit: 'cover', position: 'center' })
          .png()
          .toBuffer();
      } catch (error) {
        console.warn('Failed to load banner, using fallback color.', error);
      }
    }

    // If no banner is available, create a solid color fallback.
    const color = serverData.bannerColor || this.COLORS.cardBackground;
    return sharp({
      create: { width, height: bannerHeight, channels: 4, background: this.hexToRgba(color) }
    }).png().toBuffer();
  }

  /**
   * Creates the profile section layer, containing the name, stats, and description.
   * @param serverData The server data.
   * @returns A Promise resolving to the profile section buffer.
   */
  private async createProfileLayer(serverData: ServerData): Promise<Buffer> {
    const { width } = this.DIMS;
    const profileHeight = this.DIMS.height - this.DIMS.bannerHeight;

    const profileCanvas = sharp({
      create: { width, height: profileHeight, channels: 4, background: this.hexToRgba(this.COLORS.cardBackground) }
    });

    const overlays: sharp.OverlayOptions[] = [];

    // --- Server Name and Badge ---
    const { buffer: nameBuffer, width: nameWidth } = await this.createTextSvg(serverData.name, {
      font: 'serverName',
      color: this.COLORS.textPrimary,
      maxWidth: 500 // Max width before truncating
    });
    overlays.push({ input: nameBuffer, top: this.LAYOUT.name.y, left: this.LAYOUT.name.x });

    if (serverData.badges.length > 0) {
      const topBadge = serverData.badges[0];
      const badgeBuffer = await this.createBadgeImage(topBadge, this.LAYOUT.badge.size);
      overlays.push({ input: badgeBuffer, top: this.LAYOUT.name.y + 4, left: this.LAYOUT.name.x + nameWidth + 10 });
    }

    // --- Member Stats ---
    const statsSection = await this.createMemberStats(serverData);
    overlays.push({ input: statsSection, top: this.LAYOUT.stats.y, left: this.LAYOUT.stats.x });

    // --- Server Description ---
    if (serverData.description) {
      const { buffer: descBuffer } = await this.createTextSvg(serverData.description, {
        font: 'description',
        color: this.COLORS.textSecondary,
        maxWidth: this.LAYOUT.description.maxWidth,
        maxLines: this.LAYOUT.description.maxLines
      });
      overlays.push({ input: descBuffer, top: this.LAYOUT.description.y, left: this.LAYOUT.description.x });
    }

    return profileCanvas.composite(overlays).png().toBuffer();
  }

  /**
   * Creates the server icon, fetching the URL or generating an initials-based fallback.
   * @param serverData The server data.
   * @returns A Promise resolving to the rounded icon buffer.
   */
  private async createServerIcon(serverData: ServerData): Promise<Buffer> {
    const { iconSize, iconRadius } = this.DIMS;
    let iconImage: Buffer;

    if (serverData.iconUrl) {
      try {
        const buffer = await this.fetchAsset(serverData.iconUrl);
        // Use the first frame of an animated icon.
        iconImage = await sharp(buffer, { animated: true, page: 0 })
          .resize(iconSize, iconSize, { fit: 'cover' })
          .png()
          .toBuffer();
      } catch (error) {
        console.warn('Failed to load icon, using initials fallback.', error);
        iconImage = await this.createFallbackIcon(serverData);
      }
    } else {
      iconImage = await this.createFallbackIcon(serverData);
    }

    // Apply a rounded corner mask to the icon.
    const mask = Buffer.from(`<svg><rect x="0" y="0" width="${iconSize}" height="${iconSize}" rx="${iconRadius}" ry="${iconRadius}"/></svg>`);
    return sharp(iconImage).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  }
  
  /**
   * Creates a fallback icon with the server's initials if no icon is available.
   * @param serverData The server data.
   * @returns A Promise resolving to the fallback icon buffer.
   */
  private async createFallbackIcon(serverData: ServerData): Promise<Buffer> {
      const { iconSize } = this.DIMS;
      const initials = serverData.name.split(' ').map(w => w[0]).join('').substring(0, 3).toUpperCase();
      const { buffer } = await this.createTextSvg(initials, {
          font: 'logoInitials',
          color: this.COLORS.textPrimary
      });

      return sharp({
          create: {
              width: iconSize,
              height: iconSize,
              channels: 4,
              background: this.hexToRgba(this.COLORS.cardBackground, 0.7)
          }
      }).composite([{ input: buffer, gravity: 'center' }]).png().toBuffer();
  }

  /**
   * Creates the member statistics section (online and total members).
   * @param serverData The server data.
   * @returns A Promise resolving to the stats section buffer.
   */
  private async createMemberStats(serverData: ServerData): Promise<Buffer> {
    const onlineIndicator = await this.createStatusIndicator(true, 12);
    const { buffer: onlineText } = await this.createTextSvg(`${serverData.onlineMembers.toLocaleString()} Online`, {
      font: 'memberStats',
      color: this.COLORS.textMuted
    });

    const totalIndicator = await this.createStatusIndicator(false, 12);
    const { buffer: totalText } = await this.createTextSvg(`${serverData.totalMembers.toLocaleString()} Members`, {
      font: 'memberStats',
      color: this.COLORS.textMuted
    });

    // Composite the indicators and text into a single transparent image.
    return sharp({ create: { width: 400, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: onlineIndicator, top: 4, left: 0 },
        { input: onlineText, top: 0, left: 20 },
        { input: totalIndicator, top: 4, left: 140 },
        { input: totalText, top: 0, left: 160 },
      ]).png().toBuffer();
  }

  /**
   * Creates the server boost level indicator image.
   * @param level The server's boost level (1, 2, or 3).
   * @returns A Promise resolving to the boost indicator buffer.
   */
  private async createBoostIndicator(level: number): Promise<Buffer> {
    const { size } = this.LAYOUT.boost;
    const boostSvgData = BOOST_ICONS[level as keyof typeof BOOST_ICONS];
    if (!boostSvgData) return Buffer.alloc(0);

    const boostSvgString = this.renderBoostSvg(boostSvgData, size);
    return sharp(Buffer.from(boostSvgString)).png().toBuffer();
  }

  /**
   * Creates a badge image from an SVG asset definition.
   * @param badgeType The type of badge to create.
   * @param size The desired size of the badge.
   * @returns A Promise resolving to the badge image buffer.
   */
  private async createBadgeImage(badgeType: ServerBadge, size: number): Promise<Buffer> {
    const svgData = GUILD_BADGES[badgeType as keyof typeof GUILD_BADGES];
    if (!svgData) return Buffer.alloc(0);
    
    const svgString = this.renderBadgeSvg(svgData, size);
    return sharp(Buffer.from(svgString)).png().toBuffer();
  }

  /**
   * Creates a status indicator dot (online/offline).
   * @param isOnline Whether the indicator should be green or gray.
   * @param size The desired size of the indicator.
   * @returns A Promise resolving to the indicator image buffer.
   */
  private async createStatusIndicator(isOnline: boolean, size: number): Promise<Buffer> {
    const statusData = isOnline ? GUILD_STATUS.ONLINE : GUILD_STATUS.OFFLINE;
    const svgString = this.renderStatusSvg(statusData, size);
    return sharp(Buffer.from(svgString)).png().toBuffer();
  }

  /**
   * Renders a badge definition object into an SVG string.
   * @param badge The badge definition from guildBadges.ts.
   * @param size The desired output size.
   * @returns An SVG string.
   */
  private renderBadgeSvg(badge: GuildBadgeDefinition, size: number): string {
    const paths = badge.paths.map(p => `<path d="${p.path}" fill="${p.fill}" fill-rule="${p.fillRule || 'evenodd'}" clip-rule="${p.clipRule || 'evenodd'}"></path>`).join('');
    return `<svg width="${size}" height="${size}" viewBox="${badge.viewBox}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  /**
   * Renders a boost icon definition object into an SVG string.
   * @param boostData The boost icon definition from guildBadges.ts.
   * @param size The desired output size.
   * @returns An SVG string.
   */
  private renderBoostSvg(boostData: any, size: number): string {
    const paths = boostData.paths.map((p: any) => `<path d="${p.path}" fill="${p.fill}"></path>`).join('');
    return `<svg width="${size}" height="${size}" viewBox="${boostData.viewBox}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  }

  /**
   * Renders a status indicator object into an SVG string.
   * @param status The status object from guildBadges.ts.
   * @param size The desired output size.
   * @returns An SVG string.
   */
  private renderStatusSvg(status: any, size: number): string {
    return `<svg width="${size}" height="${size}" viewBox="${status.viewBox}" xmlns="http://www.w3.org/2000/svg">
        <path d="${status.background.path}" fill="${status.background.fill}"></path>
        <path d="${status.indicator.path}" fill="${status.indicator.fill}"></path>
    </svg>`;
  }

  /**
   * Wraps text to fit within a maximum width.
   * @param text The text to wrap.
   * @param maxWidth The maximum pixel width.
   * @param fontSize The font size.
   * @returns An array of strings, where each string is a line of wrapped text.
   */
  private wrapText(text: string, maxWidth: number, fontSize: number): string[] {
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    if (!words.length) return [];
    
    const lines: string[] = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = this.estimateTextWidth(currentLine + " " + word, fontSize);
        if (width < maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
  }

  /**
   * Creates a text element as an SVG and renders it to a PNG buffer.
   * @param text The text content.
   * @param options Styling options for the text.
   * @returns A Promise resolving to an object with the buffer and dimensions.
   */
  private async createTextSvg(text: string, options: {
    font: keyof DiscordFontConfig;
    color: string;
    maxWidth?: number;
    maxLines?: number;
  }): Promise<{ buffer: Buffer, width: number, height: number }> {
    const { font, color, maxWidth = 1000, maxLines = 1 } = options;
    
    const fontMetrics = this.fontManager.getDiscordFont(font);
    const fontFamily = this.fontManager.getFontFamily(fontMetrics.family);
    const fontWeight = this.fontManager.getBestFontWeight(fontMetrics.family, fontMetrics.weight);
    const fontSize = fontMetrics.size;
    const lineHeight = fontSize * fontMetrics.lineHeight;

    const lines = this.wrapText(text, maxWidth, fontSize).slice(0, maxLines);
    const svgHeight = lines.length * lineHeight;
    
    // Find the longest line to set the SVG width accurately.
    const longestLine = lines.reduce((a, b) => (a.length > b.length ? a : b), '');
    const svgWidth = this.estimateTextWidth(longestLine, fontSize);

    const tspanLines = lines.map((line, i) => 
        `<tspan x="0" dy="${i === 0 ? 0 : lineHeight}px">${this.escapeXml(line)}</tspan>`
    ).join('');

    const svg = `
      <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
        <text y="${fontSize * 0.8}" font-family="${fontFamily}" font-size="${fontSize}px" font-weight="${fontWeight}" fill="${color}">${tspanLines}</text>
      </svg>
    `;
    
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    return { buffer, width: svgWidth, height: svgHeight };
  }

  /**
   * Applies the final output format and quality options to the image.
   * @param canvas The Sharp instance representing the composed image.
   * @param options The generation options.
   * @returns A Promise resolving to the final image buffer.
   */
  private async applyFormat(canvas: sharp.Sharp, options: Required<GenerationOptions>): Promise<Buffer> {
    switch (options.format) {
      case 'png': return canvas.png({ quality: options.quality }).toBuffer();
      case 'webp':
      default:
        return canvas.webp({ quality: options.quality }).toBuffer();
    }
  }

  /**
   * Estimates the pixel width of a string of text. A simple approximation.
   * @param text The text to measure.
   * @param fontSize The font size in pixels.
   * @returns The estimated width in pixels.
   */
  private estimateTextWidth(text: string, fontSize: number): number {
    return Math.ceil(text.length * fontSize * 0.55);
  }

  /**
   * Converts a hex color string to an RGBA object for Sharp.
   * @param hex The hex color string (e.g., "#ffffff").
   * @param alpha The alpha transparency (0 to 1).
   * @returns An RGBA object.
   */
  private hexToRgba(hex: string, alpha: number = 1) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
      alpha
    } : { r: 0, g: 0, b: 0, alpha };
  }

  /**
   * Escapes special XML characters in a string to prevent SVG rendering errors.
   * @param text The text to escape.
   * @returns The escaped text.
   */
  private escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}