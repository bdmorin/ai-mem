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
