# Branch 2: Hook-Side SQLite Outbox — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragile HTTP POST observation path with a durable SQLite outbox. Hooks write directly to SQLite (no worker dependency). Worker drains the outbox independently. Zero observation loss when worker is down.

**Architecture:** PostToolUse hook opens ai-mem.db via bun:sqlite, inserts into `outbox` table, exits. Worker polls outbox every 2s, claims batches, sends to Anthropic API for extraction, stores observations + embeddings in a single transaction, then deletes from outbox. Failed items retry 3 times, then stay in outbox with error_message for `aim doctor` to diagnose.

**Tech Stack:** bun:sqlite (WAL mode), existing Anthropic API client

**Design Doc:** `docs/plans/2026-02-26-reliability-overhaul-design.md` (Branch 2 section)
**Depends On:** Branch 1 (search) must be merged first — the drain loop generates embeddings when storing observations.
**Current Migration Version:** 24 after Branch 1 (next: 25)

---

## Pre-Flight

Branch from the search branch (or main after search is merged):

```bash
git checkout -b feature/outbox feature/sqlite-search  # or main if search is merged
```

---

## Task 1: Migration — Add Outbox Table

**Files:**
- Modify: `src/services/sqlite/migrations/runner.ts`
- Test: `tests/services/sqlite/migration-runner.test.ts`

**Step 1: Write the failing test**

Add to `tests/services/sqlite/migration-runner.test.ts`:

```typescript
describe('migration 25: outbox table', () => {
  test('creates outbox table with correct schema', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'").all();
    expect(tables.length).toBe(1);

    const cols = db.query('PRAGMA table_info(outbox)').all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('content_session_id');
    expect(colNames).toContain('message_type');
    expect(colNames).toContain('tool_name');
    expect(colNames).toContain('tool_input');
    expect(colNames).toContain('tool_response');
    expect(colNames).toContain('cwd');
    expect(colNames).toContain('prompt_number');
    expect(colNames).toContain('status');
    expect(colNames).toContain('retry_count');
    expect(colNames).toContain('created_at_epoch');
    expect(colNames).toContain('started_processing_at_epoch');
    expect(colNames).toContain('failed_at_epoch');
    expect(colNames).toContain('error_message');
  });

  test('creates index on outbox(status, created_at_epoch)', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='outbox'").all() as any[];
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames).toContain('idx_outbox_status');
  });

  test('migration is idempotent', () => {
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    runner.runAllMigrations(); // no throw
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/services/sqlite/migration-runner.test.ts --grep "migration 25"
```

**Step 3: Implement the migration**

Add to `runner.ts`:

1. Add `this.createOutboxTable();` at the end of `runAllMigrations()`
2. Add the private method:

```typescript
/**
 * Create outbox table for durable observation intake (migration 25)
 * Hooks write directly to this table. Worker drains it independently.
 */
private createOutboxTable(): void {
  const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(25) as SchemaVersion | undefined;
  if (applied) return;

  const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'").all() as TableNameRow[];
  if (tables.length > 0) {
    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString());
    return;
  }

  logger.debug('DB', 'Creating outbox table for durable observation intake');

  this.db.run(`
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'observation',
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at_epoch INTEGER NOT NULL,
      started_processing_at_epoch INTEGER,
      failed_at_epoch INTEGER,
      error_message TEXT
    )
  `);

  this.db.run('CREATE INDEX idx_outbox_status ON outbox(status, created_at_epoch)');

  this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(25, new Date().toISOString());
  logger.debug('DB', 'Outbox table created successfully');
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/services/sqlite/migration-runner.test.ts --grep "migration 25"
```

**Step 5: Run full test suite**

```bash
bun test
```

**Step 6: Commit**

```bash
git add src/services/sqlite/migrations/runner.ts tests/services/sqlite/migration-runner.test.ts
git commit -m "feat: add outbox table for durable observation intake (migration 25)"
```

---

## Task 2: OutboxStore — Data Access Layer

Create the store that handles outbox CRUD operations.

**Files:**
- Create: `src/services/sqlite/OutboxStore.ts`
- Test: `tests/services/sqlite/OutboxStore.test.ts`

**Step 1: Write the failing test**

Create `tests/services/sqlite/OutboxStore.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OutboxStore } from '../../src/services/sqlite/OutboxStore';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner';

describe('OutboxStore', () => {
  let db: Database;
  let store: OutboxStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    store = new OutboxStore(db);
  });

  afterEach(() => db.close());

  test('enqueue() inserts a pending message', () => {
    const id = store.enqueue({
      contentSessionId: 'sess-123',
      toolName: 'Read',
      toolInput: '{"file": "test.ts"}',
      toolResponse: '{"content": "..."}',
      cwd: '/home/user/project',
      promptNumber: 1,
    });

    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.content_session_id).toBe('sess-123');
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
    expect(row.tool_name).toBe('Read');
  });

  test('claimBatch() returns pending items and marks them processing', () => {
    store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    store.enqueue({ contentSessionId: 'sess-1', toolName: 'Write', cwd: '/test', promptNumber: 2 });
    store.enqueue({ contentSessionId: 'sess-1', toolName: 'Bash', cwd: '/test', promptNumber: 3 });

    const batch = store.claimBatch(2);
    expect(batch.length).toBe(2);

    for (const item of batch) {
      expect(item.status).toBe('processing');
      expect(item.started_processing_at_epoch).toBeDefined();
    }

    // Only 1 remaining pending
    const remaining = store.claimBatch(10);
    expect(remaining.length).toBe(1);
  });

  test('confirmProcessed() deletes the item', () => {
    const id = store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    const batch = store.claimBatch(1);
    expect(batch.length).toBe(1);

    store.confirmProcessed(id);

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  test('markFailed() sets status and error message', () => {
    const id = store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    store.claimBatch(1);

    store.markFailed(id, 'API rate limit exceeded');

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('API rate limit exceeded');
    expect(row.failed_at_epoch).toBeDefined();
  });

  test('retryOrFail() increments retry_count and resets to pending', () => {
    const id = store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    store.claimBatch(1);

    store.retryOrFail(id, 'temporary error');

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  test('retryOrFail() marks failed after max retries', () => {
    const id = store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });

    // Simulate 3 retries
    for (let i = 0; i < 3; i++) {
      store.claimBatch(1);
      store.retryOrFail(id, `attempt ${i + 1}`);
    }

    // 4th attempt should mark as failed
    store.claimBatch(1);
    store.retryOrFail(id, 'final attempt');

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
  });

  test('resetStaleProcessing() resets items stuck in processing', () => {
    const id = store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    store.claimBatch(1);

    // Manually backdate the processing timestamp to simulate staleness
    db.prepare('UPDATE outbox SET started_processing_at_epoch = ? WHERE id = ?')
      .run(Date.now() - 120_000, id); // 2 minutes ago

    const count = store.resetStaleProcessing(60_000); // 60s threshold
    expect(count).toBe(1);

    const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
  });

  test('getStats() returns queue statistics', () => {
    store.enqueue({ contentSessionId: 'sess-1', toolName: 'Read', cwd: '/test', promptNumber: 1 });
    store.enqueue({ contentSessionId: 'sess-1', toolName: 'Write', cwd: '/test', promptNumber: 2 });

    const stats = store.getStats();
    expect(stats.pending).toBe(2);
    expect(stats.processing).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.total).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/services/sqlite/OutboxStore.test.ts
```

**Step 3: Implement OutboxStore**

Create `src/services/sqlite/OutboxStore.ts`:

```typescript
/**
 * OutboxStore — Durable queue for observation intake.
 *
 * Hooks write to this table (no worker dependency).
 * Worker drains it via claim-process-confirm pattern.
 * Failed items stay in the outbox with error messages for aim doctor.
 */

import type { Database } from 'bun:sqlite';

const MAX_RETRIES = 3;
const STALE_THRESHOLD_MS = 60_000;

export interface OutboxEnqueueParams {
  contentSessionId: string;
  messageType?: string;
  toolName?: string;
  toolInput?: string;
  toolResponse?: string;
  cwd?: string;
  promptNumber?: number;
}

export interface OutboxItem {
  id: number;
  content_session_id: string;
  message_type: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  status: string;
  retry_count: number;
  created_at_epoch: number;
  started_processing_at_epoch: number | null;
  failed_at_epoch: number | null;
  error_message: string | null;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  failed: number;
  total: number;
  oldestPendingAge?: number;
}

export class OutboxStore {
  constructor(private db: Database) {}

  /**
   * Insert a new item into the outbox. Called by hooks.
   */
  enqueue(params: OutboxEnqueueParams): number {
    const result = this.db.prepare(`
      INSERT INTO outbox (content_session_id, message_type, tool_name, tool_input, tool_response, cwd, prompt_number, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.contentSessionId,
      params.messageType || 'observation',
      params.toolName || null,
      params.toolInput || null,
      params.toolResponse || null,
      params.cwd || null,
      params.promptNumber || null,
      Date.now()
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Claim a batch of pending items for processing.
   * Atomically marks them as 'processing'.
   */
  claimBatch(limit: number = 10): OutboxItem[] {
    const now = Date.now();

    // First, reset any stale processing items
    this.resetStaleProcessing();

    // Claim pending items
    const items = this.db.prepare(`
      SELECT * FROM outbox
      WHERE status = 'pending'
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(limit) as OutboxItem[];

    if (items.length === 0) return [];

    // Mark as processing
    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE outbox SET status = 'processing', started_processing_at_epoch = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids);

    // Return updated items
    return items.map(i => ({
      ...i,
      status: 'processing',
      started_processing_at_epoch: now,
    }));
  }

  /**
   * Delete an item after successful processing.
   */
  confirmProcessed(id: number): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  /**
   * Mark an item as permanently failed.
   */
  markFailed(id: number, errorMessage: string): void {
    this.db.prepare(`
      UPDATE outbox SET status = 'failed', error_message = ?, failed_at_epoch = ?
      WHERE id = ?
    `).run(errorMessage, Date.now(), id);
  }

  /**
   * Retry or fail an item based on retry count.
   */
  retryOrFail(id: number, errorMessage: string): void {
    const item = this.db.prepare('SELECT retry_count FROM outbox WHERE id = ?').get(id) as { retry_count: number } | undefined;
    if (!item) return;

    if (item.retry_count >= MAX_RETRIES) {
      this.markFailed(id, errorMessage);
    } else {
      this.db.prepare(`
        UPDATE outbox SET status = 'pending', retry_count = retry_count + 1, error_message = ?
        WHERE id = ?
      `).run(errorMessage, id);
    }
  }

  /**
   * Reset items stuck in 'processing' state (worker crashed).
   */
  resetStaleProcessing(thresholdMs: number = STALE_THRESHOLD_MS): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db.prepare(`
      UPDATE outbox SET status = 'pending'
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(cutoff);

    return result.changes;
  }

  /**
   * Get queue statistics.
   */
  getStats(): OutboxStats {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count, MIN(created_at_epoch) as oldest
      FROM outbox
      GROUP BY status
    `).all() as { status: string; count: number; oldest: number }[];

    const stats: OutboxStats = { pending: 0, processing: 0, failed: 0, total: 0 };

    for (const row of rows) {
      if (row.status === 'pending') {
        stats.pending = row.count;
        stats.oldestPendingAge = Date.now() - row.oldest;
      } else if (row.status === 'processing') {
        stats.processing = row.count;
      } else if (row.status === 'failed') {
        stats.failed = row.count;
      }
    }

    stats.total = stats.pending + stats.processing + stats.failed;
    return stats;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/services/sqlite/OutboxStore.test.ts
```

**Step 5: Commit**

```bash
git add src/services/sqlite/OutboxStore.ts tests/services/sqlite/OutboxStore.test.ts
git commit -m "feat: add OutboxStore with claim-process-confirm pattern"
```

---

## Task 3: Rewrite Observation Hook — Direct SQLite Write

Replace the HTTP POST in `observation.ts` with a direct SQLite insert to the outbox.

**Files:**
- Modify: `src/cli/handlers/observation.ts`
- Test: `tests/hooks/observation-outbox.test.ts`

**Step 1: Write the failing test**

Create `tests/hooks/observation-outbox.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner';

/**
 * Tests that the observation hook writes directly to the outbox table.
 * We test the OutboxStore.enqueue() directly since the hook handler
 * will delegate to it.
 */
describe('observation hook → outbox', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
  });

  afterEach(() => db.close());

  test('direct SQLite insert takes < 5ms', () => {
    const start = performance.now();

    db.prepare(`
      INSERT INTO outbox (content_session_id, message_type, tool_name, tool_input, tool_response, cwd, prompt_number, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-123', 'observation', 'Read', '{"file":"test.ts"}', '{"content":"..."}', '/project', 1, Date.now());

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });

  test('multiple concurrent inserts succeed', () => {
    const stmt = db.prepare(`
      INSERT INTO outbox (content_session_id, message_type, tool_name, cwd, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < 50; i++) {
      stmt.run(`sess-${i}`, 'observation', 'Read', '/project', Date.now());
    }

    const count = db.prepare('SELECT COUNT(*) as c FROM outbox').get() as { c: number };
    expect(count.c).toBe(50);
  });

  test('insert works even when worker tables are empty', () => {
    // Outbox is independent of worker state
    const result = db.prepare(`
      INSERT INTO outbox (content_session_id, message_type, tool_name, cwd, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-1', 'observation', 'Bash', '/test', Date.now());

    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it passes (it will — these test raw SQL)**

```bash
bun test tests/hooks/observation-outbox.test.ts
```

**Step 3: Rewrite the observation handler**

Replace the HTTP POST in `src/cli/handlers/observation.ts`:

```typescript
/**
 * Observation Handler - PostToolUse
 *
 * Writes tool usage directly to SQLite outbox for durable intake.
 * No worker dependency — observations are stored even if worker is down.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, getDbPath } from '../../shared/paths.js';
import { Database } from 'bun:sqlite';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);
    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`);

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Check if project is excluded
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.AI_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Write directly to outbox — no worker dependency
    try {
      const db = new Database(getDbPath(), { create: false });
      db.run('PRAGMA journal_mode = WAL');

      db.prepare(`
        INSERT INTO outbox (content_session_id, message_type, tool_name, tool_input, tool_response, cwd, prompt_number, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        'observation',
        toolName,
        typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput),
        typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse),
        cwd,
        input.promptNumber || null,
        Date.now()
      );

      db.close();
      logger.debug('HOOK', 'Observation queued to outbox', { toolName });
    } catch (error) {
      // Database write failed — log but don't block Claude
      logger.warn('HOOK', 'Outbox write failed, observation lost', {
        error: error instanceof Error ? error.message : String(error),
        toolName
      });
    }

    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
```

**Step 4: Remove unused imports**

The hook no longer needs `ensureWorkerRunning` or `getWorkerPort`. Remove those imports.

**Step 5: Run tests**

```bash
bun test tests/hooks/
bun test
```

**Step 6: Commit**

```bash
git add src/cli/handlers/observation.ts tests/hooks/observation-outbox.test.ts
git commit -m "feat: rewrite observation hook for direct SQLite outbox write"
```

---

## Task 4: Outbox Drain Loop in Worker

Add the poll-based drain loop to the worker service.

**Files:**
- Create: `src/services/worker/OutboxDrainer.ts`
- Test: `tests/worker/outbox-drainer.test.ts`

**Step 1: Write the failing test**

Create `tests/worker/outbox-drainer.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner';
import { OutboxStore } from '../../src/services/sqlite/OutboxStore';

describe('OutboxDrainer', () => {
  let db: Database;
  let outboxStore: OutboxStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA journal_mode = WAL');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    outboxStore = new OutboxStore(db);
  });

  afterEach(() => db.close());

  test('drainOnce() claims and processes pending items', async () => {
    // Seed outbox with items
    outboxStore.enqueue({
      contentSessionId: 'sess-1',
      toolName: 'Read',
      toolInput: '{"file":"test.ts"}',
      toolResponse: '{"content":"hello"}',
      cwd: '/project',
      promptNumber: 1,
    });

    // Verify item exists
    const stats = outboxStore.getStats();
    expect(stats.pending).toBe(1);

    // Claim the batch
    const batch = outboxStore.claimBatch(10);
    expect(batch.length).toBe(1);
    expect(batch[0].tool_name).toBe('Read');

    // Simulate successful processing
    outboxStore.confirmProcessed(batch[0].id);

    const afterStats = outboxStore.getStats();
    expect(afterStats.total).toBe(0);
  });

  test('failed items are retried up to 3 times', () => {
    const id = outboxStore.enqueue({
      contentSessionId: 'sess-1',
      toolName: 'Read',
      cwd: '/test',
      promptNumber: 1,
    });

    // Simulate 3 failed attempts
    for (let i = 0; i < 3; i++) {
      outboxStore.claimBatch(1);
      outboxStore.retryOrFail(id, `attempt ${i + 1}`);
    }

    let row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(3);

    // 4th attempt marks as failed
    outboxStore.claimBatch(1);
    outboxStore.retryOrFail(id, 'final');

    row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('failed');
  });

  test('stale processing items reset to pending', () => {
    const id = outboxStore.enqueue({
      contentSessionId: 'sess-1',
      toolName: 'Read',
      cwd: '/test',
      promptNumber: 1,
    });

    outboxStore.claimBatch(1);

    // Backdate to simulate staleness
    db.prepare('UPDATE outbox SET started_processing_at_epoch = ? WHERE id = ?')
      .run(Date.now() - 120_000, id);

    const reset = outboxStore.resetStaleProcessing(60_000);
    expect(reset).toBe(1);

    const row = db.prepare('SELECT status FROM outbox WHERE id = ?').get(id) as any;
    expect(row.status).toBe('pending');
  });
});
```

**Step 2: Run test to verify it passes (tests OutboxStore directly)**

```bash
bun test tests/worker/outbox-drainer.test.ts
```

**Step 3: Create OutboxDrainer**

Create `src/services/worker/OutboxDrainer.ts`:

```typescript
/**
 * OutboxDrainer — Polls the outbox table and processes pending observations.
 *
 * Runs in the worker process. Claims batches from the outbox, sends to
 * Anthropic API for observation extraction, stores results, then deletes
 * from outbox. Failed items retry 3 times, then stay with error_message.
 */

import { OutboxStore } from '../sqlite/OutboxStore.js';
import type { OutboxItem } from '../sqlite/OutboxStore.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 10;

export class OutboxDrainer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private outboxStore: OutboxStore,
    private processItem: (item: OutboxItem) => Promise<void>,
    private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private batchSize: number = DEFAULT_BATCH_SIZE,
  ) {}

  /**
   * Start the drain loop.
   */
  start(): void {
    if (this.timer) return;

    logger.info('OUTBOX', `Drain loop started (poll every ${this.pollIntervalMs}ms, batch size ${this.batchSize})`);

    this.timer = setInterval(() => {
      this.drainOnce().catch(error => {
        logger.error('OUTBOX', 'Drain cycle failed', {}, error as Error);
      });
    }, this.pollIntervalMs);

    // Don't prevent process exit
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stop the drain loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('OUTBOX', 'Drain loop stopped');
    }
  }

  /**
   * Run one drain cycle: claim batch, process each item, handle results.
   */
  async drainOnce(): Promise<number> {
    const batch = this.outboxStore.claimBatch(this.batchSize);
    if (batch.length === 0) return 0;

    logger.debug('OUTBOX', `Processing batch of ${batch.length} items`);

    let processed = 0;

    for (const item of batch) {
      try {
        await this.processItem(item);
        this.outboxStore.confirmProcessed(item.id);
        processed++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn('OUTBOX', `Item ${item.id} failed: ${errorMsg}`, { toolName: item.tool_name });
        this.outboxStore.retryOrFail(item.id, errorMsg);
      }
    }

    logger.debug('OUTBOX', `Batch complete: ${processed}/${batch.length} succeeded`);
    return processed;
  }

  /**
   * Check if the drain loop is running.
   */
  isRunning(): boolean {
    return this.timer !== null;
  }
}
```

**Step 4: Run tests**

```bash
bun test tests/worker/outbox-drainer.test.ts
```

**Step 5: Commit**

```bash
git add src/services/worker/OutboxDrainer.ts tests/worker/outbox-drainer.test.ts
git commit -m "feat: add OutboxDrainer poll loop for worker-side processing"
```

---

## Task 5: Wire OutboxDrainer into Worker Service

Connect the drain loop to the worker's background initialization.

**Files:**
- Modify: `src/services/worker-service.ts`

**Step 1: Add OutboxDrainer to worker**

In `initializeBackground()`, after database initialization:

```typescript
import { OutboxDrainer } from './worker/OutboxDrainer.js';
import { OutboxStore } from './sqlite/OutboxStore.js';

// In initializeBackground():
const outboxStore = new OutboxStore(dbManager.getSessionStore().getDb());
this.outboxDrainer = new OutboxDrainer(outboxStore, async (item) => {
  // Process item through the existing observation pipeline
  // This delegates to the same ApiAgent/ResponseProcessor flow
  await this.processOutboxItem(item);
});
this.outboxDrainer.start();
```

Add cleanup in shutdown:
```typescript
if (this.outboxDrainer) {
  this.outboxDrainer.stop();
}
```

**Step 2: Implement processOutboxItem()**

This method bridges the outbox item to the existing observation extraction pipeline. It should:
1. Find or create the session in sdk_sessions
2. Build the message payload from outbox fields
3. Send to ApiAgent for extraction
4. Store observations (which triggers FTS5 and embeddings via existing flow)

**Step 3: Run tests**

```bash
bun test
```

**Step 4: Commit**

```bash
git add src/services/worker-service.ts
git commit -m "feat: wire OutboxDrainer into worker background initialization"
```

---

## Task 6: Remove PendingMessageStore

The outbox replaces PendingMessageStore entirely.

**Files:**
- Delete: `src/services/sqlite/PendingMessageStore.ts`
- Delete: `tests/services/sqlite/PendingMessageStore.test.ts`
- Modify: Any files importing PendingMessageStore

**Step 1: Find all references**

```bash
grep -r "PendingMessageStore\|pending_messages" src/ --include="*.ts" -l
```

**Step 2: Remove imports and usage**

Update each file that references PendingMessageStore to use OutboxStore instead, or remove the reference if it's no longer needed.

**Step 3: Delete the files**

```bash
git rm src/services/sqlite/PendingMessageStore.ts
git rm tests/services/sqlite/PendingMessageStore.test.ts
```

**Step 4: Run tests**

```bash
bun test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove PendingMessageStore, replaced by OutboxStore"
```

---

## Task 7: Remove ensureWorkerRunning from Hook Path

Hooks no longer need the worker to be running for observation writes.

**Files:**
- Modify: Files that call `ensureWorkerRunning()` in the hook path

**Step 1: Audit ensureWorkerRunning usage**

```bash
grep -r "ensureWorkerRunning" src/ --include="*.ts" -l
```

The observation handler already removed this in Task 3. Check if other hooks still need it (SessionStart, Summary may still use HTTP for other purposes).

**Step 2: Remove from hooks that only write observations**

Keep `ensureWorkerRunning()` for hooks that genuinely need the worker (e.g., context generation that reads from the worker HTTP API). Remove it only from observation-write paths.

**Step 3: Run tests**

```bash
bun test
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove ensureWorkerRunning from observation hook path"
```

---

## Task 8: Build and Verify

**Step 1: Build**

```bash
npm run build
```

**Step 2: Run full test suite**

```bash
bun test
```

**Step 3: Manual verification**

```bash
# Start worker
bun run src/services/worker-service.ts &
sleep 3

# Check outbox stats
curl -s http://localhost:37777/api/health | jq

# Stop worker
kill %1
```

**Step 4: Final commit and push**

```bash
git add -A
git commit -m "build: verify plugin build after outbox integration"
git push origin feature/outbox
```

---

## Summary

| Task | Description | Key Change |
|------|-------------|------------|
| 1 | Migration 25: outbox table | runner.ts |
| 2 | OutboxStore (data access) | New file ~180 LOC |
| 3 | Rewrite observation hook | HTTP POST → SQLite INSERT |
| 4 | OutboxDrainer (poll loop) | New file ~100 LOC |
| 5 | Wire into worker service | worker-service.ts |
| 6 | Delete PendingMessageStore | ~490 LOC removed |
| 7 | Remove ensureWorkerRunning | Hook cleanup |
| 8 | Build and verify | End-to-end check |

**Key property:** Hook never talks to the worker. Hook → SQLite → done. Worker drains independently.
