# ai-mem Rewrite: From claude-mem Fork to Owned Project

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebrand and rewrite the claude-mem fork into ai-mem — a leaner, bun-native memory plugin for Claude Code that uses raw Anthropic API calls instead of the Claude Agent SDK.

**Architecture:** Session-scoped bun-native worker on port 37777. Hooks are thin HTTP POST clients. Worker receives observations, extracts structured data via raw `/v1/messages` calls, stores in SQLite + Chroma. Context injected on session start via hybrid search. Web UI kept as-is. New CLI query interface.

**Tech Stack:** Bun (runtime + sqlite + test), TypeScript, Express, Anthropic REST API, MCP SDK, React (existing UI), esbuild

---

## Decisions Log

| Decision | Value |
|----------|-------|
| Env var prefix | `AI_MEM_*` |
| Data directory | `~/.claude/ai-mem-data` |
| Database file | `ai-mem.db` |
| Version | `1.0.0` |
| Author | Brian Morin (forked from claude-mem by Alex Newman) |
| License | AGPL-3.0 (preserved from upstream) |
| GitHub | `bdmorin/ai-mem` |
| Worker port | `37777` (unchanged) |
| Plugin name | `ai-mem` |

---

## Phase 1: Identity & Foundation

Mechanical rebrand. No logic changes. Every file compiles and tests pass after this phase.

### Task 1.1: Package Identity

**Files:**
- Modify: `package.json`
- Modify: `plugin/.claude-plugin/plugin.json`
- Modify: `plugin/package.json` (if exists)
- Modify: `plugin/.mcp.json`

**Step 1: Update root package.json**

```json
{
  "name": "ai-mem",
  "version": "1.0.0",
  "description": "Persistent memory system for Claude Code - preserve context across sessions",
  "author": "Brian Morin",
  "license": "AGPL-3.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/bdmorin/ai-mem.git"
  },
  "homepage": "https://github.com/bdmorin/ai-mem#readme",
  "bugs": {
    "url": "https://github.com/bdmorin/ai-mem/issues"
  }
}
```

Remove from keywords: `"claude"`, `"claude-code"`, `"claude-agent-sdk"`.
Keep: `"mcp"`, `"plugin"`, `"memory"`, `"compression"`, `"typescript"`.

**Step 2: Update plugin manifest**

```json
{
  "name": "ai-mem",
  "version": "1.0.0",
  "description": "Persistent memory system for Claude Code",
  "author": { "name": "Brian Morin" },
  "repository": "https://github.com/bdmorin/ai-mem",
  "license": "AGPL-3.0"
}
```

**Step 3: Update npm scripts paths**

In `package.json` scripts, replace:
- `~/.claude-mem/` → `~/.claude/ai-mem-data/`
- `thedotmack` → `bdmorin`

**Step 4: Run `bun test` to verify nothing broke**

**Step 5: Commit**

```bash
git add package.json plugin/.claude-plugin/plugin.json plugin/package.json plugin/.mcp.json
git commit -m "rebrand: update package identity from claude-mem to ai-mem"
```

---

### Task 1.2: Environment Variables & Settings

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/shared/EnvManager.ts`
- Modify: `src/shared/paths.ts`

**Step 1: Rename all env vars in SettingsDefaultsManager**

Global find-replace in `src/shared/SettingsDefaultsManager.ts`:
- `CLAUDE_MEM_` → `AI_MEM_` (all interface keys, defaults, comments)

Keep `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PATH` as-is — those are Claude Code's own env vars, not ours.

**Step 2: Update SettingsDefaults interface**

Every key changes: `CLAUDE_MEM_MODEL` → `AI_MEM_MODEL`, etc.

**Step 3: Update DATA_DIR default**

```typescript
AI_MEM_DATA_DIR: join(homedir(), '.claude', 'ai-mem-data'),
```

**Step 4: Update EnvManager.ts**

- Change `DATA_DIR` from `join(homedir(), '.claude-mem')` to `join(homedir(), '.claude', 'ai-mem-data')`
- Rename `loadClaudeMemEnv` → `loadAiMemEnv`
- Rename `saveClaudeMemEnv` → `saveAiMemEnv`
- Rename `ClaudeMemEnv` interface → `AiMemEnv`
- Update all comment references
- Update ENV_FILE_PATH to new data dir
- Update serialized header comments in `.env` file

**Step 5: Update paths.ts**

- `DB_PATH`: `join(DATA_DIR, 'ai-mem.db')`
- `MARKETPLACE_ROOT`: `join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'bdmorin')`
- Remove `OBSERVER_SESSIONS_DIR` (SDK sessions dir — we won't need it after Phase 3)
- Update all `claude-mem` references in comments

**Step 6: Grep for any remaining `CLAUDE_MEM_` references in src/**

```bash
grep -r "CLAUDE_MEM_" src/ --include="*.ts" -l
```

Fix every hit. The only `CLAUDE_` references allowed are `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PATH`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_PLUGIN_ROOT` — these belong to Claude Code itself.

**Step 7: Run `bun test` to verify**

**Step 8: Commit**

```bash
git add -A src/shared/
git commit -m "rebrand: rename CLAUDE_MEM_* env vars to AI_MEM_*"
```

---

### Task 1.3: Codebase-Wide String Replacement

**Files:** All `.ts`, `.tsx`, `.js`, `.cjs`, `.json`, `.sh` files

**Step 1: Automated replacements (in order)**

These are safe global replacements. Run each and verify:

| Find | Replace | Scope |
|------|---------|-------|
| `claude-mem` (lowercase hyphenated) | `ai-mem` | All source files |
| `claude_mem` (lowercase underscore) | `ai_mem` | All source files |
| `ClaudeMem` (PascalCase) | `AiMem` | All source files |
| `claudeMem` (camelCase) | `aiMem` | All source files |
| `CLAUDE_MEM` (SCREAMING_SNAKE) | `AI_MEM` | All source files (done in 1.2 but catch stragglers) |
| `thedotmack` | `bdmorin` | All source files |

**Step 2: Manual review for false positives**

Grep for remaining `claude` (case-insensitive) references. Keep references to:
- `Claude Code` (the Anthropic product)
- `claude-code` (the CLI tool name)
- `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*` (Claude Code's own env vars)
- `CLAUDE_PLUGIN_ROOT` (Claude Code plugin system)
- `@anthropic-ai/claude-agent-sdk` (removed in Phase 3, leave for now)
- `claude-sonnet-4-5`, `claude-opus-4-6` (model names)

**Step 3: Update database filename references**

```bash
grep -r "claude-mem.db" . --include="*.ts" --include="*.js" --include="*.cjs" -l
```

Replace `claude-mem.db` → `ai-mem.db` everywhere.

**Step 4: Run `bun test`**

**Step 5: Commit**

```bash
git add -A
git commit -m "rebrand: complete codebase string replacement claude-mem → ai-mem"
```

---

### Task 1.4: Hooks Configuration

**Files:**
- Modify: `plugin/hooks/hooks.json`

**Step 1: Replace thedotmack fallback paths**

Every hook command has:
```bash
_R="${CLAUDE_PLUGIN_ROOT}"; [ -z "$_R" ] && _R="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"
```

Change fallback to:
```bash
_R="${CLAUDE_PLUGIN_ROOT}"; [ -z "$_R" ] && _R="$HOME/.claude/plugins/marketplaces/bdmorin/plugin"
```

**Step 2: Remove smart-install hook entirely**

Delete the first SessionStart matcher entry that runs `smart-install.js`. Engineers have their tools installed.

**Step 3: Replace bun-runner indirection**

Change every command from:
```bash
node "$_R/scripts/bun-runner.js" "$_R/scripts/worker-service.cjs" ...
```
To:
```bash
bun "$_R/scripts/worker-service.cjs" ...
```

Bun is a prerequisite, not a runtime discovery.

**Step 4: Update description**

```json
"description": "ai-mem memory system hooks"
```

**Step 5: Run `bun test`**

**Step 6: Commit**

```bash
git add plugin/hooks/hooks.json
git commit -m "rebrand: update hooks config, remove nanny functions"
```

---

### Task 1.5: Skills & Documentation

**Files:**
- Modify: `plugin/skills/mem-search/SKILL.md`
- Modify: `plugin/skills/make-plan/SKILL.md`
- Modify: `plugin/skills/do/SKILL.md`
- Modify: `CLAUDE.md` (project root)
- Modify: `README.md`

**Step 1: Update skill descriptions**

Replace `claude-mem` → `ai-mem` in all SKILL.md files. Update any `localhost:37777` references if needed (port stays the same).

**Step 2: Rewrite root CLAUDE.md**

Update for new project identity, paths, env vars. Remove references to upstream docs site, discord, etc.

**Step 3: Write new README.md**

Minimal README:
- Project name and description
- "Forked from [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman"
- "Built with Claude Code by Anthropic" (attribution)
- Installation (from source, not marketplace)
- Configuration (env vars, settings)
- Architecture overview (brief)
- License: AGPL-3.0

**Step 4: Commit**

```bash
git add plugin/skills/ CLAUDE.md README.md
git commit -m "rebrand: update skills, docs, and README for ai-mem"
```

---

### Task 1.6: Data Migration Script

**Files:**
- Create: `scripts/migrate-data.sh`

**Step 1: Write migration script**

```bash
#!/usr/bin/env bash
set -e

OLD_DIR="$HOME/.claude-mem"
NEW_DIR="$HOME/.claude/ai-mem-data"

if [ ! -d "$OLD_DIR" ]; then
  echo "No existing data at $OLD_DIR. Nothing to migrate."
  exit 0
fi

if [ -d "$NEW_DIR" ]; then
  echo "Target directory $NEW_DIR already exists. Aborting."
  exit 1
fi

echo "Migrating data from $OLD_DIR to $NEW_DIR..."
mkdir -p "$(dirname "$NEW_DIR")"
cp -R "$OLD_DIR" "$NEW_DIR"

# Rename database file
if [ -f "$NEW_DIR/claude-mem.db" ]; then
  mv "$NEW_DIR/claude-mem.db" "$NEW_DIR/ai-mem.db"
  # Handle WAL and SHM files
  [ -f "$NEW_DIR/claude-mem.db-wal" ] && mv "$NEW_DIR/claude-mem.db-wal" "$NEW_DIR/ai-mem.db-wal"
  [ -f "$NEW_DIR/claude-mem.db-shm" ] && mv "$NEW_DIR/claude-mem.db-shm" "$NEW_DIR/ai-mem.db-shm"
fi

echo "Migration complete. Old data preserved at $OLD_DIR."
echo "After verifying, you can remove it: rm -rf $OLD_DIR"
```

**Step 2: Make executable**

```bash
chmod +x scripts/migrate-data.sh
```

**Step 3: Commit**

```bash
git add scripts/migrate-data.sh
git commit -m "feat: add data migration script from claude-mem to ai-mem"
```

---

## Phase 2: Cut Dead Weight

Remove code we don't need. Each deletion is a separate commit for easy reversal.

### Task 2.1: Delete Nanny Scripts

**Files:**
- Delete: `plugin/scripts/smart-install.js`
- Delete: `plugin/scripts/bun-runner.js`
- Delete: `plugin/scripts/setup.sh`

**Step 1: Delete the files**

**Step 2: Remove Setup hook from hooks.json**

Delete the entire `"Setup"` section from `plugin/hooks/hooks.json`.

**Step 3: Remove any imports or references to these files**

```bash
grep -r "smart-install\|bun-runner\|setup\.sh" . --include="*.ts" --include="*.js" --include="*.json" -l
```

**Step 4: Run `bun test`**

**Step 5: Commit**

```bash
git add -A
git commit -m "cut: remove nanny scripts (smart-install, bun-runner, setup.sh)"
```

---

### Task 2.2: Delete Cursor Integration

**Files:**
- Delete: `cursor-hooks/` (entire directory)
- Delete: `src/services/integrations/CursorHooksInstaller.ts`
- Modify: `package.json` (remove cursor:* scripts)
- Remove any cursor-related routes from worker

**Step 1: Delete cursor-hooks/ directory**

**Step 2: Delete CursorHooksInstaller.ts**

**Step 3: Remove cursor npm scripts from package.json**

Delete: `cursor:install`, `cursor:uninstall`, `cursor:status`, `cursor:setup`

**Step 4: Grep for remaining cursor references**

```bash
grep -r "cursor" src/ --include="*.ts" -l -i
```

Remove dead imports and references.

**Step 5: Run `bun test`**

**Step 6: Commit**

```bash
git add -A
git commit -m "cut: remove Cursor IDE integration"
```

---

### Task 2.3: Delete Upstream Baggage

**Files:**
- Delete: `scripts/translate-readme/` (entire directory)
- Delete: `scripts/discord-release-notify.js`
- Delete: `scripts/generate-changelog.js`
- Delete: `scripts/publish.js`
- Delete: `scripts/sync-marketplace.cjs`
- Delete: `scripts/build-worker-binary.js`
- Delete: `docs/i18n/` (entire directory)
- Delete: `docs/reports/` (entire directory)
- Delete: `docs/PR-SHIPPING-REPORT.md`
- Delete: `docs/VERSION_FIX.md`
- Delete: `docs/anti-pattern-cleanup-plan.md`
- Delete: `docs/SESSION_ID_ARCHITECTURE.md`
- Delete: `CHANGELOG.md`
- Delete: `conductor.json`
- Delete: `.translation-cache.json`
- Delete: `plugin/modes/` (all except `code.json` — we only need one mode)
- Delete: `ragtime/` (entire directory, if present)
- Delete: `openclaw/` (entire directory, if present)
- Delete: `installer/` (entire directory)
- Delete: `install/` (entire directory)

**Step 1: Delete all listed files and directories**

**Step 2: Remove corresponding npm scripts**

Delete from package.json:
- `translate-readme`, `translate:tier*`, `translate:all`
- `changelog:generate`
- `discord:notify`
- `sync-marketplace`, `sync-marketplace:force`
- `build:binaries`
- `build-and-sync` (rewrite to just `build`)
- `release`, `release:patch`, `release:minor`, `release:major`
- `claude-md:regenerate`, `claude-md:dry-run`

**Step 3: Remove `np` devDependency and config from package.json**

**Step 4: Update build script if it referenced sync-marketplace**

**Step 5: Grep for dead imports**

```bash
grep -r "sync-marketplace\|discord-release\|generate-changelog\|translate-readme" . --include="*.ts" --include="*.js" --include="*.json" -l
```

**Step 6: Run `bun test`**

**Step 7: Commit**

```bash
git add -A
git commit -m "cut: remove upstream baggage (translations, changelog, discord, release tooling, extra modes)"
```

---

### Task 2.4: Simplify Mode System

**Files:**
- Modify: `src/services/domain/ModeManager.ts`
- Keep: `plugin/modes/code.json` (the only mode we need)
- Delete: All other mode JSON files

**Step 1: Verify code.json has all required prompt fields**

Read `plugin/modes/code.json` — ensure it has `system_identity`, `observer_role`, `recording_focus`, `skip_guidance`, `output_format_header`, `format_examples`, `footer`, `summary_instruction`, etc.

**Step 2: Simplify ModeManager to hardcode `code` mode**

Or keep mode loading but only ship the one mode file. Less invasive.

**Step 3: Run `bun test`**

**Step 4: Commit**

```bash
git add -A
git commit -m "cut: simplify to single 'code' mode, remove 40+ unused modes"
```

---

## Phase 3: Replace SDK Agent with Raw API

The core architectural change. The current SDKAgent spawns a Claude Code subprocess, feeds it observation messages, and parses XML responses. We replace this with a direct `fetch()` to the Anthropic `/v1/messages` API.

### Task 3.1: Create AnthropicClient

**Files:**
- Create: `src/services/api/AnthropicClient.ts`
- Test: `tests/api/AnthropicClient.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { AnthropicClient } from '../../src/services/api/AnthropicClient';

describe('AnthropicClient', () => {
  test('sends messages and returns parsed response', async () => {
    // Mock global fetch
    const mockFetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '<observation><type>discovery</type><title>Test</title></observation>' }]
      })
    }));
    globalThis.fetch = mockFetch;

    const client = new AnthropicClient({ model: 'claude-sonnet-4-5' });
    const response = await client.sendMessages({
      system: 'You are an observer.',
      messages: [{ role: 'user', content: 'Observe this.' }]
    });

    expect(response.text).toContain('<observation>');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.method).toBe('POST');
  });

  test('throws on API error', async () => {
    globalThis.fetch = mock(() => Promise.resolve({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { message: 'Rate limited' } })
    }));

    const client = new AnthropicClient({ model: 'claude-sonnet-4-5' });
    await expect(client.sendMessages({
      system: 'test',
      messages: [{ role: 'user', content: 'test' }]
    })).rejects.toThrow('Rate limited');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/api/AnthropicClient.test.ts
```

Expected: FAIL (module doesn't exist)

**Step 3: Write AnthropicClient implementation**

```typescript
/**
 * AnthropicClient - Raw HTTP client for Anthropic Messages API
 *
 * Replaces the Claude Agent SDK for observation extraction.
 * The observer doesn't use tools — it's a stateless text-in/XML-out pipeline.
 * A fetch() call is all we need.
 */

export interface AnthropicClientConfig {
  model: string;
  apiKey?: string;       // Falls back to ANTHROPIC_API_KEY env var
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

export class AnthropicClient {
  private config: Required<AnthropicClientConfig>;

  constructor(config: AnthropicClientConfig) {
    this.config = {
      model: config.model,
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || '',
      baseUrl: config.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      maxTokens: config.maxTokens || 4096,
    };
  }

  async sendMessages(request: SendMessagesRequest): Promise<SendMessagesResponse> {
    const url = `${this.config.baseUrl}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: request.system,
        messages: request.messages,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      text: data.content.map((c: any) => c.text || '').join(''),
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      stopReason: data.stop_reason || 'unknown',
    };
  }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/api/AnthropicClient.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/api/AnthropicClient.ts tests/api/AnthropicClient.test.ts
git commit -m "feat: add AnthropicClient for raw API observation extraction"
```

---

### Task 3.2: Create ObservationExtractor

**Files:**
- Create: `src/services/api/ObservationExtractor.ts`
- Test: `tests/api/ObservationExtractor.test.ts`

This replaces the SDKAgent's message loop. It takes raw tool observations, sends them to the API with the observer system prompt, and returns parsed observations.

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { ObservationExtractor } from '../../src/services/api/ObservationExtractor';

describe('ObservationExtractor', () => {
  test('extracts observation from tool use', async () => {
    // Mock AnthropicClient
    const mockClient = {
      sendMessages: mock(() => Promise.resolve({
        text: `<observation>
          <type>discovery</type>
          <title>Auth pattern found</title>
          <subtitle>JWT validation</subtitle>
          <facts><fact>Uses RS256</fact></facts>
          <narrative>Found JWT auth pattern in middleware.</narrative>
          <concepts><concept>authentication</concept></concepts>
          <files_read><file>src/auth.ts</file></files_read>
          <files_modified></files_modified>
        </observation>`,
        inputTokens: 500,
        outputTokens: 100,
        stopReason: 'end_turn',
      }))
    };

    const extractor = new ObservationExtractor(mockClient as any);
    const result = await extractor.extract({
      toolName: 'Read',
      toolInput: { file_path: 'src/auth.ts' },
      toolOutput: 'export function validateJWT...',
      cwd: '/project',
      userPrompt: 'Fix the auth bug',
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('discovery');
    expect(result.observations[0].title).toBe('Auth pattern found');
  });

  test('returns empty array for skippable tools', async () => {
    const mockClient = { sendMessages: mock() };
    const extractor = new ObservationExtractor(mockClient as any);

    const result = await extractor.extract({
      toolName: 'TodoWrite',
      toolInput: {},
      toolOutput: '',
      cwd: '/project',
      userPrompt: 'test',
    });

    expect(result.observations).toHaveLength(0);
    expect(mockClient.sendMessages).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write ObservationExtractor implementation**

Uses the existing system prompt from `plugin/modes/code.json`, the existing XML parser from `src/sdk/parser.ts`, and the new AnthropicClient.

Key design: Maintains a conversation history per session (array of messages). Each new tool observation appends a user message. The API call includes the full history for context. On session end, a summary request is appended.

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add src/services/api/ObservationExtractor.ts tests/api/ObservationExtractor.test.ts
git commit -m "feat: add ObservationExtractor using raw API calls"
```

---

### Task 3.3: Wire ObservationExtractor into Worker

**Files:**
- Modify: `src/services/worker/agents/SDKAgent.ts` → Replace internals
- Modify: `src/services/worker-service.ts` → Use new client
- Modify: `src/services/worker/SessionManager.ts` → Simplify session tracking

**Step 1: Replace SDKAgent internals**

The SDKAgent currently spawns a Claude Code subprocess. Replace the body of `startSession()` and `processObservation()` to use ObservationExtractor instead.

Alternatively, create a new `ApiAgent.ts` that implements the same interface, and swap it in WorkerService initialization. This is less invasive.

**Step 2: Remove subprocess spawning code**

Delete `buildIsolatedEnv()` usage, `spawnClaudeCodeProcess`, PID tracking for observer subprocesses.

**Step 3: Simplify session ID management**

No more two-phase `contentSessionId → memorySessionId` handoff. The session ID is just the `contentSessionId` from Claude Code. Store it directly.

**Step 4: Run full test suite**

```bash
bun test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: replace SDK subprocess agent with raw API ObservationExtractor"
```

---

### Task 3.4: Remove Claude Agent SDK Dependency

**Files:**
- Modify: `package.json` → Remove `@anthropic-ai/claude-agent-sdk`
- Delete: `src/sdk/` directory (prompts moved to ObservationExtractor, parser kept or relocated)
- Modify: `src/shared/EnvManager.ts` → Remove `buildIsolatedEnv()`, `BLOCKED_ENV_VARS`
- Delete: GeminiAgent, OpenRouterAgent (simplify to single provider initially)

**Step 1: Keep parser.ts**

Move `src/sdk/parser.ts` → `src/services/api/parser.ts`. It's pure XML parsing, no SDK dependency.

**Step 2: Move prompt templates**

The observer system prompt currently lives in `plugin/modes/code.json`. That's fine — ObservationExtractor reads it at init.

`src/sdk/prompts.ts` has builders like `buildInitPrompt()`, `buildObservationPrompt()`. Move the useful parts into ObservationExtractor, delete the rest.

**Step 3: Remove SDK from package.json**

```bash
npm uninstall @anthropic-ai/claude-agent-sdk
```

**Step 4: Delete src/sdk/ directory**

**Step 5: Delete GeminiAgent.ts, OpenRouterAgent.ts**

We can add multi-provider support later. For now, one provider (Anthropic), one client.

**Step 6: Clean up EnvManager.ts**

Remove `buildIsolatedEnv()` — no more subprocess environment isolation needed.
Remove `BLOCKED_ENV_VARS` — no more SDK auto-discovery concern.
Keep credential management (API key storage in data dir).

**Step 7: Grep for any remaining SDK imports**

```bash
grep -r "claude-agent-sdk\|@anthropic-ai" src/ --include="*.ts" -l
```

Fix every hit.

**Step 8: Run `bun test`**

**Step 9: Commit**

```bash
git add -A
git commit -m "cut: remove Claude Agent SDK dependency, consolidate to raw API"
```

---

### Task 3.5: Authentication Strategy

**Files:**
- Modify: `src/services/api/AnthropicClient.ts`
- Modify: `src/shared/EnvManager.ts`

**Step 1: Define auth priority**

The observer needs an API key. Priority:
1. `AI_MEM_ANTHROPIC_API_KEY` (explicit config in settings)
2. `ANTHROPIC_API_KEY` (ambient environment)
3. Fail with clear error message

Note: Claude Code CLI subscription billing (`ANTHROPIC_AUTH_TOKEN`) won't work for raw API calls — that token is for the Claude Code process, not third-party API access. Users need their own API key for the observer.

**Step 2: Update AnthropicClient to check both sources**

**Step 3: Add helpful error message when no key found**

```
ai-mem requires an Anthropic API key for observation extraction.
Set AI_MEM_ANTHROPIC_API_KEY in ~/.claude/ai-mem-data/settings.json
or export ANTHROPIC_API_KEY in your shell.
```

**Step 4: Run `bun test`**

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement API key resolution for raw Anthropic calls"
```

---

## Phase 4: CLI Query Interface

Add a CLI tool that queries the worker's existing HTTP endpoints. The web UI already works; this just exposes the same data to the terminal.

### Task 4.1: Create CLI Entry Point

**Files:**
- Create: `src/cli/aim.ts`
- Test: `tests/cli/aim.test.ts`

**Step 1: Write failing test for search command**

```typescript
import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../../src/cli/aim';

describe('CLI arg parsing', () => {
  test('parses search command', () => {
    const result = parseArgs(['search', 'auth patterns']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth patterns');
  });

  test('parses timeline command with flags', () => {
    const result = parseArgs(['timeline', '--last', '7d']);
    expect(result.command).toBe('timeline');
    expect(result.last).toBe('7d');
  });

  test('parses status command', () => {
    const result = parseArgs(['status']);
    expect(result.command).toBe('status');
  });
});
```

**Step 2: Implement arg parser and command dispatch**

Commands:
- `aim search <query>` — hybrid search observations
- `aim timeline [--last 7d] [--project name]` — recent activity timeline
- `aim status` — worker health, DB stats, session count
- `aim observe` — show live observation stream (SSE client)

Each command: HTTP GET/POST to `localhost:37777/api/*`, format response for terminal.

**Step 3: Add bin entry to package.json**

```json
"bin": {
  "aim": "./dist/cli/aim.js"
}
```

**Step 4: Run test**

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add aim CLI for querying memory from terminal"
```

---

### Task 4.2: Terminal Output Formatting

**Files:**
- Create: `src/cli/formatters.ts`
- Test: `tests/cli/formatters.test.ts`

**Step 1: Write failing test**

Test that observations format as readable terminal output with colors.

**Step 2: Implement formatters**

- Table output for search results
- Timeline output with date grouping
- Status output with health indicators
- Color coding via ANSI escape codes

**Step 3: Run test**

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add terminal formatters for aim CLI output"
```

---

## Phase 5: Verification & Cleanup

### Task 5.1: Full Test Suite

**Step 1: Run all tests**

```bash
bun test
```

**Step 2: Fix any broken tests**

Tests may reference old env var names, old paths, old class names. Update them.

**Step 3: Commit test fixes**

---

### Task 5.2: Build & Install Verification

**Step 1: Build the plugin**

```bash
npm run build
```

**Step 2: Verify built artifacts exist**

```bash
ls -la plugin/scripts/worker-service.cjs
ls -la plugin/scripts/mcp-server.cjs
```

**Step 3: Run data migration**

```bash
./scripts/migrate-data.sh
```

**Step 4: Start worker manually**

```bash
bun plugin/scripts/worker-service.cjs start
```

**Step 5: Verify health endpoint**

```bash
curl http://localhost:37777/health
```

**Step 6: Verify search endpoint**

```bash
curl "http://localhost:37777/api/search?q=test&limit=5"
```

**Step 7: Verify web UI loads**

Open `http://localhost:37777` in browser.

**Step 8: Commit any final fixes**

---

### Task 5.3: Plugin Installation Test

**Step 1: Create marketplace directory**

```bash
mkdir -p ~/.claude/plugins/marketplaces/bdmorin
```

**Step 2: Sync built plugin**

Copy built `plugin/` directory to marketplace location.

**Step 3: Register in installed_plugins.json**

Add `ai-mem@bdmorin` entry.

**Step 4: Restart Claude Code**

**Step 5: Verify hooks fire on session start**

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: verification complete, ai-mem 1.0.0 ready"
```

---

## What We're NOT Doing (Yet)

Deferred to future work:

- **Multi-provider support** — Only Anthropic API for now. Can add Gemini/OpenRouter later.
- **Persistent daemon** — Keeping session-scoped. Revisit when we understand usage patterns.
- **Web UI improvements** — Works as-is. No investment.
- **npm publishing** — Install from source/git for now.
- **Remote Chroma** — Local only for now.
- **Automated testing in CI** — Get tests passing locally first.
- **Pro features** — Stripped references, not building.

---

## File Deletion Summary

Files and directories deleted across all phases:

```
DELETE plugin/scripts/smart-install.js
DELETE plugin/scripts/bun-runner.js
DELETE plugin/scripts/setup.sh
DELETE cursor-hooks/
DELETE src/services/integrations/CursorHooksInstaller.ts
DELETE scripts/translate-readme/
DELETE scripts/discord-release-notify.js
DELETE scripts/generate-changelog.js
DELETE scripts/publish.js
DELETE scripts/sync-marketplace.cjs
DELETE scripts/build-worker-binary.js
DELETE docs/i18n/
DELETE docs/reports/
DELETE docs/PR-SHIPPING-REPORT.md
DELETE docs/VERSION_FIX.md
DELETE docs/anti-pattern-cleanup-plan.md
DELETE docs/SESSION_ID_ARCHITECTURE.md
DELETE CHANGELOG.md
DELETE conductor.json
DELETE .translation-cache.json
DELETE plugin/modes/* (except code.json)
DELETE ragtime/
DELETE openclaw/
DELETE installer/
DELETE install/
DELETE src/sdk/ (after moving parser.ts)
DELETE GeminiAgent.ts
DELETE OpenRouterAgent.ts
```

## Dependency Changes

```
REMOVE @anthropic-ai/claude-agent-sdk
REMOVE np (devDependency)
KEEP   @modelcontextprotocol/sdk
KEEP   express
KEEP   react, react-dom
KEEP   ansi-to-html, dompurify
KEEP   esbuild, tsx, typescript
KEEP   yaml, handlebars, zod-to-json-schema, glob
```
