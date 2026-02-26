/**
 * EnvManager - Centralized credential management for ai-mem
 *
 * Provides isolated credential storage in ~/.claude/ai-mem-data/.env
 * for the Anthropic API key used by the observation extractor.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// Path to ai-mem's centralized .env file
const DATA_DIR = join(homedir(), '.claude', 'ai-mem-data');
export const ENV_FILE_PATH = join(DATA_DIR, '.env');

// Credential keys that ai-mem manages
export const MANAGED_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
];

export interface AiMemEnv {
  ANTHROPIC_API_KEY?: string;
}

/**
 * Parse a .env file content into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse KEY=value format
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Serialize key-value pairs to .env file format
 */
function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# ai-mem credentials',
    '# This file stores the Anthropic API key for ai-mem observation extraction',
    '# Edit this file or use ai-mem settings to configure',
    '',
  ];

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      // Quote values that contain spaces or special characters
      const needsQuotes = /[\s#=]/.test(value);
      lines.push(`${key}=${needsQuotes ? `"${value}"` : value}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Load credentials from ~/.claude/ai-mem-data/.env
 * Returns empty object if file doesn't exist
 */
export function loadAiMemEnv(): AiMemEnv {
  if (!existsSync(ENV_FILE_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(ENV_FILE_PATH, 'utf-8');
    const parsed = parseEnvFile(content);

    const result: AiMemEnv = {};
    if (parsed.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;

    return result;
  } catch (error) {
    logger.warn('ENV', 'Failed to load .env file', { path: ENV_FILE_PATH }, error as Error);
    return {};
  }
}

/**
 * Save credentials to ~/.claude/ai-mem-data/.env
 */
export function saveAiMemEnv(env: AiMemEnv): void {
  try {
    // Ensure directory exists
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }

    // Load existing to preserve any extra keys
    const existing = existsSync(ENV_FILE_PATH)
      ? parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf-8'))
      : {};

    // Update with new values
    const updated: Record<string, string> = { ...existing };

    if (env.ANTHROPIC_API_KEY !== undefined) {
      if (env.ANTHROPIC_API_KEY) {
        updated.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      } else {
        delete updated.ANTHROPIC_API_KEY;
      }
    }

    writeFileSync(ENV_FILE_PATH, serializeEnvFile(updated), 'utf-8');
  } catch (error) {
    logger.error('ENV', 'Failed to save .env file', { path: ENV_FILE_PATH }, error as Error);
    throw error;
  }
}

/**
 * Get a specific credential from ai-mem's .env
 * Returns undefined if not set
 */
export function getCredential(key: keyof AiMemEnv): string | undefined {
  const env = loadAiMemEnv();
  return env[key];
}

/**
 * Set a specific credential in ai-mem's .env
 * Pass empty string to remove the credential
 */
export function setCredential(key: keyof AiMemEnv, value: string): void {
  const env = loadAiMemEnv();
  env[key] = value || undefined;
  saveAiMemEnv(env);
}

/**
 * Check if ai-mem has an Anthropic API key configured
 */
export function hasAnthropicApiKey(): boolean {
  const env = loadAiMemEnv();
  return !!env.ANTHROPIC_API_KEY;
}

/**
 * Get auth method description for logging
 */
export function getAuthMethodDescription(): string {
  if (hasAnthropicApiKey()) {
    return 'API key (from ~/.claude/ai-mem-data/.env)';
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return 'API key (from environment)';
  }
  return 'No API key configured';
}
