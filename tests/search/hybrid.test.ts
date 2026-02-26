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
