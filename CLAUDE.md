# ai-mem: Development Instructions

ai-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations, and injects relevant context into future sessions.

Forked from [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman.

## Architecture

**5 Lifecycle Hooks**: SessionStart -> UserPromptSubmit -> PostToolUse -> Summary -> SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript -> ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude/ai-mem-data/ai-mem.db`

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Planning Skill** (`plugin/skills/make-plan/SKILL.md`) - Orchestrator instructions for creating phased implementation plans with documentation discovery

**Execution Skill** (`plugin/skills/do/SKILL.md`) - Orchestrator instructions for executing phased plans using subagents

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags
- `<private>content</private>` - User-level privacy control (manual, prevents storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build        # Build hooks and worker
```

## Configuration

Settings are managed in `~/.claude/ai-mem-data/settings.json`. The file is auto-created with defaults on first run.

Environment variable prefix: `AI_MEM_*`

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/bdmorin/`
- **Database**: `~/.claude/ai-mem-data/ai-mem.db`
- **Chroma**: `~/.claude/ai-mem-data/chroma/`
- **Settings**: `~/.claude/ai-mem-data/settings.json`
- **Logs**: `~/.claude/ai-mem-data/logs/`

## Exit Code Strategy

ai-mem hooks use specific exit codes per Claude Code's hook contract:

- **Exit 0**: Success or graceful shutdown
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

## Requirements

- **Bun** (runtime, sqlite, test runner)
- **uv** (Python package manager for Chroma vector search)
- Node.js >= 18

## Important

Do not edit the changelog -- it is generated automatically.
