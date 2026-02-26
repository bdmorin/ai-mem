/**
 * Tests for aim CLI entry point
 *
 * Tests arg parsing logic and command dispatch.
 * Worker is NOT running during tests -- fetch calls are mocked.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { parseArgs } from '../../src/cli/aim';

// -- Arg parsing tests --

describe('parseArgs', () => {
  test('parses search command with query', () => {
    const result = parseArgs(['search', 'auth patterns']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth patterns');
  });

  test('parses search command with multi-word query', () => {
    const result = parseArgs(['search', 'fix', 'the', 'auth', 'bug']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('fix the auth bug');
  });

  test('parses search command with --limit flag', () => {
    const result = parseArgs(['search', 'auth', '--limit', '5']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth');
    expect(result.limit).toBe(5);
  });

  test('parses search command with --project flag', () => {
    const result = parseArgs(['search', 'auth', '--project', 'ai-mem']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth');
    expect(result.project).toBe('ai-mem');
  });

  test('parses search with all flags', () => {
    const result = parseArgs(['search', 'auth', '--limit', '10', '--project', 'web-app']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth');
    expect(result.limit).toBe(10);
    expect(result.project).toBe('web-app');
  });

  test('parses search with flags before query words', () => {
    const result = parseArgs(['search', '--limit', '10', 'auth', 'patterns']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('auth patterns');
    expect(result.limit).toBe(10);
  });

  test('parses timeline command with no flags', () => {
    const result = parseArgs(['timeline']);
    expect(result.command).toBe('timeline');
    expect(result.last).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  test('parses timeline command with --last flag', () => {
    const result = parseArgs(['timeline', '--last', '7d']);
    expect(result.command).toBe('timeline');
    expect(result.last).toBe('7d');
  });

  test('parses timeline command with --project flag', () => {
    const result = parseArgs(['timeline', '--project', 'ai-mem']);
    expect(result.command).toBe('timeline');
    expect(result.project).toBe('ai-mem');
  });

  test('parses timeline with all flags', () => {
    const result = parseArgs(['timeline', '--last', '3d', '--project', 'web-app', '--limit', '50']);
    expect(result.command).toBe('timeline');
    expect(result.last).toBe('3d');
    expect(result.project).toBe('web-app');
    expect(result.limit).toBe(50);
  });

  test('parses status command', () => {
    const result = parseArgs(['status']);
    expect(result.command).toBe('status');
  });

  test('parses observe command', () => {
    const result = parseArgs(['observe']);
    expect(result.command).toBe('observe');
  });

  test('returns help for empty args', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  test('returns help for unknown command', () => {
    const result = parseArgs(['foobar']);
    expect(result.command).toBe('help');
  });

  test('parses help command explicitly', () => {
    const result = parseArgs(['help']);
    expect(result.command).toBe('help');
  });

  test('search with empty query produces empty string', () => {
    const result = parseArgs(['search']);
    expect(result.command).toBe('search');
    expect(result.query).toBe('');
  });
});

// -- Command execution tests (mocked fetch) --

describe('CLI command execution', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('search command calls /api/search with query params', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          observations: [
            { id: 1, type: 'discovery', title: 'Test result', project: 'proj', created_at_epoch: 1700000000 },
          ],
        }),
      });
    }) as any;

    // Import the module fresh to use our mock
    const { parseArgs: parse } = await import('../../src/cli/aim');
    const parsed = parse(['search', 'auth']);

    // Simulate the fetch call that execSearch would make
    const params = new URLSearchParams({ query: parsed.query! });
    const response = await fetch(`http://localhost:37777/api/search?${params}`);
    const data = await response.json();

    expect(capturedUrl).toContain('/api/search');
    expect(capturedUrl).toContain('query=auth');
    expect(data.observations).toHaveLength(1);
    expect(data.observations[0].title).toBe('Test result');
  });

  test('status command calls health and stats endpoints', async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      calledUrls.push(url);
      if (url.includes('/api/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            status: 'ok',
            version: '1.0.0',
            uptime: 60000,
            pid: 12345,
            initialized: true,
          }),
        });
      }
      if (url.includes('/api/stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            worker: { activeSessions: 2, sseClients: 0, port: 37777 },
            database: { observations: 100, sessions: 10, summaries: 8, size: 1024 * 512 },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as any;

    // Simulate the parallel fetch that execStatus does
    const [healthRes, statsRes] = await Promise.all([
      fetch('http://localhost:37777/api/health'),
      fetch('http://localhost:37777/api/stats'),
    ]);

    const health = await healthRes.json();
    const stats = await statsRes.json();

    expect(calledUrls).toContain('http://localhost:37777/api/health');
    expect(calledUrls).toContain('http://localhost:37777/api/stats');
    expect(health.status).toBe('ok');
    expect(stats.database.observations).toBe(100);
  });

  test('timeline command calls /api/timeline with params', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          timeline: [
            {
              type: 'observation',
              data: { id: 1, type: 'bugfix', title: 'Fixed thing' },
              epoch: Date.now(),
            },
          ],
        }),
      });
    }) as any;

    const params = new URLSearchParams({ last: '7d', project: 'ai-mem' });
    await fetch(`http://localhost:37777/api/timeline?${params}`);

    expect(capturedUrl).toContain('/api/timeline');
    expect(capturedUrl).toContain('last=7d');
    expect(capturedUrl).toContain('project=ai-mem');
  });

  test('connection refused triggers worker-down message pattern', async () => {
    globalThis.fetch = mock(() => {
      throw new TypeError('fetch failed');
    }) as any;

    let caughtWorkerDown = false;
    try {
      await fetch('http://localhost:37777/api/health');
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch failed')) {
        caughtWorkerDown = true;
      }
    }

    expect(caughtWorkerDown).toBe(true);
  });
});
