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
