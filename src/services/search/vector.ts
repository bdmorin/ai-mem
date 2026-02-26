/**
 * Vector similarity search using pure TypeScript cosine similarity.
 *
 * Strategy: metadata filter first (SQL), then load embeddings for candidates,
 * compute cosine similarity in-process, sort by score. No SQLite extensions needed.
 */

import type { Database } from 'bun:sqlite';
import type { SearchOptions, SearchResult } from './types';
import { embed, deserializeEmbedding, cosineSimilarity } from './embeddings';

/**
 * Build WHERE clause for candidate selection.
 *
 * Note: This duplicates filter logic from fts5.ts:buildMetadataFilter intentionally.
 * The fts5 version returns 'AND ...' (appends to a WHERE MATCH clause).
 * This version returns 'WHERE ...' (standalone clause for the vector query).
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
 *
 * Embeds the query text, loads candidate observation embeddings from SQLite
 * (filtered by metadata), computes cosine similarity for each, and returns
 * results sorted by descending score.
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
