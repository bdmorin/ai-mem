# ai-mem

Persistent memory system for [Claude Code](https://claude.com/claude-code) by Anthropic. Captures tool usage observations, compresses them, and injects relevant context into future sessions so Claude maintains continuity across conversations.

Forked from [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman.

Built with [Claude Code](https://claude.com/claude-code) by Anthropic.

## Installation

Install from source:

```bash
git clone https://github.com/bdmorin/ai-mem.git
cd ai-mem
bun install
npm run build
```

Copy the built plugin to the marketplace directory:

```bash
mkdir -p ~/.claude/plugins/marketplaces/bdmorin
cp -R plugin/ ~/.claude/plugins/marketplaces/bdmorin/plugin/
```

If migrating from claude-mem:

```bash
./scripts/migrate-data.sh
```

## Configuration

Settings are stored in `~/.claude/ai-mem-data/settings.json` (auto-created on first run).

Environment variables use the `AI_MEM_*` prefix:

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_MEM_MODEL` | `claude-sonnet-4-5` | Model for observation extraction |
| `AI_MEM_WORKER_PORT` | `37777` | Worker HTTP API port |
| `AI_MEM_DATA_DIR` | `~/.claude/ai-mem-data` | Data directory |
| `AI_MEM_LOG_LEVEL` | `INFO` | Log level |
| `AI_MEM_CHROMA_ENABLED` | `true` | Enable vector search |

## Architecture

- **Worker Service** - Express HTTP API on port 37777, managed by Bun
- **Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd
- **SQLite Database** - Sessions, observations, summaries with FTS5 search
- **Chroma Vector DB** - Semantic search via embeddings
- **Web Viewer** - React UI at http://localhost:37777
- **MCP Search** - 3-layer search workflow (search -> timeline -> fetch)

## License

AGPL-3.0. See [LICENSE](LICENSE) for details.
