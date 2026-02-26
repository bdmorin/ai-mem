# ai-mem Reliability Overhaul — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create implementation plans from this design.

**Goal:** Replace Chroma with SQLite-native search, add durable observation intake via outbox pattern, and build a `aim doctor --fix` diagnostic CLI — three independent branches forming one coherent reliability story.

**Architecture:** Single-process Bun worker with SQLite as the sole data store. Hooks write directly to SQLite (no HTTP dependency). Worker drains an outbox table, extracts observations via Anthropic API, stores them with FTS5 indexing and vector embeddings. Doctor command verifies consistency across all subsystems.

**Delivery:** Three separate branches, each with its own worktree, PR, and merge. Order: search → outbox → doctor (doctor depends on the other two existing).

---

## Branch 1: SQLite-Native Search (replacing Chroma)

### Context

A spike (`spikes/sqlite-search/`) validated this approach. Shakedown grade: B+ (one FTS5 query sanitization bug, otherwise clean). Performance: FTS5 0.13ms p50, vector 1.09ms p50, hybrid 1.21ms p50 — all 10-50x better than targets.

Key spike finding: `sqlite-vec` cannot load in Bun (static SQLite compilation, no `loadExtension()`). Pure TypeScript cosine similarity over Float32Array BLOBs is sub-3ms at 200 documents and projected <10ms at 5K. No extension needed.

### What Gets Deleted (~2,000 LOC)

- `src/services/sync/ChromaSync.ts` (812 LOC)
- `src/services/sync/ChromaMcpManager.ts` (456 LOC)
- `src/services/worker/search/strategies/ChromaSearchStrategy.ts` (248 LOC)
- `src/services/worker/search/strategies/HybridSearchStrategy.ts` (270 LOC)
- All Chroma-related test files
- `AI_MEM_CHROMA_ENABLED`, `AI_MEM_CHROMA_MODE` settings and all references
- uv/Python dependency documentation

### What Gets Added (~480 LOC)

| File | Purpose | LOC |
|------|---------|-----|
| `src/services/search/fts5.ts` | FTS5 MATCH queries with BM25 ranking, query sanitization | ~120 |
| `src/services/search/vector.ts` | Cosine similarity over Float32Array embeddings | ~80 |
| `src/services/search/hybrid.ts` | Reciprocal Rank Fusion of FTS5 + vector results | ~60 |
| `src/services/search/embeddings.ts` | transformers.js wrapper, model lifecycle management | ~100 |
| `src/services/search/index.ts` | Public API (SearchOptions, SearchResult, search()) | ~40 |
| Migration | observation_embeddings table, embedding_metadata table, FTS5 triggers | ~80 |

### What Gets Modified

- `SearchOrchestrator.ts` — swap Chroma strategy refs for new FTS5/vector/hybrid
- `SearchManager.ts` — remove Chroma null checks, delegate to new search module
- `DatabaseManager.ts` — remove ChromaSync init, add embedding model load
- `worker-service.ts` — remove ChromaMcpManager, load transformers.js at startup
- `ResponseProcessor.ts` — replace `chromaSync?.syncObservation()` with embedding insert
- `SettingsDefaultsManager.ts` — remove Chroma settings, add embedding model settings

### Schema

```sql
CREATE TABLE observation_embeddings (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id),
  embedding BLOB NOT NULL,  -- Float32Array, 384 dims = 1536 bytes
  model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  created_at_epoch INTEGER NOT NULL
);

CREATE TABLE embedding_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: current_model, dimensions, last_full_embed_epoch
```

### FTS5 Query Sanitization (Shakedown Bug Fix)

The shakedown found that dots (`.`) and colons (`:`) crash FTS5's MATCH parser. These are common in file paths and URLs.

Fix: Strip FTS5-hostile characters from user queries before MATCH. Replace non-alphanumeric, non-space, non-quote, non-asterisk characters with spaces. Preserve quoted phrases and explicit FTS5 operators (AND, OR, NOT, *).

### Model Lifecycle

**Settings:**
```
AI_MEM_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
AI_MEM_EMBEDDING_DIMENSIONS=384
```

**Startup flow:**
1. Load `AI_MEM_EMBEDDING_MODEL` from settings
2. Read `embedding_metadata.current_model` from DB
3. If mismatch or empty:
   - Log model change
   - DELETE FROM observation_embeddings
   - Load new model (download ~23MB on first run, 136ms from cache after)
   - Re-embed all observations with progress bar
   - Update embedding_metadata
4. If match: load model from cache (136ms), ready

**Graceful degradation:** If model fails to load (first run + no internet), vector and hybrid search degrade to FTS5-only. FTS5 always works. Model downloads on next startup with connectivity.

### Search API

```typescript
interface SearchOptions {
  query?: string;
  mode: 'fts5' | 'vector' | 'hybrid';
  limit?: number;           // default 20, max 100
  offset?: number;
  project?: string;
  type?: string | string[];
  dateStart?: number;       // epoch ms
  dateEnd?: number;         // epoch ms
  concepts?: string[];
  files?: string;           // substring match
}

interface SearchResult {
  id: number;
  score: number;            // higher = better (normalized)
  mode: 'fts5' | 'vector' | 'hybrid';
  title: string;
  type: string;
  project: string;
  created_at_epoch: number;
}

function search(db: Database, options: SearchOptions): SearchResult[];
```

Hybrid is the default mode. When `query` is omitted, returns metadata-filtered results sorted by `created_at_epoch DESC`.

---

## Branch 2: Hook-Side SQLite Outbox

### The Problem

If the worker is down when a PostToolUse hook fires, the observation is silently dropped. The hook does an HTTP POST to the worker — if the worker is unreachable, no retry, no persistence. Data loss.

Additionally, the existing `pending_messages` table has a bug: `confirmProcessed()` is called even on API extraction errors, deleting messages from the queue without storing observations.

### The Solution: Outbox Pattern

Hooks write directly to SQLite (no HTTP). The worker drains the outbox independently. If the worker is down, observations accumulate on disk. When the worker restarts, it catches up.

### Schema

```sql
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'observation',
  tool_name TEXT,
  tool_input TEXT,              -- JSON
  tool_response TEXT,           -- JSON
  cwd TEXT,
  prompt_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at_epoch INTEGER NOT NULL,
  started_processing_at_epoch INTEGER,
  failed_at_epoch INTEGER,
  error_message TEXT
);

CREATE INDEX idx_outbox_status ON outbox(status, created_at_epoch);
```

### Hook Write Path (replaces HTTP POST)

```
PostToolUse hook fires
  → Open ai-mem.db (bun:sqlite, WAL mode)
  → INSERT INTO outbox (content_session_id, tool_name, tool_input, tool_response, cwd, prompt_number, created_at_epoch)
  → Close connection
  → Exit 0
```

Target: < 5ms. No network. No worker dependency. Always succeeds if disk is writable.

### Worker Drain Loop

```
Every 2 seconds (configurable via AI_MEM_OUTBOX_POLL_INTERVAL):
  → BEGIN TRANSACTION
  → SELECT FROM outbox WHERE status='pending' ORDER BY created_at_epoch LIMIT 10
  → UPDATE status='processing', started_processing_at_epoch=now
  → COMMIT

  → For each message in batch:
      → Send to Anthropic API (observation extraction)
      → On success:
          → Store observations + FTS5 + embeddings (single transaction)
          → DELETE from outbox WHERE id=?
      → On API failure:
          → INCREMENT retry_count
          → If retry_count > 3: SET status='failed', error_message=reason
          → If retry_count <= 3: SET status='pending' (retry next cycle)
```

### What Gets Deleted

- HTTP POST path in `src/cli/handlers/observation.ts`
- `ensureWorkerRunning()` checks in hooks (worker doesn't need to be up for writes)
- `src/services/sqlite/PendingMessageStore.ts` (490 LOC) — outbox replaces it entirely
- `pending_messages` table (via migration that drops it after draining to outbox)

### What Gets Modified

- `observation.ts` hook → direct SQLite write
- `worker-service.ts` → add outbox drain loop, remove event-based processing
- `SessionManager.ts` → read from outbox instead of in-memory events
- `ApiAgent.ts` → process outbox batches instead of event-driven messages

### Properties

- Hook never talks to the worker. Hook → SQLite → done.
- Worker is the only process that does AI extraction and writes observations.
- If worker is down, outbox grows. When it comes back, it catches up.
- Failed items stay in outbox with error_message for doctor to diagnose.
- Self-healing: processing items older than 60 seconds reset to pending on next drain cycle.

---

## Branch 3: `aim doctor --fix`

### Check Modules

Nine modules in `src/cli/doctor/`, each self-contained:

| Module | Checks | Fix Actions |
|--------|--------|-------------|
| **worker.ts** | Process running? HTTP responding? PID file valid? Port available? | Kill stale process, remove stale PID |
| **database.ts** | `PRAGMA integrity_check`, `foreign_key_check`, WAL mode, schema version | Run pending migrations, enable WAL |
| **fts5.ts** | Tables exist? Triggers present? Row count matches observations? | Rebuild FTS5 index from observations |
| **embeddings.ts** | Count matches observations? Model matches config? Model cached? | Re-embed missing, re-embed all on mismatch (progress bar) |
| **outbox.ts** | Queue depth? Stuck processing items? Failed items? Oldest pending age? | Reset stuck to pending, clear failed older than 7 days |
| **settings.ts** | File exists? Valid JSON? Deprecated keys? Required values? | Create defaults, remove deprecated keys |
| **directories.ts** | Data dirs exist? Writable? Stale PID/socket files? | Create missing dirs, remove stale files |
| **logs.ts** | Total size? Individual file sizes? Files older than 30 days? | Compress or delete old logs |
| **plugin.ts** | Installed? Hook scripts present? Version match? | Report only — no auto-fix |

### Severity Levels

| Level | Meaning | `--fix` behavior |
|-------|---------|-----------------|
| PASS | All good | Skip |
| WARN | Cosmetic or non-urgent | Fix if `--fix` |
| ERROR | Functional issue, auto-fixable | Fix if `--fix` |
| FATAL | Data integrity risk | Fix only if `--fix --force` |

### Module Interface

```typescript
interface DiagnosticResult {
  name: string;            // "fts5-row-count"
  category: string;        // "fts5"
  severity: 'pass' | 'warn' | 'error' | 'fatal';
  message: string;         // human-readable description
  fixable: boolean;
  fixDescription?: string; // what --fix would do
}

interface FixResult {
  name: string;
  success: boolean;
  message: string;
}

interface CheckModule {
  check(db: Database): DiagnosticResult[];
  fix?(db: Database, results: DiagnosticResult[]): FixResult[];
}
```

### CLI Interface

```
aim doctor              # run all checks, report table
aim doctor --fix        # run checks, fix WARN and ERROR items
aim doctor --fix --force  # also fix FATAL items (requires confirmation prompt)
aim doctor --dry-run    # show what --fix would do without doing it
aim doctor --check fts5 # run only the fts5 category
```

### Output Format

```
$ aim doctor

  Worker
  ✓ Process running (PID 48291)
  ✓ HTTP responding (37777)

  Database
  ✓ Integrity check passed
  ✓ WAL mode enabled
  ✓ Schema version 19

  FTS5 Index
  ✗ Row count mismatch: 1,204 vs 1,277 observations
    → fix: rebuild FTS5 index

  Embeddings
  ! Model not cached (Xenova/all-MiniLM-L6-v2)
    → fix: download model (23MB)
  ✗ 73 observations missing embeddings
    → fix: generate missing embeddings

  Outbox
  ✓ Queue empty
  ✓ No stuck items

  Settings
  ✓ Valid JSON
  ! Deprecated key: CLAUDE_MEM_CHROMA_ENABLED
    → fix: remove deprecated key

  Logs
  ! Total log size: 847MB
    → fix: compress logs older than 7 days

  ─────────────────────────────
  6 passed, 2 warnings, 2 errors
  Run `aim doctor --fix` to repair
```

### What Doctor Does NOT Do

- Does not start the worker — that's `aim start` or hook auto-start
- Does not modify observation data — only indexes and metadata
- Does not touch `plugin/` directory — plugin install is separate
- Does not run automatically — user invokes explicitly

---

## Data Flow (All Three Subsystems Integrated)

```
Claude Code Session
  │
  ├─ PostToolUse hook fires
  │   └─ Open ai-mem.db (bun:sqlite, WAL mode)
  │   └─ INSERT INTO outbox (...)
  │   └─ Exit 0 (< 5ms, never blocks Claude)
  │
  ├─ Worker daemon (independent process)
  │   └─ Poll loop: SELECT FROM outbox WHERE status='pending' LIMIT 10
  │   └─ For each batch:
  │       ├─ Mark status='processing'
  │       ├─ Send to Anthropic API (observation extraction)
  │       ├─ BEGIN TRANSACTION
  │       │   ├─ INSERT observations (FTS5 triggers fire automatically)
  │       │   ├─ Generate embedding (transformers.js, in-process)
  │       │   ├─ INSERT INTO observation_embeddings
  │       │   └─ DELETE FROM outbox
  │       └─ COMMIT
  │
  ├─ Search query (MCP tool or aim CLI)
  │   └─ FTS5 MATCH + vector cosine + RRF hybrid
  │   └─ Return ranked results
  │
  └─ aim doctor
      └─ Check outbox depth, FTS5 sync, embedding count, model version, worker health
      └─ --fix: rebuild FTS5, backfill embeddings, drain stuck outbox, rotate logs
```

---

## Dependencies After Overhaul

**Added:**
- `@huggingface/transformers` (transformers.js v3) — embedding generation

**Removed:**
- `@modelcontextprotocol/sdk` (if only used for Chroma MCP — verify before deleting)
- Python / uv / uvx runtime dependency
- `chroma-mcp` subprocess

**Unchanged:**
- `bun:sqlite` (built-in)
- `express` (worker HTTP API for search queries and viewer)
- All other existing dependencies

---

## Testing Strategy

Each branch includes its own tests:

**Branch 1 (Search):**
- Port spike tests into `tests/search/`
- FTS5 keyword, prefix, phrase, boolean queries
- Vector similarity ranking
- Hybrid RRF fusion
- FTS5 query sanitization (dots, colons, special chars)
- Metadata filter composition with all modes
- Graceful degradation without embeddings

**Branch 2 (Outbox):**
- Hook writes to outbox (direct SQLite insert)
- Worker drains outbox correctly
- Worker crash recovery (processing items reset to pending)
- Retry logic (3 attempts, then failed)
- Failed items stay in outbox with error message
- Concurrent hook writes during worker drain

**Branch 3 (Doctor):**
- Each check module: pass, warn, error, fatal scenarios
- Fix actions: FTS5 rebuild, embedding backfill, stale item reset, log rotation
- --dry-run reports without modifying
- --force required for FATAL fixes
- --check filters to specific category

---

## Migration Path

Since these are three separate branches merged sequentially:

1. **Search branch migration** adds: `observation_embeddings`, `embedding_metadata`, FTS5 triggers for facts field
2. **Outbox branch migration** adds: `outbox` table, drops `pending_messages` (after draining)
3. **Doctor branch** adds no migrations — it reads existing schema

Migration ordering matters: search must merge before outbox (outbox drain loop needs to generate embeddings).
