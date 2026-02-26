/**
 * Tests for aim CLI terminal formatters
 *
 * Validates that API responses are correctly formatted for terminal display
 * with proper ANSI color codes, table layout, and date grouping.
 */

import { describe, test, expect } from 'bun:test';
import {
  formatSearchResults,
  formatTimeline,
  formatStatus,
  formatSSEEvent,
  formatError,
  formatWorkerDown,
  ANSI,
} from '../../src/cli/formatters';

describe('formatSearchResults', () => {
  test('formats observations as a table with columns', () => {
    const result = formatSearchResults({
      observations: [
        {
          id: 42,
          type: 'discovery',
          title: 'Found auth pattern in middleware',
          project: 'ai-mem',
          created_at_epoch: 1700000000,
        },
        {
          id: 99,
          type: 'bugfix',
          title: 'Fixed null pointer in parser',
          project: 'web-app',
          created_at_epoch: 1700100000,
        },
      ],
    });

    // Should contain observation IDs
    expect(result).toContain('#42');
    expect(result).toContain('#99');
    // Should contain titles
    expect(result).toContain('Found auth pattern in middleware');
    expect(result).toContain('Fixed null pointer in parser');
    // Should contain projects
    expect(result).toContain('ai-mem');
    expect(result).toContain('web-app');
    // Should contain type names
    expect(result).toContain('discovery');
    expect(result).toContain('bugfix');
    // Should have header
    expect(result).toContain('Observations');
  });

  test('returns "no results" message for empty data', () => {
    const result = formatSearchResults({ observations: [] });
    expect(result).toContain('No results found');
  });

  test('handles missing optional fields gracefully', () => {
    const result = formatSearchResults({
      observations: [
        { id: 1, type: 'discovery', title: 'Test' },
      ],
    });
    expect(result).toContain('#1');
    expect(result).toContain('Test');
    // Should use fallback '--' for missing project and date
    expect(result).toContain('--');
  });

  test('formats session results alongside observations', () => {
    const result = formatSearchResults({
      observations: [
        { id: 1, type: 'discovery', title: 'Obs 1', project: 'proj' },
      ],
      sessions: [
        { id: 10, summary_text: 'Session about auth flow', project: 'proj', created_at_epoch: 1700000000 },
      ],
    });

    expect(result).toContain('Observations');
    expect(result).toContain('Sessions');
    expect(result).toContain('S10');
    expect(result).toContain('Session about auth flow');
  });

  test('formats prompt results', () => {
    const result = formatSearchResults({
      prompts: [
        { id: 5, prompt_text: 'Fix the auth bug in middleware', project: 'proj', created_at_epoch: 1700000000 },
      ],
    });

    expect(result).toContain('Prompts');
    expect(result).toContain('P5');
    expect(result).toContain('Fix the auth bug in middleware');
  });
});

describe('formatTimeline', () => {
  test('groups items by date with time and type', () => {
    const baseEpoch = new Date('2024-03-15T10:00:00Z').getTime();

    const result = formatTimeline({
      timeline: [
        {
          type: 'observation',
          data: { id: 1, type: 'discovery', title: 'Found something' },
          epoch: baseEpoch,
        },
        {
          type: 'observation',
          data: { id: 2, type: 'bugfix', title: 'Fixed a thing' },
          epoch: baseEpoch + 3600000, // +1 hour
        },
      ],
    });

    // Should contain type names (colored)
    expect(result).toContain('discovery');
    expect(result).toContain('bugfix');
    // Should contain titles
    expect(result).toContain('Found something');
    expect(result).toContain('Fixed a thing');
    // Should have date group header
    expect(result).toContain('Mar');
    expect(result).toContain('15');
  });

  test('returns "no timeline data" for empty input', () => {
    const result = formatTimeline({ timeline: [] });
    expect(result).toContain('No timeline data');
  });

  test('handles session timeline items', () => {
    const result = formatTimeline({
      timeline: [
        {
          type: 'session',
          data: { id: 5, summary_text: 'Worked on auth module' },
          epoch: Date.now(),
        },
      ],
    });

    expect(result).toContain('session');
    expect(result).toContain('Worked on auth module');
  });

  test('handles prompt timeline items', () => {
    const result = formatTimeline({
      timeline: [
        {
          type: 'prompt',
          data: { id: 3, prompt_text: 'Fix the auth bug' },
          epoch: Date.now(),
        },
      ],
    });

    expect(result).toContain('prompt');
    expect(result).toContain('Fix the auth bug');
  });

  test('truncates long text', () => {
    const longText = 'A'.repeat(100);
    const result = formatTimeline({
      timeline: [
        {
          type: 'session',
          data: { id: 1, summary_text: longText },
          epoch: Date.now(),
        },
      ],
    });

    // Should be truncated with ellipsis
    expect(result).toContain('\u2026');
    // Full text should NOT appear
    expect(result).not.toContain(longText);
  });
});

describe('formatStatus', () => {
  test('shows health status with color coding', () => {
    const result = formatStatus({
      status: 'ok',
      version: '1.0.0',
      uptime: 3600000, // 1 hour in ms
      pid: 12345,
      initialized: true,
    });

    expect(result).toContain('Worker Status');
    expect(result).toContain('ok');
    expect(result).toContain('1.0.0');
    expect(result).toContain('12345');
    expect(result).toContain('true');
    // ANSI green should be present for 'ok' status
    expect(result).toContain(ANSI.green);
  });

  test('shows red for non-ok status', () => {
    const result = formatStatus({ status: 'error' });
    expect(result).toContain(ANSI.red);
    expect(result).toContain('error');
  });

  test('includes stats when provided', () => {
    const result = formatStatus(
      { status: 'ok' },
      {
        worker: {
          activeSessions: 3,
          sseClients: 1,
          port: 37777,
        },
        database: {
          observations: 5000,
          sessions: 150,
          summaries: 145,
          size: 2 * 1024 * 1024, // 2 MB
          path: '/home/user/.claude/ai-mem-data/ai-mem.db',
        },
      }
    );

    expect(result).toContain('Sessions');
    expect(result).toContain('3'); // active sessions
    expect(result).toContain('Database');
    expect(result).toContain('5000'); // observations
    expect(result).toContain('150'); // sessions
    expect(result).toContain('2.0 MB');
  });

  test('formats uptime correctly for various durations', () => {
    // Health endpoint returns uptime in milliseconds
    // Short uptime (45 seconds = 45000ms)
    let result = formatStatus({ status: 'ok', uptime: 45000 });
    expect(result).toContain('45s');

    // Medium uptime (2 minutes 5 seconds = 125000ms)
    result = formatStatus({ status: 'ok', uptime: 125000 });
    expect(result).toContain('2m');

    // Long uptime (~2 hours = 7265000ms)
    result = formatStatus({ status: 'ok', uptime: 7265000 });
    expect(result).toContain('2h');
  });
});

describe('formatSSEEvent', () => {
  test('formats new_observation events with type coloring', () => {
    const result = formatSSEEvent({
      type: 'new_observation',
      timestamp: Date.now(),
      observation: {
        id: 42,
        type: 'discovery',
        title: 'Found auth pattern',
        project: 'ai-mem',
      },
    });

    expect(result).toContain('discovery');
    expect(result).toContain('#42');
    expect(result).toContain('Found auth pattern');
    expect(result).toContain('ai-mem');
  });

  test('formats processing_status events', () => {
    const result = formatSSEEvent({
      type: 'processing_status',
      timestamp: Date.now(),
      isProcessing: true,
      queueDepth: 5,
    });

    expect(result).toContain('processing');
    expect(result).toContain('queue: 5');
  });

  test('formats idle processing_status', () => {
    const result = formatSSEEvent({
      type: 'processing_status',
      timestamp: Date.now(),
      isProcessing: false,
      queueDepth: 0,
    });

    expect(result).toContain('idle');
    expect(result).toContain('queue: 0');
  });

  test('formats session_started events', () => {
    const result = formatSSEEvent({
      type: 'session_started',
      timestamp: Date.now(),
      sessionId: 7,
      project: 'ai-mem',
    });

    expect(result).toContain('session+');
    expect(result).toContain('ai-mem');
    expect(result).toContain('#7');
  });

  test('formats session_completed events', () => {
    const result = formatSSEEvent({
      type: 'session_completed',
      timestamp: Date.now(),
      sessionId: 7,
    });

    expect(result).toContain('session-');
    expect(result).toContain('#7');
    expect(result).toContain('completed');
  });

  test('formats connected events', () => {
    const result = formatSSEEvent({
      type: 'connected',
      timestamp: Date.now(),
    });

    expect(result).toContain('connected');
    expect(result).toContain('SSE stream established');
  });

  test('falls back to JSON for unknown event types', () => {
    const result = formatSSEEvent({
      type: 'unknown_thing',
      timestamp: Date.now(),
    });

    expect(result).toContain('unknown_thing');
  });
});

describe('formatError', () => {
  test('wraps message in red', () => {
    const result = formatError('Connection refused');
    expect(result).toContain(ANSI.red);
    expect(result).toContain('Error: Connection refused');
  });
});

describe('formatWorkerDown', () => {
  test('shows red message and startup instructions', () => {
    const result = formatWorkerDown();
    expect(result).toContain('Worker is not running');
    expect(result).toContain('aim status');
    expect(result).toContain(ANSI.red);
  });
});
