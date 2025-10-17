import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Defines the structure for a single font file's configuration.
 */
interface FontDefinition {
  family: string;
  filename: string;
  weight: string;
  style: string;
  path: string;
  loaded: boolean;
}

/**
 * Defines the metrics for a specific text style (e.g., server name, description).
 */
interface FontMetrics {
  family: string;
  size: number;
  weight: string;
  lineHeight: number;
  letterSpacing: number;
}

/**
 * A collection of all predefined font styles used in the info card.
 */
interface DiscordFontConfig {
  serverName: FontMetrics;
  description: FontMetrics;
  memberStats: FontMetrics;
  establishedDate: FontMetrics;
  traits: FontMetrics;
  logoInitials: FontMetrics;
}

/**
 * Manages the loading, validation, and application of custom fonts for image generation.
 * It ensures that fonts are available to Sharp without requiring system-level installation.
 */
export class FontManager {
  private fonts: Map<string, FontDefinition> = new Map();
  private initialized = false;
  
  private readonly FONT_DIR = '../../../fonts';
  private readonly __dirname = path.dirname(fileURLToPath(import.meta.url));

  /**
   * A manifest of all custom fonts the application should attempt to load.
   */
  private readonly FONT_DEFINITIONS: FontDefinition[] = [
    // ABC Ginto Normal (for server names, headers)
    {
      family: 'ABC Ginto Normal',
      filename: 'ABCGINTONORMAL-REGULAR-TRIAL.OTF',
      weight: 'normal',
      style: 'normal',
      path: '',
      loaded: false
    },
    {
      family: 'ABC Ginto Normal',
      filename: 'ABCGINTONORMAL-MEDIUM-TRIAL.OTF',
      weight: 'medium',
      style: 'normal',
      path: '',
      loaded: false
    },
    {
      family: 'ABC Ginto Normal',
      filename: 'ABCGINTONORMAL-BOLD-TRIAL.OTF',
      weight: 'bold',
      style: 'normal',
      path: '',
      loaded: false
    },
    
    // gg sans (for UI text, descriptions)
    {
      family: 'gg sans',
      filename: 'GG SANS.TTF',
      weight: 'normal',
      style: 'normal',
      path: '',
      loaded: false
    },
    {
      family: 'gg sans',
      filename: 'GG SANS MEDIUM.TTF',
      weight: 'medium',
      style: 'normal',
      path: '',
      loaded: false
    },
    {
      family: 'gg sans',
      filename: 'GG SANS BOLD.TTF',
      weight: 'bold',
      style: 'normal',
      path: '',
      loaded: false
    }
  ];

  /**
   * Predefined font metrics that mimic Discord's UI typography.
   */
  private readonly DISCORD_FONTS: DiscordFontConfig = {
    serverName: {
      family: 'ABC Ginto Normal',
      size: 32,
      weight: 'medium',
      lineHeight: 1.2,
      letterSpacing: -0.02
    },
    description: {
      family: 'gg sans',
      size: 15,
      weight: 'normal',
      lineHeight: 1.4,
      letterSpacing: 0
    },
    memberStats: {
      family: 'gg sans',
      size: 14,
      weight: 'bold',
      lineHeight: 1.2,
      letterSpacing: 0
    },
    establishedDate: {
      family: 'gg sans',
      size: 14,
      weight: 'bold',
      lineHeight: 1.2,
      letterSpacing: 0
    },
    traits: {
      family: 'gg sans',
      size: 14,
      weight: 'medium',
      lineHeight: 1.2,
      letterSpacing: 0
    },
    logoInitials: {
      family: 'ABC Ginto Normal',
      size: 24,
      weight: 'bold',
      lineHeight: 1,
      letterSpacing: 0
    }
  };

  /**
   * Initializes the font manager by locating and verifying all defined font files.
   * This method should be called once at application startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    console.log('🔤 Loading Discord fonts...');
    
    try {
      this.setupFontPaths();
      await this.loadAllFonts();
      
      this.initialized = true;
      console.log(`✅ Loaded ${this.getLoadedCount()} Discord fonts`);
    } catch (error) {
      console.error('❌ Font initialization failed:', error);
      throw error;
    }
  }

  /**
   * Constructs the absolute file paths for each font in the manifest.
   */
  private setupFontPaths(): void {
    const fontDir = path.resolve(this.__dirname, this.FONT_DIR);
    
    for (const fontDef of this.FONT_DEFINITIONS) {
      fontDef.path = path.join(fontDir, fontDef.filename);
      const fontKey = this.createFontKey(fontDef.family, fontDef.weight);
      this.fonts.set(fontKey, fontDef);
    }
  }

  /**
   * Asynchronously loads all configured fonts by checking for their existence.
   */
  private async loadAllFonts(): Promise<void> {
    const loadPromises = this.FONT_DEFINITIONS.map(font => this.loadFont(font));
    await Promise.allSettled(loadPromises);
    
    // After attempting to load all fonts, check if critical ones are missing.
    const criticalFonts = [
      'ABC Ginto Normal:medium',
      'gg sans:normal',
      'gg sans:bold'
    ];
    
    const missingCritical = criticalFonts.filter(key => !this.fonts.get(key)?.loaded);
    
    if (missingCritical.length > 0) {
      console.warn(`⚠️ Missing critical fonts, card generation may be affected: ${missingCritical.join(', ')}`);
    }
  }

  /**
   * Loads an individual font file by checking if it's accessible on the filesystem.
   * @param fontDef The definition of the font to load.
   */
  private async loadFont(fontDef: FontDefinition): Promise<void> {
    try {
      await fs.access(fontDef.path);
      fontDef.loaded = true;
      console.log(`  - Loaded: ${fontDef.family} ${fontDef.weight}`);
    } catch (error) {
      console.warn(`  - Failed to load: ${fontDef.filename}`);
      fontDef.loaded = false;
    }
  }

  /**
   * Retrieves the predefined font metrics for a specific UI element.
   * @param purpose The UI element (e.g., 'serverName', 'description').
   * @returns The corresponding font metrics.
   */
  getDiscordFont(purpose: keyof DiscordFontConfig): FontMetrics {
    return { ...this.DISCORD_FONTS[purpose] };
  }

  /**
   * Generates a `font-family` string with appropriate fallbacks for use in SVGs.
   * @param family The primary font family name.
   * @returns A CSS-compatible `font-family` string.
   */
  getFontFamily(family: string): string {
    const fallbacks: Record<string, string[]> = {
      'ABC Ginto Normal': ['Helvetica Neue', 'Arial', 'sans-serif'],
      'gg sans': ['Inter', 'Roboto', 'Helvetica', 'Arial', 'sans-serif']
    };
    
    const fontList = [family, ...(fallbacks[family] || ['Arial', 'sans-serif'])];
    return fontList.map(f => f.includes(' ') ? `"${f}"` : f).join(', ');
  }

  /**
   * Checks if a specific font family and weight has been successfully loaded.
   * @param family The font family.
   * @param weight The font weight (e.g., 'normal', 'bold').
   * @returns `true` if the font is available, otherwise `false`.
   */
  isFontLoaded(family: string, weight: string = 'normal'): boolean {
    const fontKey = this.createFontKey(family, weight);
    const font = this.fonts.get(fontKey);
    return font?.loaded || false;
  }

  /**
   * Finds the best available font weight if the desired one is not loaded.
   * @param family The font family.
   * @param desiredWeight The preferred font weight.
   * @returns The best available font weight string.
   */
  getBestFontWeight(family: string, desiredWeight: string): string {
    if (this.isFontLoaded(family, desiredWeight)) {
      return desiredWeight;
    }
    
    // If the desired weight is unavailable, try common fallbacks.
    const fallbackWeights = ['medium', 'normal', 'bold'];
    for (const weight of fallbackWeights) {
      if (this.isFontLoaded(family, weight)) {
        console.warn(`Using fallback weight '${weight}' for '${family}' (desired: '${desiredWeight}')`);
        return weight;
      }
    }
    
    return 'normal'; // Ultimate fallback
  }

  /**
   * Creates a unique key for the font map from its family and weight.
   * @param family The font family.
   * @param weight The font weight.
   * @returns A unique string key.
   */
  private createFontKey(family: string, weight: string): string {
    return `${family}:${weight}`;
  }

  /**
   * Returns the number of fonts that were successfully loaded.
   * @returns The count of loaded fonts.
   */
  private getLoadedCount(): number {
    return Array.from(this.fonts.values()).filter(f => f.loaded).length;
  }

  /**
   * Checks if the font manager has been initialized.
   * @returns `true` if initialized, otherwise `false`.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * A singleton instance of the FontManager for global use.
 */
export const fontManager = new FontManager();

/**
 * Initializes the global font manager. This should be called once at application startup
 * to make fonts available for image generation.
 */
export async function preloadFonts(): Promise<void> {
  await fontManager.initialize();
}

export { type FontDefinition, type FontMetrics, type DiscordFontConfig };