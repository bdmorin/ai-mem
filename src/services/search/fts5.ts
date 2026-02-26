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
      const ch = query[i];
      if (/[a-zA-Z0-9_*]/.test(ch)) {
        word += ch;
      } else if (word) {
        // Punctuation acts as a word boundary — flush current word
        tokens.push(word);
        word = '';
      }
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
export function buildMetadataFilter(options: SearchOptions): { clause: string; params: any[] } {
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
