/**
 * SQLite-native search engine.
 *
 * Public API: search(db, options) -> SearchResult[]
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

  // No query -> browse mode (date-sorted with metadata filters)
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
