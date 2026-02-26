/**
 * Search Types - Type definitions for the search module
 * Centralizes all search-related types, options, and result interfaces
 */

import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange } from '../../sqlite/types.js';

// Re-export base types for convenience
export type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult, SearchOptions, DateRange };

/**
 * Constants used across search strategies
 */
export const SEARCH_CONSTANTS = {
  RECENCY_WINDOW_DAYS: 90,
  RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000,
  DEFAULT_LIMIT: 20,
} as const;

/**
 * Unified search result type for all document types
 */
export type SearchResult = ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;

/**
 * Search results container with categorized results
 */
export interface SearchResults {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: UserPromptSearchResult[];
}

/**
 * Extended search options for the search module
 */
export interface ExtendedSearchOptions extends SearchOptions {
  /** Type filter for search API (observations, sessions, prompts) */
  searchType?: 'observations' | 'sessions' | 'prompts' | 'all';
  /** Observation type filter (decision, bugfix, feature, etc.) */
  obsType?: string | string[];
  /** Concept tags to filter by */
  concepts?: string | string[];
  /** File paths to filter by */
  files?: string | string[];
  /** Output format */
  format?: 'text' | 'json';
}

/**
 * Search strategy selection hint
 */
export type SearchStrategyHint = 'sqlite' | 'hybrid' | 'auto';

/**
 * Options passed to search strategies
 */
export interface StrategySearchOptions extends ExtendedSearchOptions {
  /** Query text for semantic search (optional for filter-only queries) */
  query?: string;
  /** Force a specific strategy */
  strategyHint?: SearchStrategyHint;
}

/**
 * Result from a search strategy
 */
export interface StrategySearchResult {
  results: SearchResults;
  /** Whether fallback was triggered */
  fellBack: boolean;
  /** Strategy that produced the results */
  strategy: SearchStrategyHint;
}

/**
 * Combined result type for timeline items
 */
export interface CombinedResult {
  type: 'observation' | 'session' | 'prompt';
  data: SearchResult;
  epoch: number;
  created_at: string;
}
