/**
 * SettingsDefaultsManager
 *
 * Single source of truth for all default configuration values.
 * Provides methods to get defaults with optional environment variable overrides.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { DEFAULT_OBSERVATION_TYPES_STRING, DEFAULT_OBSERVATION_CONCEPTS_STRING } from '../constants/observation-metadata.js';
// NOTE: Do NOT import logger here - it creates a circular dependency
// logger.ts depends on SettingsDefaultsManager for its initialization

export interface SettingsDefaults {
  AI_MEM_MODEL: string;
  AI_MEM_CONTEXT_OBSERVATIONS: string;
  AI_MEM_WORKER_PORT: string;
  AI_MEM_WORKER_HOST: string;
  AI_MEM_SKIP_TOOLS: string;
  // AI Provider Configuration
  AI_MEM_ANTHROPIC_API_KEY: string;  // Anthropic API key for observation extraction
  AI_MEM_PROVIDER: string;  // 'claude' | 'gemini' | 'openrouter'
  AI_MEM_CLAUDE_AUTH_METHOD: string;  // 'cli' | 'api' - how Claude provider authenticates
  AI_MEM_GEMINI_API_KEY: string;
  AI_MEM_GEMINI_MODEL: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash-preview'
  AI_MEM_GEMINI_RATE_LIMITING_ENABLED: string;  // 'true' | 'false' - enable rate limiting for free tier
  AI_MEM_OPENROUTER_API_KEY: string;
  AI_MEM_OPENROUTER_MODEL: string;
  AI_MEM_OPENROUTER_SITE_URL: string;
  AI_MEM_OPENROUTER_APP_NAME: string;
  AI_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: string;
  AI_MEM_OPENROUTER_MAX_TOKENS: string;
  // System Configuration
  AI_MEM_DATA_DIR: string;
  AI_MEM_LOG_LEVEL: string;
  AI_MEM_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  AI_MEM_MODE: string;
  // Token Economics
  AI_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  AI_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  // Observation Filtering
  AI_MEM_CONTEXT_OBSERVATION_TYPES: string;
  AI_MEM_CONTEXT_OBSERVATION_CONCEPTS: string;
  // Display Configuration
  AI_MEM_CONTEXT_FULL_COUNT: string;
  AI_MEM_CONTEXT_FULL_FIELD: string;
  AI_MEM_CONTEXT_SESSION_COUNT: string;
  // Feature Toggles
  AI_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  AI_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  AI_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  AI_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  // Process Management
  AI_MEM_MAX_CONCURRENT_AGENTS: string;  // Max concurrent agent subprocesses (default: 2)
  // Exclusion Settings
  AI_MEM_EXCLUDED_PROJECTS: string;  // Comma-separated glob patterns for excluded project paths
  AI_MEM_FOLDER_MD_EXCLUDE: string;  // JSON array of folder paths to exclude from CLAUDE.md generation
  // Chroma Vector Database Configuration
  AI_MEM_CHROMA_ENABLED: string;   // 'true' | 'false' - set to 'false' for SQLite-only mode
  AI_MEM_CHROMA_MODE: string;      // 'local' | 'remote'
  AI_MEM_CHROMA_HOST: string;
  AI_MEM_CHROMA_PORT: string;
  AI_MEM_CHROMA_SSL: string;
  // Future cloud support
  AI_MEM_CHROMA_API_KEY: string;
  AI_MEM_CHROMA_TENANT: string;
  AI_MEM_CHROMA_DATABASE: string;
}

export class SettingsDefaultsManager {
  /**
   * Default values for all settings
   */
  private static readonly DEFAULTS: SettingsDefaults = {
    AI_MEM_MODEL: 'claude-sonnet-4-5',
    AI_MEM_CONTEXT_OBSERVATIONS: '50',
    AI_MEM_WORKER_PORT: '37777',
    AI_MEM_WORKER_HOST: '127.0.0.1',
    AI_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    // AI Provider Configuration
    AI_MEM_ANTHROPIC_API_KEY: '',  // Empty by default, checked in settings then env
    AI_MEM_PROVIDER: 'claude',  // Default to Claude
    AI_MEM_CLAUDE_AUTH_METHOD: 'cli',  // Default to CLI subscription billing (not API key)
    AI_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    AI_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',  // Default Gemini model (highest free tier RPM)
    AI_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    AI_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    AI_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',  // Default OpenRouter model (free tier)
    AI_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    AI_MEM_OPENROUTER_APP_NAME: 'ai-mem',  // App name for OpenRouter analytics
    AI_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',  // Max messages in context window
    AI_MEM_OPENROUTER_MAX_TOKENS: '100000',  // Max estimated tokens (~100k safety limit)
    // System Configuration
    AI_MEM_DATA_DIR: join(homedir(), '.claude', 'ai-mem-data'),
    AI_MEM_LOG_LEVEL: 'INFO',
    AI_MEM_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    AI_MEM_MODE: 'code', // Default mode profile
    // Token Economics
    AI_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    AI_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    // Observation Filtering
    AI_MEM_CONTEXT_OBSERVATION_TYPES: DEFAULT_OBSERVATION_TYPES_STRING,
    AI_MEM_CONTEXT_OBSERVATION_CONCEPTS: DEFAULT_OBSERVATION_CONCEPTS_STRING,
    // Display Configuration
    AI_MEM_CONTEXT_FULL_COUNT: '0',
    AI_MEM_CONTEXT_FULL_FIELD: 'narrative',
    AI_MEM_CONTEXT_SESSION_COUNT: '10',
    // Feature Toggles
    AI_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    AI_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    AI_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    AI_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    // Process Management
    AI_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent agent subprocesses
    // Exclusion Settings
    AI_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    AI_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    // Chroma Vector Database Configuration
    AI_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable Chroma and use SQLite-only search
    AI_MEM_CHROMA_MODE: 'local',           // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    AI_MEM_CHROMA_HOST: '127.0.0.1',
    AI_MEM_CHROMA_PORT: '8000',
    AI_MEM_CHROMA_SSL: 'false',
    // Future cloud support
    AI_MEM_CHROMA_API_KEY: '',
    AI_MEM_CHROMA_TENANT: 'default_tenant',
    AI_MEM_CHROMA_DATABASE: 'default_database',
  };

  /**
   * Get all defaults as an object
   */
  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  /**
   * Get a default value from defaults (no environment variable override)
   */
  static get(key: keyof SettingsDefaults): string {
    return this.DEFAULTS[key];
  }

  /**
   * Get an integer default value
   */
  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  /**
   * Get a boolean default value
   * Handles both string 'true' and boolean true from JSON
   */
  static getBool(key: keyof SettingsDefaults): boolean {
    const value = this.get(key);
    return value === 'true' || value === true;
  }

  /**
   * Apply environment variable overrides to settings
   * Environment variables take highest priority over file and defaults
   */
  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  /**
   * Load settings from file with fallback to defaults
   * Returns merged settings with proper priority: process.env > settings file > defaults
   * Handles all errors (missing file, corrupted JSON, permissions) gracefully
   *
   * Configuration Priority:
   *   1. Environment variables (highest priority)
   *   2. Settings file (~/.claude/ai-mem-data/settings.json)
   *   3. Default values (lowest priority)
   */
  static loadFromFile(settingsPath: string): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          const dir = dirname(settingsPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          // Use console instead of logger to avoid circular dependency
          console.log('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error);
        }
        // Still apply env var overrides even when file doesn't exist
        return this.applyEnvOverrides(defaults);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);

      // MIGRATION: Handle old nested schema { env: {...} }
      let flatSettings = settings;
      if (settings.env && typeof settings.env === 'object') {
        // Migrate from nested to flat schema
        flatSettings = settings.env;

        // Auto-migrate the file to flat schema
        try {
          writeFileSync(settingsPath, JSON.stringify(flatSettings, null, 2), 'utf-8');
          console.log('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
        } catch (error) {
          console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error);
          // Continue with in-memory migration even if write fails
        }
      }

      // Merge file settings with defaults (flat schema)
      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      // Apply environment variable overrides (highest priority)
      return this.applyEnvOverrides(result);
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error);
      // Still apply env var overrides even on error
      return this.applyEnvOverrides(this.getAllDefaults());
    }
  }
}
