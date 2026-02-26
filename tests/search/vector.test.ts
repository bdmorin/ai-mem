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
