# SQLite-Native Search Engine — Product Requirements Document

## Goal

Build a search engine for ai-mem's observation database. The system should support keyword search, semantic vector search, and hybrid ranking. We strongly prefer solutions that stay within the Bun/TypeScript/SQLite ecosystem, but what matters most is search quality and simplicity.

## Scoring Guide

This document uses a point-scoring system to express preferences. These aren't tallied for a final grade — they signal what we value and what we'd rather avoid. When making design tradeoffs, optimize toward higher-scoring choices. A creative solution we didn't anticipate that scores well is better than a literal reading that scores poorly.

### Architectural Preferences

| Choice | Points | Rationale |
|--------|--------|-----------|
| Everything runs inside the Bun process | +20 | Single process, no coordination overhead |
| Uses `bun:sqlite` for data + search | +15 | Already our runtime, zero new deps |
| SQLite extension loaded via `loadExtension()` | +10 | Clean integration, stays in-process |
| Uses a TypeScript/JS embedding library | +10 | One language, one ecosystem |
| Spawns a background thread (Bun worker) | +5 | Acceptable for heavy compute like embedding |
| Spawns a child process (same language) | -5 | Coordination tax, but manageable |
| Requires Python or uv | -30 | Exactly the dependency chain we're trying to eliminate |
| Requires a separate daemon/server | -20 | Operational complexity we don't want |
| Requires network calls for search queries | -15 | Latency, failure modes, connectivity dependency |
| Network calls for write-time embedding only | -5 | Acceptable fallback if local inference fails |

### Search Quality Preferences

| Choice | Points | Rationale |
|--------|--------|-----------|
| Hybrid search (keyword + semantic) | +20 | Best of both worlds |
| Results ranked by relevance, not just date | +15 | The whole point of building this |
| FTS5 with BM25 ranking | +10 | Proven, fast, good baseline |
| Vector similarity via cosine distance | +10 | Catches what keywords miss |
| Supports prefix matching ("auth*") | +5 | Common user expectation |
| Supports phrase matching ("JWT token") | +5 | Precision when users know what they want |
| Results degrade gracefully when a component fails | +10 | FTS5 still works if vector dies |
| All-or-nothing: if vector fails, no search | -20 | Fragile, bad UX |

### Code Quality Preferences

| Choice | Points | Rationale |
|--------|--------|-----------|
| Single-file search module (<500 LOC) | +10 | Easy to understand and maintain |
| Clean module boundary (import and use) | +10 | Library, not framework |
| Minimal abstraction layers | +10 | We don't need strategy patterns for a spike |
| Heavy abstraction (factories, registries) | -10 | Over-engineering a spike |
| Comprehensive error messages | +5 | Debug-friendly |
| Silent failures | -10 | Hard to diagnose |

## Context

ai-mem stores structured observations about developer work sessions. Each observation has:
- `title` (TEXT) — short summary, ~50-100 chars
- `narrative` (TEXT) — descriptive paragraph, ~300-3600 chars
- `facts` (JSON array of strings) — 2-14 individual fact sentences
- `concepts` (JSON array of strings) — tags from fixed vocabulary: `how-it-works`, `pattern`, `problem-solution`, `gotcha`, `trade-off`, `why-it-exists`, `what-changed`
- `type` (TEXT) — one of: `discovery`, `change`, `feature`, `bugfix`, `decision`, `refactor`
- `project` (TEXT) — project name
- `files_read`, `files_modified` (JSON arrays of file path strings)
- `created_at_epoch` (INTEGER) — unix timestamp in milliseconds

The database contains ~1,000-5,000 observations across multiple projects.

## Requirements

### R1: Full-Text Search (FTS5)

Implement keyword-based search using SQLite FTS5 virtual tables.

**Indexed fields:** title, narrative, and each individual fact string from the facts array.

**Capabilities:**
- BM25 relevance ranking
- Prefix matching (e.g., "auth*" matches "authentication", "authorize")
- Phrase matching (e.g., `"JWT token"`)
- Boolean operators (AND, OR, NOT)
- Stemming is NOT required for v1 — SQLite's default tokenizer is acceptable

**Input:** Query string, optional metadata filters (project, type, date range, concepts).
**Output:** Ranked list of observation IDs with relevance scores, sorted by score descending.

### R2: Vector Similarity Search

Implement semantic vector search. We prefer sqlite-vec (SQLite extension, +10 points) but any approach that stays in-process is fine.

**Embedding generation:**
- Prefer `@huggingface/transformers` (transformers.js v3) for local inference (+10 points)
- Alternative: any embedding approach that runs in Bun without Python (-30 for Python)
- Model suggestion: `all-MiniLM-L6-v2` (384 dimensions) — but use whatever produces good results
- Embeddings are generated at write time (when observations are inserted)
- Store embeddings alongside the observation ID

**What gets embedded:**
- At minimum: concatenation of `title + " " + narrative` per observation
- Bonus (+5): also embed individual facts for finer-grained retrieval

**Capabilities:**
- K-nearest-neighbor search by cosine distance
- Filter by metadata (project, type, date range) composable with vector search

**Input:** Query string (embedded at query time), K (number of results), optional metadata filters.
**Output:** Ranked list of observation IDs with distance scores, sorted by distance ascending.

### R3: Hybrid Search (Reciprocal Rank Fusion)

Combine FTS5 keyword results and vector similarity results using Reciprocal Rank Fusion (RRF).

**Algorithm:**
```
For each result appearing in either result set:
  rrf_score = 0
  if result in fts5_results:
    rrf_score += 1 / (k + fts5_rank)
  if result in vector_results:
    rrf_score += 1 / (k + vector_rank)

  where k = 60 (standard RRF constant)
```

**Input:** Query string, K, optional metadata filters.
**Output:** Ranked list of observation IDs with RRF scores, sorted by score descending.

### R4: Metadata Filtering

All search modes should support filtering by:
- `project` — exact match
- `type` — exact match or set membership (e.g., `['discovery', 'bugfix']`)
- `dateStart` / `dateEnd` — epoch millisecond range
- `concepts` — any-match against concepts JSON array (e.g., concept `"gotcha"` matches observations containing that concept)
- `files` — substring match against files_read or files_modified arrays

Filters should compose with search ranking (filter first, then rank).

### R5: API Contract

Expose a single search function with this interface:

```typescript
interface SearchOptions {
  query?: string;           // text to search for
  mode: 'fts5' | 'vector' | 'hybrid';
  limit?: number;           // default 20, max 100
  offset?: number;          // pagination
  project?: string;
  type?: string | string[];
  dateStart?: number;       // epoch ms
  dateEnd?: number;         // epoch ms
  concepts?: string[];
  files?: string;           // substring match
}

interface SearchResult {
  id: number;
  score: number;            // relevance score (higher = better)
  mode: 'fts5' | 'vector' | 'hybrid';
  title: string;
  type: string;
  project: string;
  created_at_epoch: number;
}

function search(db: Database, options: SearchOptions): SearchResult[];
```

When `query` is omitted, return metadata-filtered results sorted by `created_at_epoch DESC`.

### R6: Write-Time Operations

When a new observation is inserted:
1. FTS5 index updates (triggers or explicit insert — your call)
2. Generate embedding vector
3. Insert embedding into vector store

Embedding generation may be async (non-blocking). If embedding fails, the observation should still be stored and searchable via FTS5 (+10 graceful degradation).

### R7: Performance Aspirations

On a database with 5,000 observations. These are aspirational targets — measure and report actuals.

| Operation | Target | Bonus if under |
|-----------|--------|----------------|
| FTS5 query | < 10ms | < 5ms (+5) |
| Vector query (top-20) | < 50ms | < 25ms (+5) |
| Hybrid query | < 100ms | < 50ms (+5) |
| Embedding generation (1 observation, model warm) | < 500ms | < 200ms (+5) |
| Model cold start (one-time) | < 5 seconds | < 2 seconds (+5) |

### R8: Test Harness

The implementation should include:
- A seed script that loads test fixture data into a fresh SQLite database
- The search function exposed as a module export
- A benchmark script that runs each search mode against standard queries and reports timing
- Unit tests for each search mode that exercise real queries against seeded data

## Scope Boundaries

This is a standalone spike — a library, not a service:
- No HTTP server needed
- No UI
- No migration system — create tables from scratch
- No integration with the existing ai-mem codebase
- Fail fast and log — no retry logic needed

## Deliverables

1. `src/search.ts` — search function implementing R1-R5
2. `src/embeddings.ts` — embedding generation wrapper for R2, R6
3. `src/schema.ts` — SQLite table creation (FTS5 + vector tables)
4. `src/seed.ts` — loads test fixtures into database
5. `src/benchmark.ts` — timing harness for R7
6. `tests/` — unit tests for each search mode
7. `package.json` with dependencies
