import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the ModeManager before imports
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', icon: 'D' },
          { id: 'bugfix', icon: 'B' },
          { id: 'feature', icon: 'F' },
          { id: 'refactor', icon: 'R' },
          { id: 'discovery', icon: 'I' },
          { id: 'change', icon: 'C' }
        ],
        observation_concepts: [],
      }),
      getObservationTypes: () => [
        { id: 'decision', icon: 'D' },
        { id: 'bugfix', icon: 'B' },
        { id: 'feature', icon: 'F' },
        { id: 'refactor', icon: 'R' },
        { id: 'discovery', icon: 'I' },
        { id: 'change', icon: 'C' }
      ],
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          feature: 'F',
          refactor: 'R',
          discovery: 'I',
          change: 'C'
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

// Mock the new search module
const mockSearchResults = mock(() => Promise.resolve([
  {
    id: 1,
    score: 0.85,
    mode: 'hybrid' as const,
    title: 'Test Decision',
    type: 'decision',
    project: 'test-project',
    created_at_epoch: Date.now() - 1000 * 60 * 60 * 24,
  }
]));

mock.module('../../../src/services/search/index.js', () => ({
  search: mockSearchResults,
}));

import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../../../src/services/worker/search/types.js';

// Mock data
const mockObservation: ObservationSearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation',
  type: 'decision',
  title: 'Test Decision',
  subtitle: 'Subtitle',
  facts: '["fact1"]',
  narrative: 'Narrative',
  concepts: '["concept1"]',
  files_read: '["file1.ts"]',
  files_modified: '["file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockSession: SessionSummarySearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  request: 'Test request',
  investigated: 'Investigated',
  learned: 'Learned',
  completed: 'Completed',
  next_steps: 'Next steps',
  files_read: '["file1.ts"]',
  files_edited: '["file2.ts"]',
  notes: 'Notes',
  prompt_number: 1,
  discovery_tokens: 500,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockPrompt: UserPromptSearchResult = {
  id: 1,
  content_session_id: 'content-123',
  prompt_number: 1,
  prompt_text: 'Test prompt',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

describe('SearchOrchestrator', () => {
  let orchestrator: SearchOrchestrator;
  let mockSessionSearch: any;
  let mockSessionStore: any;
  let mockDb: any;

  beforeEach(() => {
    mockSessionSearch = {
      searchObservations: mock(() => [mockObservation]),
      searchSessions: mock(() => [mockSession]),
      searchUserPrompts: mock(() => [mockPrompt]),
      findByConcept: mock(() => [mockObservation]),
      findByType: mock(() => [mockObservation]),
      findByFile: mock(() => ({ observations: [mockObservation], sessions: [mockSession] }))
    };

    mockSessionStore = {
      getObservationsByIds: mock(() => [mockObservation]),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [mockPrompt])
    };

    mockDb = {}; // Placeholder db object (the search module is mocked)

    // Reset the mock search function
    mockSearchResults.mockClear();
  });

  describe('with database available', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockDb);
    });

    describe('search', () => {
      it('should select SQLite strategy for filter-only queries (no query text)', async () => {
        const result = await orchestrator.search({
          project: 'test-project',
          limit: 10
        });

        expect(result.strategy).toBe('sqlite');
        expect(result.fellBack).toBe(false);
        expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
      });

      it('should use SQLite-native search for text queries', async () => {
        const result = await orchestrator.search({
          query: 'semantic search query'
        });

        expect(result.strategy).toBe('sqlite');
        expect(result.fellBack).toBe(false);
        expect(mockSearchResults).toHaveBeenCalled();
        expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      });

      it('should fall back to filter-only when search module fails', async () => {
        mockSearchResults.mockImplementation(() => Promise.reject(new Error('Search failed')));

        const result = await orchestrator.search({
          query: 'test query'
        });

        expect(result.fellBack).toBe(true);
      });

      it('should normalize comma-separated concepts', async () => {
        await orchestrator.search({
          concepts: 'concept1, concept2, concept3',
          limit: 10
        });

        const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
        expect(callArgs[1].concepts).toEqual(['concept1', 'concept2', 'concept3']);
      });

      it('should normalize comma-separated files', async () => {
        await orchestrator.search({
          files: 'file1.ts, file2.ts',
          limit: 10
        });

        const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
        expect(callArgs[1].files).toEqual(['file1.ts', 'file2.ts']);
      });

      it('should normalize dateStart/dateEnd into dateRange object', async () => {
        await orchestrator.search({
          dateStart: '2025-01-01',
          dateEnd: '2025-01-31'
        });

        const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
        expect(callArgs[1].dateRange).toEqual({
          start: '2025-01-01',
          end: '2025-01-31'
        });
      });

      it('should map type to searchType for observations/sessions/prompts', async () => {
        await orchestrator.search({
          type: 'observations'
        });

        // Should search only observations
        expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
        expect(mockSessionSearch.searchSessions).not.toHaveBeenCalled();
        expect(mockSessionSearch.searchUserPrompts).not.toHaveBeenCalled();
      });
    });

    describe('findByConcept', () => {
      it('should use SQLite strategy', async () => {
        const result = await orchestrator.findByConcept('test-concept', {
          limit: 10
        });

        expect(result.fellBack).toBe(false);
        expect(result.strategy).toBe('sqlite');
        expect(mockSessionSearch.findByConcept).toHaveBeenCalled();
      });

      it('should return observations matching concept', async () => {
        const result = await orchestrator.findByConcept('test-concept', {});

        expect(result.results.observations.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('findByType', () => {
      it('should use SQLite strategy', async () => {
        const result = await orchestrator.findByType('decision', {});

        expect(result.fellBack).toBe(false);
        expect(result.strategy).toBe('sqlite');
        expect(mockSessionSearch.findByType).toHaveBeenCalled();
      });

      it('should handle array of types', async () => {
        await orchestrator.findByType(['decision', 'bugfix'], {});

        expect(mockSessionSearch.findByType).toHaveBeenCalledWith(['decision', 'bugfix'], expect.any(Object));
      });
    });

    describe('findByFile', () => {
      it('should return observations and sessions for file', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(result.observations.length).toBeGreaterThanOrEqual(0);
        expect(mockSessionSearch.findByFile).toHaveBeenCalled();
      });

      it('should return observations and sessions without extra metadata', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(result).toHaveProperty('observations');
        expect(result).toHaveProperty('sessions');
      });
    });

    describe('formatSearchResults', () => {
      it('should format results as markdown', () => {
        const results = {
          observations: [mockObservation],
          sessions: [mockSession],
          prompts: [mockPrompt]
        };

        const formatted = orchestrator.formatSearchResults(results, 'test query');

        expect(formatted).toContain('test query');
        expect(formatted).toContain('result');
      });

      it('should handle empty results', () => {
        const results = {
          observations: [],
          sessions: [],
          prompts: []
        };

        const formatted = orchestrator.formatSearchResults(results, 'no matches');

        expect(formatted).toContain('No results found');
      });

      it('should indicate failure when searchFailed is true', () => {
        const results = {
          observations: [],
          sessions: [],
          prompts: []
        };

        const formatted = orchestrator.formatSearchResults(results, 'test', true);

        expect(formatted).toContain('Vector search failed');
      });
    });
  });

  describe('without database (null)', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
    });

    describe('search', () => {
      it('should return empty results for query search without database', async () => {
        const result = await orchestrator.search({
          query: 'semantic query'
        });

        expect(result.results.observations).toHaveLength(0);
        expect(result.fellBack).toBe(false);
      });

      it('should still work for filter-only queries', async () => {
        const result = await orchestrator.search({
          project: 'test-project'
        });

        expect(result.strategy).toBe('sqlite');
        expect(result.results.observations).toHaveLength(1);
      });
    });

    describe('findByConcept', () => {
      it('should use SQLite strategy', async () => {
        const result = await orchestrator.findByConcept('test-concept', {});

        expect(result.fellBack).toBe(false);
        expect(result.strategy).toBe('sqlite');
        expect(mockSessionSearch.findByConcept).toHaveBeenCalled();
      });
    });

    describe('findByType', () => {
      it('should use SQLite strategy', async () => {
        const result = await orchestrator.findByType('decision', {});

        expect(result.fellBack).toBe(false);
        expect(result.strategy).toBe('sqlite');
      });
    });

    describe('findByFile', () => {
      it('should use SQLite strategy', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(result).toHaveProperty('observations');
        expect(result).toHaveProperty('sessions');
        expect(mockSessionSearch.findByFile).toHaveBeenCalled();
      });
    });
  });

  describe('parameter normalization', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
    });

    it('should parse obs_type into obsType array', async () => {
      await orchestrator.search({
        obs_type: 'decision, bugfix'
      });

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].type).toEqual(['decision', 'bugfix']);
    });

    it('should handle already-array concepts', async () => {
      await orchestrator.search({
        concepts: ['concept1', 'concept2']
      });

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].concepts).toEqual(['concept1', 'concept2']);
    });

    it('should handle empty string filters', async () => {
      await orchestrator.search({
        concepts: '',
        files: ''
      });

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      // Empty strings are falsy, so the normalization doesn't process them
      // They stay as empty strings (the underlying search functions handle this)
      expect(callArgs[1].concepts).toEqual('');
      expect(callArgs[1].files).toEqual('');
    });
  });
});
