/**
 * SearchOrchestrator - Coordinates search strategies and handles routing
 *
 * This is the main entry point for search operations. It:
 * 1. Normalizes input parameters
 * 2. Routes to the appropriate search path
 * 3. Delegates to formatters for output
 *
 * Observation text search uses the SQLite-native search module (fts5/vector/hybrid).
 * Filter-only, session, and prompt searches use SQLiteSearchStrategy.
 */

import type { Database } from 'bun:sqlite';
import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';

import { search as searchObservations } from '../../search/index.js';

import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';

import { ResultFormatter } from './ResultFormatter.js';
import { TimelineBuilder } from './TimelineBuilder.js';
import type { TimelineItem, TimelineData } from './TimelineBuilder.js';

import {
  SEARCH_CONSTANTS,
} from './types.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  SearchResults,
  ObservationSearchResult
} from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Normalized parameters from URL-friendly format
 */
interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private sqliteStrategy: SQLiteSearchStrategy;
  private resultFormatter: ResultFormatter;
  private timelineBuilder: TimelineBuilder;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private db: Database | null
  ) {
    // Initialize strategies
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    this.resultFormatter = new ResultFormatter();
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    // Decision tree for strategy selection
    return await this.executeSearch(options);
  }

  /**
   * Execute search based on query type
   */
  private async executeSearch(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    // PATH 1: FILTER-ONLY (no query text) - Use SQLite strategy
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      return await this.sqliteStrategy.search(options);
    }

    // PATH 2: TEXT SEARCH - Use new SQLite-native search module
    if (this.db) {
      logger.debug('SEARCH', 'Orchestrator: Using SQLite-native search', {});
      try {
        const results = await searchObservations(this.db, {
          query: options.query,
          mode: 'hybrid',
          limit: options.limit || SEARCH_CONSTANTS.DEFAULT_LIMIT,
          offset: options.offset || 0,
          project: options.project,
          type: options.obsType,
        });

        // Convert SearchResult[] from new module to ObservationSearchResult[]
        // The new module returns lightweight results (id, score, title, type, project, created_at_epoch).
        // Hydrate from SessionStore if needed by callers, but for now map to the expected shape.
        const observations: ObservationSearchResult[] = results.map(r => ({
          id: r.id,
          memory_session_id: '',
          project: r.project || '',
          text: '',
          type: r.type || '',
          title: r.title || '',
          subtitle: '',
          facts: '[]',
          narrative: '',
          concepts: '[]',
          files_read: '[]',
          files_modified: '[]',
          prompt_number: 0,
          discovery_tokens: 0,
          created_at: '',
          created_at_epoch: r.created_at_epoch || 0,
        }));

        return {
          results: { observations, sessions: [], prompts: [] },
          fellBack: false,
          strategy: 'sqlite'
        };
      } catch (error) {
        logger.error('SEARCH', 'Orchestrator: SQLite-native search failed', {}, error as Error);
        // Fall back to filter-only
        const fallbackResult = await this.sqliteStrategy.search({
          ...options,
          query: undefined
        });
        return {
          ...fallbackResult,
          fellBack: true
        };
      }
    }

    // PATH 3: No database available
    logger.debug('SEARCH', 'Orchestrator: No database available', {});
    return {
      results: { observations: [], sessions: [], prompts: [] },
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by concept
   */
  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by type
   */
  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by file
   */
  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
  }> {
    const options = this.normalizeParams(args);

    return this.sqliteStrategy.findByFile(filePath, options);
  }

  /**
   * Get timeline around anchor
   */
  getTimeline(
    timelineData: TimelineData,
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    const items = this.timelineBuilder.buildTimeline(timelineData);
    return this.timelineBuilder.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);
  }

  /**
   * Format timeline for display
   */
  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: {
      query?: string;
      depthBefore?: number;
      depthAfter?: number;
    } = {}
  ): string {
    return this.timelineBuilder.formatTimeline(items, anchorId, options);
  }

  /**
   * Format search results for display
   */
  formatSearchResults(
    results: SearchResults,
    query: string,
    searchFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, searchFailed);
  }

  /**
   * Get result formatter for direct access
   */
  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  /**
   * Get timeline builder for direct access
   */
  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Map 'type' param to 'searchType' for API consistency
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }
}
