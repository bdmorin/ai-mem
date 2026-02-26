/**
 * AnthropicClient - Raw HTTP client for Anthropic Messages API
 *
 * Replaces the Claude Agent SDK for observation extraction.
 * The observer doesn't use tools -- it's a stateless text-in/XML-out pipeline.
 * A fetch() call is all we need.
 */

import { loadAiMemEnv } from '../../shared/EnvManager.js';
import { logger } from '../../utils/logger.js';

export interface AnthropicClientConfig {
  model: string;
  apiKey?: string;       // Falls back to AI_MEM env -> ANTHROPIC_API_KEY env var
  baseUrl?: string;      // Falls back to https://api.anthropic.com
  maxTokens?: number;    // Default: 4096
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface SendMessagesRequest {
  system: string;
  messages: Message[];
}

export interface SendMessagesResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

/**
 * Resolve the Anthropic API key from settings, env, or error.
 *
 * Priority:
 * 1. Explicit apiKey passed to constructor
 * 2. AI_MEM_ANTHROPIC_API_KEY from ~/.claude/ai-mem-data/.env
 * 3. ANTHROPIC_API_KEY from environment
 * 4. Error with clear instructions
 */
function resolveApiKey(explicitKey?: string): string {
  if (explicitKey) return explicitKey;

  // Check ai-mem's managed credentials
  const aiMemEnv = loadAiMemEnv();
  if (aiMemEnv.ANTHROPIC_API_KEY) return aiMemEnv.ANTHROPIC_API_KEY;

  // Check ambient environment
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  throw new Error(
    'ai-mem requires an Anthropic API key for observation extraction.\n' +
    'Set ANTHROPIC_API_KEY in ~/.claude/ai-mem-data/.env\n' +
    'or export ANTHROPIC_API_KEY in your shell.'
  );
}

export class AnthropicClient {
  private model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config: AnthropicClientConfig) {
    this.model = config.model;
    this.apiKey = resolveApiKey(config.apiKey);
    this.baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    this.maxTokens = config.maxTokens || 4096;
  }

  async sendMessages(request: SendMessagesRequest): Promise<SendMessagesResponse> {
    const url = `${this.baseUrl}/v1/messages`;

    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: request.system,
      messages: request.messages,
    };

    logger.debug('API', 'Sending request to Anthropic', {
      model: this.model,
      messageCount: request.messages.length,
      systemLength: request.system.length,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
      const message = error?.error?.message || `API error: ${response.status}`;
      logger.error('API', 'Anthropic API error', {
        status: response.status,
        message,
      });
      throw new Error(message);
    }

    const data = await response.json() as any;

    const text = data.content
      ?.map((c: any) => c.text || '')
      .join('') || '';

    return {
      text,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      stopReason: data.stop_reason || 'unknown',
    };
  }
}
