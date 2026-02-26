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
async function searchHybrid(db: Database, options: SearchOptions): Promise<SearchResult[]> {
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
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'"
    ).all();
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

export { searchHybrid, computeRRF, RRF_K };
