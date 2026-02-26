export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;   // 'claude-code' or 'raw'
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}
