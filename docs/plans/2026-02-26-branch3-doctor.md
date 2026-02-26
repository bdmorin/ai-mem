# Branch 3: `aim doctor --fix` — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a diagnostic CLI command that checks all ai-mem subsystems and can auto-repair common issues. Think `brew doctor` meets `git fsck` — inspect, report, fix.

**Architecture:** Nine check modules in `src/cli/doctor/`, each self-contained with a `check()` and optional `fix()` method. A runner invokes all modules, collects results, formats output. CLI flags: `--fix`, `--fix --force`, `--dry-run`, `--check <category>`.

**Tech Stack:** bun:sqlite, node:fs, node:child_process (for process checks)

**Design Doc:** `docs/plans/2026-02-26-reliability-overhaul-design.md` (Branch 3 section)
**Depends On:** Branches 1 (search) and 2 (outbox) must be merged first — doctor checks FTS5, embeddings, and outbox subsystems.

---

## Pre-Flight

Branch from main (after search + outbox are merged):

```bash
git checkout -b feature/doctor main
```

---

## Task 1: Doctor Interfaces and Runner

Define the shared interfaces and the runner that orchestrates all check modules.

**Files:**
- Create: `src/cli/doctor/types.ts`
- Create: `src/cli/doctor/runner.ts`
- Create: `src/cli/doctor/formatter.ts`
- Test: `tests/cli/doctor/runner.test.ts`

**Step 1: Write the failing test**

Create `tests/cli/doctor/runner.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import type { CheckModule, DiagnosticResult, FixResult } from '../../../src/cli/doctor/types';
import { DoctorRunner } from '../../../src/cli/doctor/runner';

// Mock check module for testing
const mockPassModule: CheckModule = {
  name: 'mock-pass',
  category: 'test',
  check: () => [
    { name: 'mock-check', category: 'test', severity: 'pass', message: 'All good', fixable: false },
  ],
};

const mockWarnModule: CheckModule = {
  name: 'mock-warn',
  category: 'test',
  check: () => [
    { name: 'mock-warn-check', category: 'test', severity: 'warn', message: 'Minor issue', fixable: true, fixDescription: 'Fix the thing' },
  ],
  fix: () => [
    { name: 'mock-warn-check', success: true, message: 'Fixed' },
  ],
};

const mockErrorModule: CheckModule = {
  name: 'mock-error',
  category: 'test',
  check: () => [
    { name: 'mock-error-check', category: 'test', severity: 'error', message: 'Broken', fixable: true, fixDescription: 'Repair it' },
  ],
  fix: () => [
    { name: 'mock-error-check', success: true, message: 'Repaired' },
  ],
};

const mockFatalModule: CheckModule = {
  name: 'mock-fatal',
  category: 'test',
  check: () => [
    { name: 'mock-fatal-check', category: 'test', severity: 'fatal', message: 'Data at risk', fixable: true, fixDescription: 'Rebuild index' },
  ],
  fix: () => [
    { name: 'mock-fatal-check', success: true, message: 'Rebuilt' },
  ],
};

describe('DoctorRunner', () => {
  test('runs all modules and collects results', () => {
    const runner = new DoctorRunner([mockPassModule, mockWarnModule]);
    const report = runner.runChecks();

    expect(report.results.length).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.warnings).toBe(1);
  });

  test('--fix repairs WARN and ERROR items', () => {
    const runner = new DoctorRunner([mockWarnModule, mockErrorModule]);
    const report = runner.runChecks();
    const fixes = runner.runFixes(report.results, { fix: true, force: false });

    expect(fixes.length).toBe(2);
    expect(fixes.every(f => f.success)).toBe(true);
  });

  test('--fix does NOT repair FATAL without --force', () => {
    const runner = new DoctorRunner([mockFatalModule]);
    const report = runner.runChecks();
    const fixes = runner.runFixes(report.results, { fix: true, force: false });

    expect(fixes.length).toBe(0);
  });

  test('--fix --force repairs FATAL items', () => {
    const runner = new DoctorRunner([mockFatalModule]);
    const report = runner.runChecks();
    const fixes = runner.runFixes(report.results, { fix: true, force: true });

    expect(fixes.length).toBe(1);
    expect(fixes[0].success).toBe(true);
  });

  test('--check filters to specific category', () => {
    const runner = new DoctorRunner([mockPassModule, mockWarnModule]);
    const report = runner.runChecks('test');

    expect(report.results.length).toBe(2); // Both are category 'test'
  });

  test('--dry-run reports what --fix would do without doing it', () => {
    const runner = new DoctorRunner([mockWarnModule, mockErrorModule]);
    const report = runner.runChecks();
    const dryRun = runner.dryRun(report.results);

    expect(dryRun.length).toBe(2);
    expect(dryRun[0].fixDescription).toBeDefined();
  });

  test('summary counts are correct', () => {
    const runner = new DoctorRunner([mockPassModule, mockWarnModule, mockErrorModule, mockFatalModule]);
    const report = runner.runChecks();

    expect(report.summary.passed).toBe(1);
    expect(report.summary.warnings).toBe(1);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.fatals).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/cli/doctor/runner.test.ts
```

**Step 3: Create types**

Create `src/cli/doctor/types.ts`:

```typescript
export interface DiagnosticResult {
  name: string;
  category: string;
  severity: 'pass' | 'warn' | 'error' | 'fatal';
  message: string;
  fixable: boolean;
  fixDescription?: string;
}

export interface FixResult {
  name: string;
  success: boolean;
  message: string;
}

export interface CheckModule {
  name: string;
  category: string;
  check(context?: any): DiagnosticResult[];
  fix?(results: DiagnosticResult[], context?: any): FixResult[];
}

export interface DoctorReport {
  results: DiagnosticResult[];
  summary: {
    passed: number;
    warnings: number;
    errors: number;
    fatals: number;
  };
}

export interface FixOptions {
  fix: boolean;
  force: boolean;
}
```

**Step 4: Create the runner**

Create `src/cli/doctor/runner.ts`:

```typescript
import type { CheckModule, DiagnosticResult, FixResult, DoctorReport, FixOptions } from './types';

export class DoctorRunner {
  constructor(private modules: CheckModule[]) {}

  /**
   * Run all checks (optionally filtered by category).
   */
  runChecks(category?: string): DoctorReport {
    const modules = category
      ? this.modules.filter(m => m.category === category)
      : this.modules;

    const results: DiagnosticResult[] = [];

    for (const mod of modules) {
      try {
        const moduleResults = mod.check();
        results.push(...moduleResults);
      } catch (error) {
        results.push({
          name: `${mod.name}-crash`,
          category: mod.category,
          severity: 'error',
          message: `Check module crashed: ${error instanceof Error ? error.message : String(error)}`,
          fixable: false,
        });
      }
    }

    return {
      results,
      summary: this.computeSummary(results),
    };
  }

  /**
   * Run fixes for diagnostic results.
   * WARN and ERROR are fixed with --fix.
   * FATAL requires --fix --force.
   */
  runFixes(results: DiagnosticResult[], options: FixOptions): FixResult[] {
    const fixes: FixResult[] = [];

    // Group fixable results by category
    const fixableByCategory = new Map<string, DiagnosticResult[]>();
    for (const r of results) {
      if (!r.fixable) continue;
      if (r.severity === 'pass') continue;
      if (r.severity === 'fatal' && !options.force) continue;

      const existing = fixableByCategory.get(r.category) || [];
      existing.push(r);
      fixableByCategory.set(r.category, existing);
    }

    // Run fixes per module
    for (const mod of this.modules) {
      const fixableResults = fixableByCategory.get(mod.category);
      if (!fixableResults || fixableResults.length === 0) continue;
      if (!mod.fix) continue;

      try {
        const moduleFixResults = mod.fix(fixableResults);
        fixes.push(...moduleFixResults);
      } catch (error) {
        fixes.push({
          name: `${mod.name}-fix-crash`,
          success: false,
          message: `Fix crashed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return fixes;
  }

  /**
   * Report what --fix would do without doing it.
   */
  dryRun(results: DiagnosticResult[]): DiagnosticResult[] {
    return results.filter(r =>
      r.fixable && r.severity !== 'pass'
    );
  }

  private computeSummary(results: DiagnosticResult[]) {
    return {
      passed: results.filter(r => r.severity === 'pass').length,
      warnings: results.filter(r => r.severity === 'warn').length,
      errors: results.filter(r => r.severity === 'error').length,
      fatals: results.filter(r => r.severity === 'fatal').length,
    };
  }
}
```

**Step 5: Create the formatter**

Create `src/cli/doctor/formatter.ts`:

```typescript
import type { DiagnosticResult, FixResult, DoctorReport } from './types';

const SEVERITY_ICONS: Record<string, string> = {
  pass: '  ✓',
  warn: '  !',
  error: '  ✗',
  fatal: '  ✗✗',
};

/**
 * Format doctor report for terminal output.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  // Group by category
  const byCategory = new Map<string, DiagnosticResult[]>();
  for (const r of report.results) {
    const existing = byCategory.get(r.category) || [];
    existing.push(r);
    byCategory.set(r.category, existing);
  }

  for (const [category, results] of byCategory) {
    lines.push('');
    lines.push(`  ${capitalizeFirst(category)}`);

    for (const r of results) {
      const icon = SEVERITY_ICONS[r.severity] || '  ?';
      lines.push(`${icon} ${r.message}`);

      if (r.fixable && r.severity !== 'pass' && r.fixDescription) {
        lines.push(`    → fix: ${r.fixDescription}`);
      }
    }
  }

  // Summary
  const s = report.summary;
  lines.push('');
  lines.push('  ' + '─'.repeat(30));
  const parts: string[] = [];
  if (s.passed > 0) parts.push(`${s.passed} passed`);
  if (s.warnings > 0) parts.push(`${s.warnings} warning${s.warnings !== 1 ? 's' : ''}`);
  if (s.errors > 0) parts.push(`${s.errors} error${s.errors !== 1 ? 's' : ''}`);
  if (s.fatals > 0) parts.push(`${s.fatals} fatal`);
  lines.push(`  ${parts.join(', ')}`);

  if (s.errors > 0 || s.warnings > 0) {
    lines.push('  Run `aim doctor --fix` to repair');
  }
  if (s.fatals > 0) {
    lines.push('  Run `aim doctor --fix --force` for fatal issues');
  }

  return lines.join('\n');
}

/**
 * Format fix results for terminal output.
 */
export function formatFixResults(fixes: FixResult[]): string {
  const lines: string[] = ['', '  Fix Results:'];

  for (const f of fixes) {
    const icon = f.success ? '  ✓' : '  ✗';
    lines.push(`${icon} ${f.name}: ${f.message}`);
  }

  return lines.join('\n');
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

**Step 6: Run test to verify it passes**

```bash
bun test tests/cli/doctor/runner.test.ts
```

**Step 7: Commit**

```bash
git add src/cli/doctor/types.ts src/cli/doctor/runner.ts src/cli/doctor/formatter.ts tests/cli/doctor/runner.test.ts
git commit -m "feat: add doctor runner, types, and formatter"
```

---

## Task 2: Check Module — Database

**Files:**
- Create: `src/cli/doctor/checks/database.ts`
- Test: `tests/cli/doctor/checks/database.test.ts`

**Step 1: Write the failing test**

Create `tests/cli/doctor/checks/database.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { databaseCheck } from '../../../../src/cli/doctor/checks/database';
import { MigrationRunner } from '../../../../src/services/sqlite/migrations/runner';

describe('doctor: database check', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
  });

  afterEach(() => db.close());

  test('passes on healthy database', () => {
    db.run('PRAGMA journal_mode = WAL');
    const results = databaseCheck.check({ db });
    const severities = results.map(r => r.severity);
    expect(severities).not.toContain('error');
    expect(severities).not.toContain('fatal');
  });

  test('warns if WAL mode not enabled', () => {
    // In-memory databases are journal_mode=memory, not WAL
    // Create a non-WAL database scenario
    const results = databaseCheck.check({ db });
    const walResult = results.find(r => r.name === 'database-wal-mode');
    // In-memory DB won't be WAL — this tests the detection
    expect(walResult).toBeDefined();
  });

  test('reports schema version', () => {
    const results = databaseCheck.check({ db });
    const versionResult = results.find(r => r.name === 'database-schema-version');
    expect(versionResult).toBeDefined();
    expect(versionResult?.severity).toBe('pass');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/cli/doctor/checks/database.test.ts
```

**Step 3: Implement database check**

Create `src/cli/doctor/checks/database.ts`:

```typescript
import type { CheckModule, DiagnosticResult, FixResult } from '../types';

export const databaseCheck: CheckModule = {
  name: 'database',
  category: 'database',

  check(context?: { db: any }): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const db = context?.db;

    if (!db) {
      results.push({ name: 'database-connection', category: 'database', severity: 'fatal', message: 'Database not accessible', fixable: false });
      return results;
    }

    // Integrity check
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check === 'ok') {
        results.push({ name: 'database-integrity', category: 'database', severity: 'pass', message: 'Integrity check passed', fixable: false });
      } else {
        results.push({ name: 'database-integrity', category: 'database', severity: 'fatal', message: `Integrity check failed: ${integrity.integrity_check}`, fixable: false });
      }
    } catch (error) {
      results.push({ name: 'database-integrity', category: 'database', severity: 'fatal', message: `Integrity check error: ${error}`, fixable: false });
    }

    // Foreign key check
    try {
      const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
      if (fkErrors.length === 0) {
        results.push({ name: 'database-fk-check', category: 'database', severity: 'pass', message: 'Foreign key check passed', fixable: false });
      } else {
        results.push({ name: 'database-fk-check', category: 'database', severity: 'error', message: `${fkErrors.length} foreign key violations`, fixable: false });
      }
    } catch {
      // FK check not critical
    }

    // WAL mode
    try {
      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      if (journal.journal_mode === 'wal') {
        results.push({ name: 'database-wal-mode', category: 'database', severity: 'pass', message: 'WAL mode enabled', fixable: false });
      } else {
        results.push({ name: 'database-wal-mode', category: 'database', severity: 'warn', message: `Journal mode is ${journal.journal_mode}, not WAL`, fixable: true, fixDescription: 'Enable WAL mode' });
      }
    } catch {
      // Skip
    }

    // Schema version
    try {
      const versions = db.prepare('SELECT MAX(version) as max_version FROM schema_versions').get() as { max_version: number };
      results.push({ name: 'database-schema-version', category: 'database', severity: 'pass', message: `Schema version ${versions.max_version}`, fixable: false });
    } catch {
      results.push({ name: 'database-schema-version', category: 'database', severity: 'error', message: 'Cannot read schema version', fixable: false });
    }

    return results;
  },

  fix(results: DiagnosticResult[], context?: { db: any }): FixResult[] {
    const fixes: FixResult[] = [];
    const db = context?.db;
    if (!db) return fixes;

    const walResult = results.find(r => r.name === 'database-wal-mode');
    if (walResult && walResult.severity !== 'pass') {
      try {
        db.run('PRAGMA journal_mode = WAL');
        fixes.push({ name: 'database-wal-mode', success: true, message: 'WAL mode enabled' });
      } catch (error) {
        fixes.push({ name: 'database-wal-mode', success: false, message: `Failed: ${error}` });
      }
    }

    return fixes;
  },
};
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/cli/doctor/checks/database.test.ts
```

**Step 5: Commit**

```bash
git add src/cli/doctor/checks/database.ts tests/cli/doctor/checks/database.test.ts
git commit -m "feat: add doctor database check module"
```

---

## Task 3: Check Modules — FTS5, Embeddings, Outbox

These three check the subsystems from Branches 1 and 2.

**Files:**
- Create: `src/cli/doctor/checks/fts5.ts`
- Create: `src/cli/doctor/checks/embeddings.ts`
- Create: `src/cli/doctor/checks/outbox.ts`
- Test: `tests/cli/doctor/checks/fts5.test.ts`
- Test: `tests/cli/doctor/checks/embeddings.test.ts`
- Test: `tests/cli/doctor/checks/outbox.test.ts`

**Step 1: Write tests for each**

Each test follows the same pattern: create an in-memory DB, run migrations, seed data, run checks, verify results.

**fts5.test.ts** key scenarios:
- FTS5 table exists → pass
- FTS5 row count matches observations → pass
- FTS5 row count mismatch → error + fixable (rebuild FTS5 index)
- FTS5 triggers present → pass

**embeddings.test.ts** key scenarios:
- Embedding count matches observations → pass
- Missing embeddings → error + fixable (generate missing)
- Model mismatch → warn + fixable (re-embed all)

**outbox.test.ts** key scenarios:
- Queue empty → pass
- Queue has pending items → warn (report depth)
- Stuck processing items → error + fixable (reset to pending)
- Failed items → warn (report count)

**Step 2: Implement each module**

Each module follows the CheckModule interface. Key implementations:

**fts5.ts:**
```typescript
// check: Compare COUNT(*) FROM observations_fts vs COUNT(*) FROM observations
// fix: DELETE FROM observations_fts; INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
```

**embeddings.ts:**
```typescript
// check: Compare COUNT(*) FROM observation_embeddings vs COUNT(*) FROM observations
// check: Read embedding_metadata.current_model vs AI_MEM_EMBEDDING_MODEL setting
// fix: Generate missing embeddings using embed() function
```

**outbox.ts:**
```typescript
// check: Use OutboxStore.getStats()
// fix: OutboxStore.resetStaleProcessing() for stuck items
// fix: DELETE FROM outbox WHERE status='failed' AND failed_at_epoch < (now - 7 days)
```

**Step 3: Run tests**

```bash
bun test tests/cli/doctor/checks/
```

**Step 4: Commit**

```bash
git add src/cli/doctor/checks/fts5.ts src/cli/doctor/checks/embeddings.ts src/cli/doctor/checks/outbox.ts
git add tests/cli/doctor/checks/
git commit -m "feat: add doctor check modules for fts5, embeddings, outbox"
```

---

## Task 4: Check Modules — Worker, Settings, Directories, Logs, Plugin

The remaining five check modules.

**Files:**
- Create: `src/cli/doctor/checks/worker.ts`
- Create: `src/cli/doctor/checks/settings.ts`
- Create: `src/cli/doctor/checks/directories.ts`
- Create: `src/cli/doctor/checks/logs.ts`
- Create: `src/cli/doctor/checks/plugin.ts`
- Tests for each

**Key implementations:**

**worker.ts:**
```typescript
// check: Read PID file, verify process exists (process.kill(pid, 0))
// check: HTTP health check to WORKER_HOST:WORKER_PORT
// fix: Remove stale PID file
```

**settings.ts:**
```typescript
// check: Settings file exists, valid JSON, no deprecated keys (AI_MEM_CHROMA_*)
// fix: Create defaults, remove deprecated keys
```

**directories.ts:**
```typescript
// check: Data dirs exist and writable, no stale PID/socket files
// fix: Create missing dirs, remove stale files
```

**logs.ts:**
```typescript
// check: Total log size, individual file sizes, old files
// fix: Delete logs older than 30 days
```

**plugin.ts:**
```typescript
// check: Plugin installed at expected path, hook scripts present, version match
// No fix — report only
```

**Step 1: Write tests, implement modules**

Follow the TDD pattern for each: test first, implement, verify.

**Step 2: Run all tests**

```bash
bun test tests/cli/doctor/
```

**Step 3: Commit**

```bash
git add src/cli/doctor/checks/ tests/cli/doctor/checks/
git commit -m "feat: add doctor check modules for worker, settings, directories, logs, plugin"
```

---

## Task 5: Register All Modules and Create Index

Wire all nine check modules into the runner.

**Files:**
- Create: `src/cli/doctor/index.ts`

**Step 1: Create the index**

Create `src/cli/doctor/index.ts`:

```typescript
import type { CheckModule } from './types';
import { databaseCheck } from './checks/database';
import { fts5Check } from './checks/fts5';
import { embeddingsCheck } from './checks/embeddings';
import { outboxCheck } from './checks/outbox';
import { workerCheck } from './checks/worker';
import { settingsCheck } from './checks/settings';
import { directoriesCheck } from './checks/directories';
import { logsCheck } from './checks/logs';
import { pluginCheck } from './checks/plugin';

export const ALL_CHECK_MODULES: CheckModule[] = [
  workerCheck,
  databaseCheck,
  fts5Check,
  embeddingsCheck,
  outboxCheck,
  settingsCheck,
  directoriesCheck,
  logsCheck,
  pluginCheck,
];

export { DoctorRunner } from './runner';
export { formatDoctorReport, formatFixResults } from './formatter';
export type { DiagnosticResult, FixResult, DoctorReport, CheckModule } from './types';
```

**Step 2: Commit**

```bash
git add src/cli/doctor/index.ts
git commit -m "feat: register all doctor check modules"
```

---

## Task 6: Add `doctor` Command to aim CLI

Wire the doctor command into the existing `aim` CLI.

**Files:**
- Modify: `src/cli/aim.ts`
- Test: `tests/cli/aim.test.ts`

**Step 1: Update parseArgs to handle doctor flags**

Add to `ParsedArgs`:
```typescript
export interface ParsedArgs {
  command: string;
  query?: string;
  last?: string;
  project?: string;
  limit?: number;
  // Doctor flags
  fix?: boolean;
  force?: boolean;
  dryRun?: boolean;
  check?: string;
}
```

Add `'doctor'` case to the switch in `parseArgs()`:
```typescript
case 'doctor': {
  let i = 1;
  while (i < args.length) {
    if (args[i] === '--fix') { result.fix = true; i++; }
    else if (args[i] === '--force') { result.force = true; i++; }
    else if (args[i] === '--dry-run') { result.dryRun = true; i++; }
    else if (args[i] === '--check' && i + 1 < args.length) { result.check = args[i + 1]; i += 2; }
    else { i++; }
  }
  break;
}
```

**Step 2: Implement execDoctor**

```typescript
async function execDoctor(parsed: ParsedArgs): Promise<void> {
  const { DoctorRunner, ALL_CHECK_MODULES, formatDoctorReport, formatFixResults } from './doctor';
  const { Database } from 'bun:sqlite';
  const { getDbPath } from '../shared/paths';

  // Open database for checks
  let db: Database | null = null;
  try {
    db = new Database(getDbPath(), { readonly: !parsed.fix });
  } catch {
    // DB might not exist yet
  }

  const context = { db };
  const runner = new DoctorRunner(ALL_CHECK_MODULES);

  // Run checks
  const report = runner.runChecks(parsed.check);
  console.log(formatDoctorReport(report));

  // Handle flags
  if (parsed.dryRun) {
    const fixable = runner.dryRun(report.results);
    if (fixable.length > 0) {
      console.log('\n  Dry run — these would be fixed:');
      for (const f of fixable) {
        console.log(`    → ${f.fixDescription}`);
      }
    }
  } else if (parsed.fix) {
    const fixes = runner.runFixes(report.results, { fix: true, force: !!parsed.force });
    if (fixes.length > 0) {
      console.log(formatFixResults(fixes));
    }
  }

  db?.close();
}
```

**Step 3: Add to main switch and help text**

**Step 4: Write tests for arg parsing**

Add to `tests/cli/aim.test.ts`:

```typescript
describe('doctor command parsing', () => {
  test('parses basic doctor command', () => {
    const result = parseArgs(['doctor']);
    expect(result.command).toBe('doctor');
  });

  test('parses --fix flag', () => {
    const result = parseArgs(['doctor', '--fix']);
    expect(result.fix).toBe(true);
  });

  test('parses --fix --force', () => {
    const result = parseArgs(['doctor', '--fix', '--force']);
    expect(result.fix).toBe(true);
    expect(result.force).toBe(true);
  });

  test('parses --dry-run', () => {
    const result = parseArgs(['doctor', '--dry-run']);
    expect(result.dryRun).toBe(true);
  });

  test('parses --check with category', () => {
    const result = parseArgs(['doctor', '--check', 'fts5']);
    expect(result.check).toBe('fts5');
  });
});
```

**Step 5: Run tests**

```bash
bun test tests/cli/aim.test.ts
bun test
```

**Step 6: Commit**

```bash
git add src/cli/aim.ts tests/cli/aim.test.ts
git commit -m "feat: add 'aim doctor' command with --fix/--force/--dry-run/--check flags"
```

---

## Task 7: Build and Verify

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
# Run doctor (worker doesn't need to be running)
bun run src/cli/aim.ts doctor

# Run with --dry-run
bun run src/cli/aim.ts doctor --dry-run

# Run with --fix
bun run src/cli/aim.ts doctor --fix

# Run specific check
bun run src/cli/aim.ts doctor --check database
```

**Step 4: Final commit and push**

```bash
git add -A
git commit -m "build: verify plugin build with doctor command"
git push origin feature/doctor
```

---

## Summary

| Task | Description | Files Created |
|------|-------------|---------------|
| 1 | Runner + types + formatter | 3 files + test |
| 2 | Database check module | 1 file + test |
| 3 | FTS5 + embeddings + outbox checks | 3 files + tests |
| 4 | Worker + settings + dirs + logs + plugin checks | 5 files + tests |
| 5 | Module registry (index.ts) | 1 file |
| 6 | Wire into aim CLI | Modify aim.ts |
| 7 | Build and verify | End-to-end check |

**Nine check modules:**
1. worker — process health
2. database — integrity, WAL, schema version
3. fts5 — index sync with observations
4. embeddings — count sync, model match
5. outbox — queue depth, stuck items
6. settings — file validity, deprecated keys
7. directories — data dirs, stale files
8. logs — size, age
9. plugin — installation check (report only)

**CLI interface:**
```
aim doctor              # run all checks
aim doctor --fix        # fix WARN + ERROR
aim doctor --fix --force  # also fix FATAL
aim doctor --dry-run    # show what --fix would do
aim doctor --check fts5 # run specific category
```
