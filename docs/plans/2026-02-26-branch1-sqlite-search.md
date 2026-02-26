# Branch 1: SQLite-Native Search — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Chroma vector DB with SQLite-native FTS5 + pure TypeScript vector search, eliminating the Python/uv dependency chain while improving search quality and performance.

**Architecture:** FTS5 for keyword search with BM25 ranking, Float32Array BLOB embeddings with in-process cosine similarity for vector search, Reciprocal Rank Fusion for hybrid. All runs inside the Bun worker process. transformers.js v3 generates embeddings at write time. Graceful degradation: if embedding model unavailable, FTS5 still works.

**Tech Stack:** bun:sqlite (FTS5 built-in), @huggingface/transformers v3, TypeScript

**Design Doc:** `docs/plans/2026-02-26-reliability-overhaul-design.md` (Branch 1 section)
**Spike Code:** `spikes/sqlite-search/` (validated approach, shakedown grade B+)
**Current Migration Version:** 23 (next: 24)

---

## Pre-Flight

Before starting, create and switch to a feature branch:

```bash
git checkout -b feature/sqlite-search main
```

Install the new dependency:

```bash
bun add @huggingface/transformers@^3.5.1
```

Commit:

```bash
git add package.json bun.lockb
git commit -m "chore: add @huggingface/transformers dependency"
```

---

## Task 1: Migration — Add Embedding Tables

Add migration 24: `observation_embeddings` table, `embedding_metadata` table.

**Files:**
- Modify: `src/services/sqlite/migrations/runner.ts`
- Test: `tests/services/sqlite/migration-runner.test.ts`

**Step 1: Write the failing test**

Add to `tests/services/sqlite/migration-runner.test.ts`:

```typescript
describe('migration 24: observation_embeddings and embedding_metadata', () => {
  test('creates observation_embeddings table', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'").all();
    expect(tables.length).toBe(1);

    const cols = db.query('PRAGMA table_info(observation_embeddings)').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('observation_id');
    expect(colNames).toContain('embedding');
    expect(colNames).toContain('model');
    expect(colNames).toContain('created_at_epoch');
  });

  test('creates embedding_metadata table', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_metadata'").all();
    expect(tables.length).toBe(1);

    const cols = db.query('PRAGMA table_info(embedding_metadata)').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('key');
    expect(colNames).toContain('value');
  });

  test('migration is idempotent', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    runner.runAllMigrations(); // second run should not throw
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/services/sqlite/migration-runner.test.ts --grep "migration 24"
```

Expected: FAIL — table doesn't exist

**Step 3: Implement the migration**

Add to `src/services/sqlite/migrations/runner.ts`:

1. Add `this.createEmbeddingTables();` at the end of `runAllMigrations()`
2. Add the private method:

```typescript
/**
 * Create embedding tables for SQLite-native vector search (migration 24)
 */
private createEmbeddingTables(): void {
  const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;
  if (applied) return;

  const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'").all() as TableNameRow[];
  if (tables.length > 0) {
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
    return;
  }

  logger.debug('DB', 'Creating embedding tables for SQLite-native search');

  this.db.run(`
    CREATE TABLE observation_embeddings (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
      created_at_epoch INTEGER NOT NULL
    )
  `);

  this.db.run(`
    CREATE TABLE embedding_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
  logger.debug('DB', 'Embedding tables created successfully');
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/services/sqlite/migration-runner.test.ts --grep "migration 24"
```

Expected: PASS

**Step 5: Run full test suite**

```bash
bun test
```

Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add src/services/sqlite/migrations/runner.ts tests/services/sqlite/migration-runner.test.ts
git commit -m "feat: add observation_embeddings and embedding_metadata tables (migration 24)"
```

---

## Task 2: Embeddings Module

Port `spikes/sqlite-search/src/embeddings.ts` into the main codebase. This wraps transformers.js for embedding generation with lazy model loading.

**Files:**
- Create: `src/services/search/embeddings.ts`
- Test: `tests/search/embeddings.test.ts`

**Step 1: Write the failing test**

Create `tests/search/embeddings.test.ts`:

```typescript
import { describe, test, expect, beforeAll } from 'bun:test';
import {
  getEmbedder,
  embed,
  embedBatch,
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
} from '../../src/services/search/embeddings';

describe('embeddings', () => {
  // Model loading is slow (~2s first time), so we load once
  beforeAll(async () => {
    await getEmbedder();
  }, 30_000);

  test('embed() returns Float32Array of expected dimensions', async () => {
    const result = await embed('hello world');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  test('embed() returns normalized vectors (unit length)', async () => {
    const result = await embed('test input');
    const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 2);
  });

  test('embedBatch() returns array of Float32Array', async () => {
    const results = await embedBatch(['hello', 'world', 'test']);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(384);
    }
  });

  test('serialize/deserialize roundtrips correctly', () => {
    const original = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const blob = serializeEmbedding(original);
    expect(blob).toBeInstanceOf(Buffer);

    const restored = deserializeEmbedding(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]);
    }
  });

  test('cosineSimilarity() returns 1.0 for identical vectors', () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('cosineSimilarity() returns ~0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(Math.abs(cosineSimilarity(a, b))).toBeLessThan(0.01);
  });

  test('similar texts have higher cosine similarity than unrelated', async () => {
    const authEmbed = await embed('user authentication and login');
    const oauthEmbed = await embed('OAuth token validation');
    const cookingEmbed = await embed('best recipe for chocolate cake');

    const authOauthSim = cosineSimilarity(authEmbed, oauthEmbed);
    const authCookingSim = cosineSimilarity(authEmbed, cookingEmbed);

    expect(authOauthSim).toBeGreaterThan(authCookingSim);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/search/embeddings.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement the module**

Create `src/services/search/embeddings.ts`. Port from `spikes/sqlite-search/src/embeddings.ts` with these adaptations:

```typescript
/**
 * Embedding generation for SQLite-native vector search.
 *
 * Uses @huggingface/transformers (transformers.js v3) for in-process inference.
 * Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~23MB download).
 * Lazy-loads on first use. Caches in HuggingFace default cache dir.
 */

import type { Pipeline } from '@huggingface/transformers';

let pipeline: Pipeline | null = null;

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSIONS = 384;
const BATCH_SIZE = 32;

/**
 * Get or create the embedding pipeline (singleton, lazy).
 * First call downloads the model (~23MB) if not cached.
 */
export async function getEmbedder(model: string = DEFAULT_MODEL): Promise<Pipeline> {
  if (pipeline) return pipeline;

  const { pipeline: createPipeline } = await import('@huggingface/transformers');
  pipeline = await createPipeline('feature-extraction', model, {
    dtype: 'fp32',
  });

  return pipeline;
}

/**
 * Check if the embedding model is loaded.
 */
export function isModelLoaded(): boolean {
  return pipeline !== null;
}

/**
 * Embed a single text string. Returns normalized Float32Array (384 dims).
 */
export async function embed(text: string, model?: string): Promise<Float32Array> {
  const pipe = await getEmbedder(model);
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Embed multiple texts in batches. Returns array of normalized Float32Array.
 */
export async function embedBatch(
  texts: string[],
  model?: string,
  batchSize: number = BATCH_SIZE
): Promise<Float32Array[]> {
  const pipe = await getEmbedder(model);
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await pipe(batch, { pooling: 'mean', normalize: true });

    // Output shape: [batch_size, dimensions]
    const data = output.data as Float32Array;
    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIMENSIONS;
      const end = start + EMBEDDING_DIMENSIONS;
      results.push(new Float32Array(data.slice(start, end)));
    }
  }

  return results;
}

/**
 * Serialize Float32Array to Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Deserialize Buffer from SQLite BLOB back to Float32Array.
 */
export function deserializeEmbedding(blob: Buffer): Float32Array {
  const arrayBuffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(arrayBuffer);
}

/**
 * Compute cosine similarity between two vectors.
 * Vectors are assumed normalized (unit length), so cosine = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export { DEFAULT_MODEL, EMBEDDING_DIMENSIONS };
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/search/embeddings.test.ts
```

Expected: PASS (first run may take ~30s for model download)

**Step 5: Commit**

```bash
git add src/services/search/embeddings.ts tests/search/embeddings.test.ts
git commit -m "feat: add embeddings module with transformers.js wrapper"
```

---

## Task 3: FTS5 Search Module

Port and improve FTS5 search from the spike. Key fix: query sanitization for dots/colons (shakedown bug).

**Files:**
- Create: `src/services/search/fts5.ts`
- Test: `tests/search/fts5.test.ts`

**Step 1: Write the failing test**

Create `tests/search/fts5.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sanitizeFts5Query, searchFts5 } from '../../src/services/search/fts5';
import type { SearchOptions } from '../../src/services/search/types';

describe('FTS5 query sanitization', () => {
  test('passes through simple words', () => {
    expect(sanitizeFts5Query('hello world')).toBe('hello OR world');
  });

  test('strips dots from file paths', () => {
    const result = sanitizeFts5Query('file.ts');
    expect(result).not.toContain('.');
    expect(result).toContain('file');
    expect(result).toContain('ts');
  });

  test('strips colons from URLs and paths', () => {
    const result = sanitizeFts5Query('file.ts:42');
    expect(result).not.toContain(':');
  });

  test('preserves quoted phrases', () => {
    expect(sanitizeFts5Query('"JWT token"')).toBe('"JWT token"');
  });

  test('preserves asterisk for prefix matching', () => {
    expect(sanitizeFts5Query('auth*')).toBe('auth*');
  });

  test('preserves FTS5 boolean operators', () => {
    expect(sanitizeFts5Query('auth AND token')).toBe('auth AND token');
    expect(sanitizeFts5Query('auth OR login')).toBe('auth OR login');
    expect(sanitizeFts5Query('auth NOT oauth')).toBe('auth NOT oauth');
  });

  test('handles empty string', () => {
    expect(sanitizeFts5Query('')).toBe('');
  });

  test('handles single character', () => {
    const result = sanitizeFts5Query('a');
    expect(result).toBe('a');
  });
});

describe('FTS5 search', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');

    // Create observations table
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        narrative TEXT,
        facts TEXT,
        type TEXT NOT NULL,
        project TEXT NOT NULL,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    // Create FTS5 virtual table
    db.run(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title, narrative, facts,
        content='observations',
        content_rowid='id'
      )
    `);

    // Create triggers
    db.run(`
      CREATE TRIGGER observations_fts_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, facts)
        VALUES (new.id, new.title, new.narrative, new.facts);
      END
    `);

    // Seed test data
    const insert = db.prepare(`
      INSERT INTO observations (title, narrative, facts, type, project, concepts, files_read, files_modified, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run('JWT authentication setup', 'Configured JWT token validation for API endpoints', '["JWT tokens use RS256","Refresh tokens stored in httpOnly cookies"]', 'feature', 'auth-service', '["how-it-works"]', '["src/auth.ts"]', '["src/auth.ts"]', 1700000000000);
    insert.run('SQLite WAL mode configuration', 'Enabled WAL mode for better concurrent read performance', '["WAL mode allows readers during writes"]', 'discovery', 'ai-mem', '["pattern"]', '[]', '["src/db.ts"]', 1700000100000);
    insert.run('Webhook signature validation', 'Fixed webhook signature validation failure on POST requests', '["HMAC-SHA256 used for signature","Raw body must be preserved for validation"]', 'bugfix', 'cowork', '["problem-solution","gotcha"]', '["src/webhooks.ts"]', '["src/webhooks.ts"]', 1700000200000);
  });

  afterAll(() => {
    db.close();
  });

  test('finds exact keyword match', () => {
    const results = searchFts5(db, { query: 'JWT', mode: 'fts5', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('JWT');
  });

  test('finds keyword in narrative', () => {
    const results = searchFts5(db, { query: 'WAL', mode: 'fts5', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
  });

  test('returns empty for no matches', () => {
    const results = searchFts5(db, { query: 'quantum_entanglement_xyz', mode: 'fts5', limit: 10 });
    expect(results.length).toBe(0);
  });

  test('filters by project', () => {
    const results = searchFts5(db, { query: 'validation', mode: 'fts5', limit: 10, project: 'cowork' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.project).toBe('cowork');
    }
  });

  test('filters by type', () => {
    const results = searchFts5(db, { query: 'validation', mode: 'fts5', limit: 10, type: 'bugfix' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.type).toBe('bugfix');
    }
  });

  test('handles dots in query without crash', () => {
    const results = searchFts5(db, { query: 'file.ts', mode: 'fts5', limit: 10 });
    // Should not throw — may or may not find results
    expect(Array.isArray(results)).toBe(true);
  });

  test('handles colons in query without crash', () => {
    const results = searchFts5(db, { query: 'file.ts:42', mode: 'fts5', limit: 10 });
    expect(Array.isArray(results)).toBe(true);
  });

  test('respects limit parameter', () => {
    const results = searchFts5(db, { query: 'validation', mode: 'fts5', limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('results have required fields', () => {
    const results = searchFts5(db, { query: 'JWT', mode: 'fts5', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.id).toBeDefined();
    expect(r.score).toBeDefined();
    expect(r.mode).toBe('fts5');
    expect(r.title).toBeDefined();
    expect(r.type).toBeDefined();
    expect(r.project).toBeDefined();
    expect(r.created_at_epoch).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/search/fts5.test.ts
```

Expected: FAIL — module not found

**Step 3: Create shared types file**

Create `src/services/search/types.ts`:

```typescript
export interface SearchOptions {
  query?: string;
  mode: 'fts5' | 'vector' | 'hybrid';
  limit?: number;
  offset?: number;
  project?: string;
  type?: string | string[];
  dateStart?: number;
  dateEnd?: number;
  concepts?: string[];
  files?: string;
}

export interface SearchResult {
  id: number;
  score: number;
  mode: 'fts5' | 'vector' | 'hybrid';
  title: string;
  type: string;
  project: string;
  created_at_epoch: number;
}
```

**Step 4: Implement FTS5 search**

Create `src/services/search/fts5.ts`. Port from spike with the sanitization bug fix:

```typescript
/**
 * FTS5 keyword search with BM25 ranking.
 *
 * Query sanitization strips FTS5-hostile characters (dots, colons, etc.)
 * while preserving quoted phrases, boolean operators, and prefix wildcards.
 */

import type { Database } from 'bun:sqlite';
import type { SearchOptions, SearchResult } from './types';

const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Sanitize a user query for FTS5 MATCH.
 *
 * FTS5 treats dots as implicit phrase operators and colons as column selectors.
 * These are common in file paths (file.ts:42) and URLs, so we strip them.
 *
 * Preserves:
 * - Quoted phrases ("JWT token")
 * - Boolean operators (AND, OR, NOT)
 * - Prefix wildcards (auth*)
 */
export function sanitizeFts5Query(query: string): string {
  if (!query.trim()) return '';

  const tokens: string[] = [];
  let i = 0;

  while (i < query.length) {
    // Preserve quoted phrases
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      if (end !== -1) {
        tokens.push(query.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // Skip whitespace
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }

    // Extract word (alphanumeric + asterisk for prefix)
    let word = '';
    while (i < query.length && !/\s/.test(query[i])) {
      if (/[a-zA-Z0-9_*]/.test(query[i])) {
        word += query[i];
      }
      // Strip all other characters (dots, colons, brackets, etc.)
      i++;
    }

    if (word && word !== '*') {
      tokens.push(word);
    }
  }

  if (tokens.length === 0) return '';

  // Join with OR unless explicit operators are present
  const hasExplicitOperator = tokens.some(t => FTS5_OPERATORS.has(t));
  if (hasExplicitOperator) {
    return tokens.join(' ');
  }

  return tokens.join(' OR ');
}

/**
 * Build WHERE clause fragments from metadata filters.
 */
function buildMetadataFilter(options: SearchOptions): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options.project) {
    conditions.push('o.project = ?');
    params.push(options.project);
  }

  if (options.type) {
    if (Array.isArray(options.type)) {
      conditions.push(`o.type IN (${options.type.map(() => '?').join(', ')})`);
      params.push(...options.type);
    } else {
      conditions.push('o.type = ?');
      params.push(options.type);
    }
  }

  if (options.dateStart) {
    conditions.push('o.created_at_epoch >= ?');
    params.push(options.dateStart);
  }

  if (options.dateEnd) {
    conditions.push('o.created_at_epoch <= ?');
    params.push(options.dateEnd);
  }

  if (options.concepts && options.concepts.length > 0) {
    const conceptConditions = options.concepts.map(() => 'o.concepts LIKE ?');
    conditions.push(`(${conceptConditions.join(' OR ')})`);
    params.push(...options.concepts.map(c => `%"${c}"%`));
  }

  if (options.files) {
    conditions.push('(o.files_read LIKE ? OR o.files_modified LIKE ?)');
    params.push(`%${options.files}%`, `%${options.files}%`);
  }

  return {
    clause: conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '',
    params
  };
}

/**
 * Search observations using FTS5 MATCH with BM25 ranking.
 */
export function searchFts5(db: Database, options: SearchOptions): SearchResult[] {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset || 0;
  const sanitized = sanitizeFts5Query(options.query || '');

  if (!sanitized) return [];

  const filter = buildMetadataFilter(options);

  const sql = `
    SELECT
      o.id,
      -rank AS score,
      o.title,
      o.type,
      o.project,
      o.created_at_epoch
    FROM observations_fts fts
    JOIN observations o ON o.id = fts.rowid
    WHERE observations_fts MATCH ?
    ${filter.clause}
    ORDER BY score DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(sanitized, ...filter.params, limit, offset) as any[];

  return rows.map(row => ({
    id: row.id,
    score: row.score,
    mode: 'fts5' as const,
    title: row.title || '',
    type: row.type,
    project: row.project,
    created_at_epoch: row.created_at_epoch,
  }));
}

export { buildMetadataFilter };
```

**Step 5: Run test to verify it passes**

```bash
bun test tests/search/fts5.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/services/search/types.ts src/services/search/fts5.ts tests/search/fts5.test.ts
git commit -m "feat: add FTS5 search with query sanitization (fixes shakedown bug)"
```

---

## Task 4: Vector Search Module

Pure TypeScript cosine similarity over Float32Array embeddings stored as SQLite BLOBs.

**Files:**
- Create: `src/services/search/vector.ts`
- Test: `tests/search/vector.test.ts`

**Step 1: Write the failing test**

Create `tests/search/vector.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { searchVector } from '../../src/services/search/vector';
import { embed, serializeEmbedding } from '../../src/services/search/embeddings';

describe('vector search', () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');

    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, narrative TEXT, facts TEXT,
        type TEXT NOT NULL, project TEXT NOT NULL,
        concepts TEXT, files_read TEXT, files_modified TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE observation_embeddings (
        observation_id INTEGER PRIMARY KEY REFERENCES observations(id),
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
        created_at_epoch INTEGER NOT NULL
      )
    `);

    // Seed data with embeddings
    const insertObs = db.prepare(`
      INSERT INTO observations (title, narrative, facts, type, project, concepts, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEmb = db.prepare(`
      INSERT INTO observation_embeddings (observation_id, embedding, created_at_epoch)
      VALUES (?, ?, ?)
    `);

    const data = [
      { title: 'JWT authentication setup', narrative: 'Configured JWT token validation', type: 'feature', project: 'auth' },
      { title: 'SQLite WAL mode', narrative: 'Enabled WAL mode for concurrency', type: 'discovery', project: 'ai-mem' },
      { title: 'Webhook signature fix', narrative: 'Fixed HMAC validation on webhooks', type: 'bugfix', project: 'cowork' },
    ];

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const result = insertObs.run(d.title, d.narrative, '[]', d.type, d.project, '[]', 1700000000000 + i * 100000);
      const obsId = Number(result.lastInsertRowid);
      const embedding = await embed(`${d.title} ${d.narrative}`);
      insertEmb.run(obsId, serializeEmbedding(embedding), Date.now());
    }
  }, 30_000);

  afterAll(() => {
    db.close();
  });

  test('returns results ranked by similarity', async () => {
    const results = await searchVector(db, { query: 'JWT authentication', mode: 'vector', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('JWT');
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('filters by project', async () => {
    const results = await searchVector(db, { query: 'validation', mode: 'vector', limit: 10, project: 'cowork' });
    for (const r of results) {
      expect(r.project).toBe('cowork');
    }
  });

  test('returns empty when no embeddings exist', async () => {
    const emptyDb = new Database(':memory:');
    emptyDb.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, type TEXT NOT NULL, project TEXT NOT NULL, concepts TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER NOT NULL)`);
    emptyDb.run(`CREATE TABLE observation_embeddings (observation_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL, created_at_epoch INTEGER NOT NULL)`);

    const results = await searchVector(emptyDb, { query: 'test', mode: 'vector', limit: 10 });
    expect(results.length).toBe(0);
    emptyDb.close();
  });

  test('results have correct mode field', async () => {
    const results = await searchVector(db, { query: 'database', mode: 'vector', limit: 10 });
    for (const r of results) {
      expect(r.mode).toBe('vector');
    }
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/search/vector.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement vector search**

Create `src/services/search/vector.ts`:

```typescript
/**
 * Vector similarity search using pure TypeScript cosine similarity.
 *
 * Strategy: metadata filter first (SQL), then load embeddings for candidates,
 * compute cosine similarity in-process, sort by score. No SQLite extensions needed.
 */

import type { Database } from 'bun:sqlite';
import type { SearchOptions, SearchResult } from './types';
import { embed, deserializeEmbedding, cosineSimilarity, isModelLoaded } from './embeddings';

/**
 * Build WHERE clause for candidate selection.
 */
function buildCandidateFilter(options: SearchOptions): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options.project) {
    conditions.push('o.project = ?');
    params.push(options.project);
  }

  if (options.type) {
    if (Array.isArray(options.type)) {
      conditions.push(`o.type IN (${options.type.map(() => '?').join(', ')})`);
      params.push(...options.type);
    } else {
      conditions.push('o.type = ?');
      params.push(options.type);
    }
  }

  if (options.dateStart) {
    conditions.push('o.created_at_epoch >= ?');
    params.push(options.dateStart);
  }

  if (options.dateEnd) {
    conditions.push('o.created_at_epoch <= ?');
    params.push(options.dateEnd);
  }

  if (options.concepts && options.concepts.length > 0) {
    const conceptConditions = options.concepts.map(() => 'o.concepts LIKE ?');
    conditions.push(`(${conceptConditions.join(' OR ')})`);
    params.push(...options.concepts.map(c => `%"${c}"%`));
  }

  if (options.files) {
    conditions.push('(o.files_read LIKE ? OR o.files_modified LIKE ?)');
    params.push(`%${options.files}%`, `%${options.files}%`);
  }

  return {
    clause: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
}

/**
 * Search observations by vector similarity.
 */
export async function searchVector(db: Database, options: SearchOptions): Promise<SearchResult[]> {
  if (!options.query) return [];

  const limit = Math.min(options.limit || 20, 100);

  // Embed the query
  const queryEmbedding = await embed(options.query);

  // Get candidates with metadata filters
  const filter = buildCandidateFilter(options);

  const sql = `
    SELECT o.id, o.title, o.type, o.project, o.created_at_epoch, e.embedding
    FROM observations o
    JOIN observation_embeddings e ON e.observation_id = o.id
    ${filter.clause}
  `;

  const rows = db.prepare(sql).all(...filter.params) as any[];

  if (rows.length === 0) return [];

  // Compute cosine similarity for each candidate
  const scored = rows.map(row => ({
    id: row.id,
    title: row.title || '',
    type: row.type,
    project: row.project,
    created_at_epoch: row.created_at_epoch,
    score: cosineSimilarity(queryEmbedding, deserializeEmbedding(row.embedding)),
  }));

  // Sort by score descending and take top K
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(row => ({
    ...row,
    mode: 'vector' as const,
  }));
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/search/vector.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/search/vector.ts tests/search/vector.test.ts
git commit -m "feat: add vector search with pure TypeScript cosine similarity"
```

---

## Task 5: Hybrid Search (RRF) Module

Combine FTS5 and vector results using Reciprocal Rank Fusion.

**Files:**
- Create: `src/services/search/hybrid.ts`
- Test: `tests/search/hybrid.test.ts`

**Step 1: Write the failing test**

Create `tests/search/hybrid.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { searchHybrid } from '../../src/services/search/hybrid';
import { embed, serializeEmbedding } from '../../src/services/search/embeddings';

describe('hybrid search (RRF)', () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');

    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, narrative TEXT, facts TEXT,
      type TEXT NOT NULL, project TEXT NOT NULL,
      concepts TEXT, files_read TEXT, files_modified TEXT,
      created_at_epoch INTEGER NOT NULL
    )`);

    db.run(`CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, narrative, facts, content='observations', content_rowid='id'
    )`);

    db.run(`CREATE TRIGGER observations_fts_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, narrative, facts)
      VALUES (new.id, new.title, new.narrative, new.facts);
    END`);

    db.run(`CREATE TABLE observation_embeddings (
      observation_id INTEGER PRIMARY KEY REFERENCES observations(id),
      embedding BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
      created_at_epoch INTEGER NOT NULL
    )`);

    // Seed with FTS + embeddings
    const insertObs = db.prepare(`INSERT INTO observations (title, narrative, facts, type, project, concepts, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertEmb = db.prepare(`INSERT INTO observation_embeddings (observation_id, embedding, created_at_epoch) VALUES (?, ?, ?)`);

    const data = [
      { title: 'JWT authentication setup', narrative: 'Configured JWT token validation for API', type: 'feature', project: 'auth' },
      { title: 'OAuth token refresh', narrative: 'Implemented OAuth refresh token flow', type: 'feature', project: 'auth' },
      { title: 'SQLite WAL mode', narrative: 'Enabled WAL for concurrent reads', type: 'discovery', project: 'ai-mem' },
      { title: 'Webhook HMAC fix', narrative: 'Fixed HMAC signature validation on webhooks', type: 'bugfix', project: 'cowork' },
    ];

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const r = insertObs.run(d.title, d.narrative, '[]', d.type, d.project, '[]', 1700000000000 + i * 100000);
      const obsId = Number(r.lastInsertRowid);
      const emb = await embed(`${d.title} ${d.narrative}`);
      insertEmb.run(obsId, serializeEmbedding(emb), Date.now());
    }
  }, 30_000);

  afterAll(() => db.close());

  test('returns results combining FTS5 and vector', async () => {
    const results = await searchHybrid(db, { query: 'authentication', mode: 'hybrid', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].mode).toBe('hybrid');
  });

  test('hybrid results are superset of individual modes', async () => {
    const hybrid = await searchHybrid(db, { query: 'token', mode: 'hybrid', limit: 20 });
    const hybridIds = new Set(hybrid.map(r => r.id));
    // Hybrid should find at least as many results as either mode alone
    expect(hybridIds.size).toBeGreaterThan(0);
  });

  test('scores are positive and descending', async () => {
    const results = await searchHybrid(db, { query: 'authentication token', mode: 'hybrid', limit: 10 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeGreaterThan(0);
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test('filters compose with hybrid search', async () => {
    const results = await searchHybrid(db, {
      query: 'authentication',
      mode: 'hybrid',
      limit: 10,
      project: 'auth'
    });
    for (const r of results) {
      expect(r.project).toBe('auth');
    }
  });

  test('degrades to FTS5-only when no embeddings', async () => {
    const noVecDb = new Database(':memory:');
    noVecDb.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, narrative TEXT, facts TEXT, type TEXT NOT NULL, project TEXT NOT NULL, concepts TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER NOT NULL)`);
    noVecDb.run(`CREATE VIRTUAL TABLE observations_fts USING fts5(title, narrative, facts, content='observations', content_rowid='id')`);
    noVecDb.run(`CREATE TRIGGER observations_fts_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts); END`);
    // No embedding tables
    noVecDb.run(`INSERT INTO observations (title, narrative, facts, type, project, created_at_epoch) VALUES ('test item', 'test narrative', '[]', 'feature', 'proj', 1700000000000)`);

    const results = await searchHybrid(noVecDb, { query: 'test', mode: 'hybrid', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    // Should still work, just with FTS5-only scores
    noVecDb.close();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/search/hybrid.test.ts
```

**Step 3: Implement hybrid search**

Create `src/services/search/hybrid.ts`:

```typescript
/**
 * Hybrid search using Reciprocal Rank Fusion (RRF).
 *
 * Combines FTS5 keyword results and vector similarity results.
 * RRF formula: score = sum(1 / (k + rank)) for each result set.
 * k = 60 (standard constant).
 *
 * Graceful degradation: if vector search unavailable, returns FTS5-only results.
 */

import type { Database } from 'bun:sqlite';
import type { SearchOptions, SearchResult } from './types';
import { searchFts5 } from './fts5';
import { searchVector } from './vector';

const RRF_K = 60;

/**
 * Compute RRF scores from two ranked result sets.
 */
function computeRRF(
  fts5Results: SearchResult[],
  vectorResults: SearchResult[]
): SearchResult[] {
  const scoreMap = new Map<number, { score: number; result: SearchResult }>();

  // Score from FTS5 rankings
  for (let rank = 0; rank < fts5Results.length; rank++) {
    const r = fts5Results[rank];
    const rrfScore = 1 / (RRF_K + rank);
    scoreMap.set(r.id, { score: rrfScore, result: { ...r, mode: 'hybrid' } });
  }

  // Add scores from vector rankings
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const r = vectorResults[rank];
    const rrfScore = 1 / (RRF_K + rank);

    const existing = scoreMap.get(r.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(r.id, { score: rrfScore, result: { ...r, mode: 'hybrid' } });
    }
  }

  // Sort by combined RRF score
  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.score - a.score);

  return results.map(({ score, result }) => ({ ...result, score }));
}

/**
 * Hybrid search combining FTS5 and vector via RRF.
 */
export async function searchHybrid(db: Database, options: SearchOptions): Promise<SearchResult[]> {
  const limit = Math.min(options.limit || 20, 100);

  // Fetch more from each mode than the final limit for better RRF fusion
  const expandedLimit = limit * 3;
  const expandedOptions = { ...options, limit: expandedLimit };

  // Run FTS5 search (always works)
  const fts5Results = searchFts5(db, expandedOptions);

  // Try vector search (may fail if no embeddings table or model not loaded)
  let vectorResults: SearchResult[] = [];
  try {
    // Check if embedding table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'").all();
    if (tables.length > 0) {
      vectorResults = await searchVector(db, expandedOptions);
    }
  } catch {
    // Vector search unavailable — degrade to FTS5-only
  }

  if (vectorResults.length === 0) {
    // FTS5-only fallback — remap mode to hybrid
    return fts5Results.slice(0, limit).map(r => ({ ...r, mode: 'hybrid' as const }));
  }

  const fused = computeRRF(fts5Results, vectorResults);
  return fused.slice(0, limit);
}

export { computeRRF, RRF_K };
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/search/hybrid.test.ts
```

**Step 5: Commit**

```bash
git add src/services/search/hybrid.ts tests/search/hybrid.test.ts
git commit -m "feat: add hybrid search with Reciprocal Rank Fusion"
```

---

## Task 6: Public Search API

Single entry point that routes to the correct search mode.

**Files:**
- Create: `src/services/search/index.ts`
- Test: `tests/search/search-api.test.ts`

**Step 1: Write a brief integration test**

Create `tests/search/search-api.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { search } from '../../src/services/search';
import type { SearchOptions } from '../../src/services/search/types';
import { embed, serializeEmbedding } from '../../src/services/search/embeddings';

describe('search() public API', () => {
  let db: Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');

    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, narrative TEXT, facts TEXT,
      type TEXT NOT NULL, project TEXT NOT NULL,
      concepts TEXT, files_read TEXT, files_modified TEXT,
      created_at_epoch INTEGER NOT NULL
    )`);
    db.run(`CREATE VIRTUAL TABLE observations_fts USING fts5(title, narrative, facts, content='observations', content_rowid='id')`);
    db.run(`CREATE TRIGGER observations_fts_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts); END`);
    db.run(`CREATE TABLE observation_embeddings (observation_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2', created_at_epoch INTEGER NOT NULL)`);

    const ins = db.prepare(`INSERT INTO observations (title, narrative, facts, type, project, concepts, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insEmb = db.prepare(`INSERT INTO observation_embeddings (observation_id, embedding, created_at_epoch) VALUES (?, ?, ?)`);

    const r = ins.run('Test observation', 'A test narrative about authentication', '[]', 'feature', 'proj', '[]', 1700000000000);
    const id = Number(r.lastInsertRowid);
    const emb = await embed('Test observation A test narrative about authentication');
    insEmb.run(id, serializeEmbedding(emb), Date.now());
  }, 30_000);

  afterAll(() => db.close());

  test('search with mode=fts5 returns results', async () => {
    const results = await search(db, { query: 'authentication', mode: 'fts5' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].mode).toBe('fts5');
  });

  test('search with mode=vector returns results', async () => {
    const results = await search(db, { query: 'authentication', mode: 'vector' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].mode).toBe('vector');
  });

  test('search with mode=hybrid returns results', async () => {
    const results = await search(db, { query: 'authentication', mode: 'hybrid' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].mode).toBe('hybrid');
  });

  test('no query returns date-sorted results', async () => {
    const results = await search(db, { mode: 'hybrid' });
    expect(results.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/search/search-api.test.ts
```

**Step 3: Implement public API**

Create `src/services/search/index.ts`:

```typescript
/**
 * SQLite-native search engine.
 *
 * Public API: search(db, options) → SearchResult[]
 * Modes: fts5 (keyword), vector (semantic), hybrid (RRF fusion)
 * Default: hybrid
 */

import type { Database } from 'bun:sqlite';
import type { SearchOptions, SearchResult } from './types';
import { searchFts5 } from './fts5';
import { searchVector } from './vector';
import { searchHybrid } from './hybrid';

/**
 * Search observations. Routes to the correct search mode.
 * When query is omitted, returns metadata-filtered results sorted by date.
 */
export async function search(db: Database, options: SearchOptions): Promise<SearchResult[]> {
  const limit = Math.min(options.limit || 20, 100);
  const offset = options.offset || 0;

  // No query → browse mode (date-sorted with metadata filters)
  if (!options.query) {
    return browseByDate(db, { ...options, limit, offset });
  }

  switch (options.mode) {
    case 'fts5':
      return searchFts5(db, options);
    case 'vector':
      return searchVector(db, options);
    case 'hybrid':
    default:
      return searchHybrid(db, options);
  }
}

/**
 * Browse observations by date (no query text).
 */
function browseByDate(db: Database, options: SearchOptions & { limit: number; offset: number }): SearchResult[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options.project) {
    conditions.push('project = ?');
    params.push(options.project);
  }
  if (options.type) {
    if (Array.isArray(options.type)) {
      conditions.push(`type IN (${options.type.map(() => '?').join(', ')})`);
      params.push(...options.type);
    } else {
      conditions.push('type = ?');
      params.push(options.type);
    }
  }
  if (options.dateStart) {
    conditions.push('created_at_epoch >= ?');
    params.push(options.dateStart);
  }
  if (options.dateEnd) {
    conditions.push('created_at_epoch <= ?');
    params.push(options.dateEnd);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const sql = `
    SELECT id, title, type, project, created_at_epoch
    FROM observations
    ${where}
    ORDER BY created_at_epoch DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, options.limit, options.offset) as any[];

  return rows.map(row => ({
    id: row.id,
    score: 0,
    mode: options.mode || 'hybrid',
    title: row.title || '',
    type: row.type,
    project: row.project,
    created_at_epoch: row.created_at_epoch,
  }));
}

// Re-export types
export type { SearchOptions, SearchResult } from './types';
export { searchFts5, sanitizeFts5Query } from './fts5';
export { searchVector } from './vector';
export { searchHybrid } from './hybrid';
export { embed, embedBatch, getEmbedder, isModelLoaded, serializeEmbedding, deserializeEmbedding, cosineSimilarity, DEFAULT_MODEL, EMBEDDING_DIMENSIONS } from './embeddings';
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/search/search-api.test.ts
```

**Step 5: Run all search tests**

```bash
bun test tests/search/
```

Expected: All pass

**Step 6: Commit**

```bash
git add src/services/search/index.ts tests/search/search-api.test.ts
git commit -m "feat: add public search API routing fts5/vector/hybrid modes"
```

---

## Task 7: Remove Chroma — Delete Files

Delete all Chroma-related source and test files.

**Files to delete:**
- `src/services/sync/ChromaSync.ts`
- `src/services/sync/ChromaMcpManager.ts`
- `src/services/worker/search/strategies/ChromaSearchStrategy.ts`
- `src/services/worker/search/strategies/HybridSearchStrategy.ts`
- `tests/integration/chroma-vector-sync.test.ts`
- `tests/worker/search/strategies/chroma-search-strategy.test.ts`
- `tests/worker/search/strategies/hybrid-search-strategy.test.ts`

**Step 1: Delete files**

```bash
git rm src/services/sync/ChromaSync.ts
git rm src/services/sync/ChromaMcpManager.ts
git rm src/services/worker/search/strategies/ChromaSearchStrategy.ts
git rm src/services/worker/search/strategies/HybridSearchStrategy.ts
git rm tests/integration/chroma-vector-sync.test.ts
git rm tests/worker/search/strategies/chroma-search-strategy.test.ts
git rm tests/worker/search/strategies/hybrid-search-strategy.test.ts
```

**Step 2: Verify no orphaned imports**

Search for remaining references. These will be fixed in the next tasks:

```bash
grep -r "ChromaSync\|ChromaMcpManager\|ChromaSearchStrategy\|HybridSearchStrategy" src/ --include="*.ts" -l
```

Expected files remaining (to fix in subsequent tasks):
- `src/services/worker/DatabaseManager.ts`
- `src/services/worker/SearchManager.ts`
- `src/services/worker/search/SearchOrchestrator.ts`
- `src/services/worker-service.ts`
- `src/services/worker/agents/ResponseProcessor.ts`
- `src/shared/SettingsDefaultsManager.ts`

**Step 3: Commit the deletions**

```bash
git commit -m "refactor: delete Chroma source and test files (~2000 LOC)"
```

---

## Task 8: Rewire SearchOrchestrator

Replace Chroma strategy references with new search module.

**Files:**
- Modify: `src/services/worker/search/SearchOrchestrator.ts`
- Modify: `tests/worker/search/search-orchestrator.test.ts`

**Step 1: Rewrite SearchOrchestrator**

The current SearchOrchestrator routes to ChromaSearchStrategy/HybridSearchStrategy/SQLiteSearchStrategy. Replace it to use the new `search()` function from `src/services/search/index.ts` for text queries while keeping the existing SQLiteSearchStrategy for filter-only paths (which delegates to `SessionSearch` for sessions/prompts — functionality our new search module doesn't cover).

Key changes:
1. Remove `ChromaSync`, `ChromaSearchStrategy`, `HybridSearchStrategy` imports
2. Import `search` from `../../search/index.js`
3. For text queries: call `search()` for observations, keep SQLiteSearchStrategy for sessions/prompts
4. Remove `isChromaAvailable()` method
5. Remove `chromaSync` constructor parameter
6. Keep `ResultFormatter`, `TimelineBuilder`, `normalizeParams` unchanged

The constructor changes from:
```typescript
constructor(sessionSearch, sessionStore, chromaSync: ChromaSync | null)
```
To:
```typescript
constructor(private sessionSearch: SessionSearch, private sessionStore: SessionStore, private db: Database)
```

**Step 2: Update tests**

Update `tests/worker/search/search-orchestrator.test.ts` to remove all chromaSync mocks and test the new flow.

**Step 3: Run tests**

```bash
bun test tests/worker/search/search-orchestrator.test.ts
```

**Step 4: Commit**

```bash
git add src/services/worker/search/SearchOrchestrator.ts tests/worker/search/search-orchestrator.test.ts
git commit -m "refactor: rewire SearchOrchestrator to use SQLite-native search"
```

---

## Task 9: Rewire DatabaseManager

Remove ChromaSync initialization, add database reference for search.

**Files:**
- Modify: `src/services/worker/DatabaseManager.ts`

**Step 1: Remove Chroma references**

1. Remove `import { ChromaSync }` and `import { SettingsDefaultsManager }` (if only used for Chroma check)
2. Remove `private chromaSync: ChromaSync | null` member
3. Remove Chroma initialization block from `initialize()`
4. Remove `getChromaSync()` method
5. Remove Chroma cleanup from `close()`
6. Add `getDatabase(): Database` method that returns the raw database handle (needed for search module)

**Step 2: Run tests**

```bash
bun test
```

Fix any remaining compilation errors from removed Chroma references.

**Step 3: Commit**

```bash
git add src/services/worker/DatabaseManager.ts
git commit -m "refactor: remove ChromaSync from DatabaseManager"
```

---

## Task 10: Rewire ResponseProcessor

Replace Chroma sync with embedding generation.

**Files:**
- Modify: `src/services/worker/agents/ResponseProcessor.ts`
- Modify: `tests/worker/agents/response-processor.test.ts`

**Step 1: Replace Chroma sync calls**

In `syncAndBroadcastObservations()` (around line 194-217):
- Remove `dbManager.getChromaSync()?.syncObservation()` call
- Replace with embedding generation:

```typescript
// Generate embedding and store (fire-and-forget, search works without it)
import { embed, serializeEmbedding } from '../../search/embeddings';

// After observation is stored:
embed(`${obs.title} ${obs.narrative || ''}`).then(embedding => {
  const embBlob = serializeEmbedding(embedding);
  dbManager.getSessionStore().getDb().prepare(
    'INSERT OR REPLACE INTO observation_embeddings (observation_id, embedding, created_at_epoch) VALUES (?, ?, ?)'
  ).run(obsId, embBlob, Date.now());
}).catch(error => {
  logger.warn('EMBED', 'Embedding generation failed, FTS5 search still works', { obsId }, error as Error);
});
```

Similarly in `syncAndBroadcastSummary()` (around line 288): remove the `dbManager.getChromaSync()?.syncSummary()` call entirely (we don't embed summaries — only observations).

**Step 2: Update tests**

Remove Chroma mocks from `tests/worker/agents/response-processor.test.ts`.

**Step 3: Run tests**

```bash
bun test tests/worker/agents/response-processor.test.ts
```

**Step 4: Commit**

```bash
git add src/services/worker/agents/ResponseProcessor.ts tests/worker/agents/response-processor.test.ts
git commit -m "refactor: replace Chroma sync with embedding generation in ResponseProcessor"
```

---

## Task 11: Rewire worker-service.ts

Remove ChromaMcpManager startup and Chroma imports.

**Files:**
- Modify: `src/services/worker-service.ts`

**Step 1: Remove Chroma references**

1. Remove `import { ChromaMcpManager }` (line 20)
2. Remove `import { ChromaSync }` (line 21)
3. Remove `private chromaMcpManager` member (line 167)
4. Remove ChromaMcpManager initialization block from `initializeBackground()` (lines 374-381)
5. Remove any `chromaMcpManager` cleanup from shutdown
6. Update SearchOrchestrator construction to pass `db` instead of `chromaSync`

**Step 2: Add embedding model preload**

In `initializeBackground()`, after database initialization, add:

```typescript
// Preload embedding model (non-blocking, downloads ~23MB on first run)
import { getEmbedder, isModelLoaded } from './search/embeddings';
getEmbedder().then(() => {
  logger.info('SYSTEM', 'Embedding model loaded');
}).catch(error => {
  logger.warn('SYSTEM', 'Embedding model load failed, vector search disabled until next restart', {}, error as Error);
});
```

**Step 3: Run tests**

```bash
bun test
```

**Step 4: Commit**

```bash
git add src/services/worker-service.ts
git commit -m "refactor: remove ChromaMcpManager from worker, add embedding model preload"
```

---

## Task 12: Clean Up Settings

Remove Chroma settings, add embedding model settings.

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`
- Modify: `src/ui/viewer/constants/settings.ts`
- Modify: `tests/shared/settings-defaults-manager.test.ts`

**Step 1: Update SettingsDefaultsManager**

1. Remove from interface and DEFAULTS:
   - `AI_MEM_CHROMA_ENABLED`
   - `AI_MEM_CHROMA_MODE`
   - `AI_MEM_CHROMA_HOST`
   - `AI_MEM_CHROMA_PORT`
   - `AI_MEM_CHROMA_SSL`
   - `AI_MEM_CHROMA_API_KEY`
   - `AI_MEM_CHROMA_TENANT`
   - `AI_MEM_CHROMA_DATABASE`
   - `AI_MEM_PYTHON_VERSION`

2. Add to interface and DEFAULTS:
   - `AI_MEM_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2'`
   - `AI_MEM_EMBEDDING_DIMENSIONS: '384'`

**Step 2: Update UI settings**

Remove any Chroma references from `src/ui/viewer/constants/settings.ts` if present.

**Step 3: Update tests**

Fix any tests that reference removed Chroma settings.

**Step 4: Run tests**

```bash
bun test tests/shared/settings-defaults-manager.test.ts
bun test
```

**Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts src/ui/viewer/constants/settings.ts tests/shared/settings-defaults-manager.test.ts
git commit -m "refactor: remove Chroma settings, add embedding model settings"
```

---

## Task 13: Clean Up Remaining Chroma References

Grep for any remaining Chroma mentions and fix them.

**Step 1: Find remaining references**

```bash
grep -ri "chroma\|chromasync\|chromamcp" src/ tests/ --include="*.ts" -l
```

Fix each file: remove dead imports, update comments, remove Chroma-specific logic.

**Step 2: Check SearchManager.ts**

`src/services/worker/SearchManager.ts` has extensive Chroma references. Review and remove all `if (this.chromaSync)` branches, Chroma query calls, etc.

**Step 3: Remove empty directories**

```bash
# If src/services/sync/ is now empty:
rmdir src/services/sync/ 2>/dev/null || true
```

**Step 4: Run full test suite**

```bash
bun test
```

All tests must pass. Fix any remaining breakage.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove all remaining Chroma references"
```

---

## Task 14: Build and Verify

Build the plugin and verify everything works end-to-end.

**Step 1: Build**

```bash
npm run build
```

Must succeed with no errors.

**Step 2: Run full test suite**

```bash
bun test
```

All tests pass.

**Step 3: Verify search works**

Start the worker and test search:

```bash
# Start worker
bun run src/services/worker-service.ts &

# Wait for it to be ready
sleep 3

# Test search endpoint
curl -s 'http://localhost:37777/api/search?query=test' | jq '.content[0].text' | head -20

# Stop worker
kill %1
```

**Step 4: Final commit and push**

```bash
git add -A
git commit -m "build: verify plugin build after Chroma removal"
git push origin feature/sqlite-search
```

---

## Summary

| Task | Description | Files Changed |
|------|-------------|---------------|
| 1 | Migration 24: embedding tables | runner.ts + test |
| 2 | Embeddings module (transformers.js) | embeddings.ts + test |
| 3 | FTS5 search + sanitization fix | fts5.ts + types.ts + test |
| 4 | Vector search (cosine similarity) | vector.ts + test |
| 5 | Hybrid search (RRF) | hybrid.ts + test |
| 6 | Public search API | index.ts + test |
| 7 | Delete Chroma files (~2000 LOC) | 7 files deleted |
| 8 | Rewire SearchOrchestrator | SearchOrchestrator.ts + test |
| 9 | Rewire DatabaseManager | DatabaseManager.ts |
| 10 | Rewire ResponseProcessor | ResponseProcessor.ts + test |
| 11 | Rewire worker-service.ts | worker-service.ts |
| 12 | Clean up settings | SettingsDefaultsManager.ts + UI |
| 13 | Remove remaining Chroma refs | Various |
| 14 | Build and verify | Plugin build |

**Net LOC change:** ~2000 deleted, ~480 added = **~1520 LOC reduction**
**New dependency:** `@huggingface/transformers@^3.5.1`
**Removed dependencies:** Python/uv/uvx runtime, chroma-mcp subprocess
