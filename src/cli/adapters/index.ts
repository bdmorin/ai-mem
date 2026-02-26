import type { PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { rawAdapter } from './raw.js';

export function getPlatformAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'claude-code': return claudeCodeAdapter;
    case 'raw': return rawAdapter;
    // Codex CLI and other compatible platforms use the raw adapter (accepts both camelCase and snake_case fields)
    default: return rawAdapter;
  }
}

export { claudeCodeAdapter, rawAdapter };
