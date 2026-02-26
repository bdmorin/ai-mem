#!/usr/bin/env bun

/**
 * aim - CLI query interface for ai-mem worker
 *
 * Queries the worker's HTTP API (localhost:37777) and formats results
 * for terminal display. The worker must be running for commands to work.
 *
 * Commands:
 *   aim search <query>                   Search observations, sessions, prompts
 *   aim timeline [--last 7d] [--project] Recent activity timeline
 *   aim status                           Worker health and database stats
 *   aim observe                          Live SSE event stream
 */

import {
  formatSearchResults,
  formatTimeline,
  formatStatus,
  formatSSEEvent,
  formatError,
  formatWorkerDown,
} from './formatters.js';

const WORKER_BASE = 'http://localhost:37777';

// -- Arg parsing --

export interface ParsedArgs {
  command: string;
  query?: string;
  last?: string;
  project?: string;
  limit?: number;
}

/**
 * Parse CLI arguments into a structured command object.
 * Expects args AFTER the script name (i.e., process.argv.slice(2)).
 */
export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { command: 'help' };
  }

  const command = args[0];
  const result: ParsedArgs = { command };

  switch (command) {
    case 'search': {
      // Everything after 'search' that isn't a flag is the query
      const queryParts: string[] = [];
      let i = 1;
      while (i < args.length) {
        if (args[i] === '--limit' && i + 1 < args.length) {
          result.limit = parseInt(args[i + 1], 10);
          i += 2;
        } else if (args[i] === '--project' && i + 1 < args.length) {
          result.project = args[i + 1];
          i += 2;
        } else if (args[i].startsWith('--')) {
          i++; // skip unknown flags
        } else {
          queryParts.push(args[i]);
          i++;
        }
      }
      result.query = queryParts.join(' ');
      break;
    }

    case 'timeline': {
      let i = 1;
      while (i < args.length) {
        if (args[i] === '--last' && i + 1 < args.length) {
          result.last = args[i + 1];
          i += 2;
        } else if (args[i] === '--project' && i + 1 < args.length) {
          result.project = args[i + 1];
          i += 2;
        } else if (args[i] === '--limit' && i + 1 < args.length) {
          result.limit = parseInt(args[i + 1], 10);
          i += 2;
        } else {
          i++;
        }
      }
      break;
    }

    case 'status':
    case 'observe':
    case 'help':
      // No additional args needed
      break;

    default:
      // Unknown command, treat as help
      result.command = 'help';
      break;
  }

  return result;
}

// -- Command executors --

async function execSearch(parsed: ParsedArgs): Promise<void> {
  if (!parsed.query) {
    console.log(formatError('Usage: aim search <query> [--limit N] [--project name]'));
    process.exit(1);
  }

  const params = new URLSearchParams({ query: parsed.query });
  if (parsed.limit) params.set('limit', String(parsed.limit));
  if (parsed.project) params.set('project', parsed.project);

  const response = await fetch(`${WORKER_BASE}/api/search?${params}`);
  if (!response.ok) {
    throw new Error(`Worker returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  console.log(formatSearchResults(data));
}

async function execTimeline(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  if (parsed.last) params.set('last', parsed.last);
  if (parsed.project) params.set('project', parsed.project);
  if (parsed.limit) params.set('limit', String(parsed.limit));

  const response = await fetch(`${WORKER_BASE}/api/timeline?${params}`);
  if (!response.ok) {
    throw new Error(`Worker returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  console.log(formatTimeline(data));
}

async function execStatus(): Promise<void> {
  // Fetch health and stats in parallel
  const [healthRes, statsRes] = await Promise.all([
    fetch(`${WORKER_BASE}/api/health`),
    fetch(`${WORKER_BASE}/api/stats`),
  ]);

  if (!healthRes.ok) {
    throw new Error(`Health check failed: ${healthRes.status}`);
  }

  const health = await healthRes.json();
  const stats = statsRes.ok ? await statsRes.json() : undefined;

  console.log(formatStatus(health, stats));
}

async function execObserve(): Promise<void> {
  console.log('Connecting to SSE stream...\n');

  const response = await fetch(`${WORKER_BASE}/stream`);
  if (!response.ok) {
    throw new Error(`SSE connection failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body from SSE stream');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\nDisconnected.');
    reader.cancel();
    process.exit(0);
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE messages (data: ...\n\n)
    const messages = buffer.split('\n\n');
    buffer = messages.pop() || ''; // Last element is incomplete

    for (const msg of messages) {
      const dataLine = msg.trim();
      if (!dataLine.startsWith('data: ')) continue;

      try {
        const event = JSON.parse(dataLine.slice(6));
        console.log(formatSSEEvent(event));
      } catch {
        // Ignore malformed events
      }
    }
  }
}

function printHelp(): void {
  console.log(`
aim - query ai-mem from the terminal

Commands:
  aim search <query>                  Search observations, sessions, and prompts
      --limit N                       Max results (default: 20)
      --project name                  Filter by project

  aim timeline                        Recent activity timeline
      --last 7d                       Time window (e.g., 1h, 3d, 7d)
      --project name                  Filter by project
      --limit N                       Max items

  aim status                          Worker health and database stats

  aim observe                         Live observation stream (SSE)

Examples:
  aim search "auth patterns"
  aim timeline --last 7d --project ai-mem
  aim status
  aim observe
`);
}

// -- Main --

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.command === 'help') {
    printHelp();
    process.exit(0);
  }

  try {
    switch (parsed.command) {
      case 'search':
        await execSearch(parsed);
        break;
      case 'timeline':
        await execTimeline(parsed);
        break;
      case 'status':
        await execStatus();
        break;
      case 'observe':
        await execObserve();
        break;
      default:
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch failed')) {
      console.log(formatWorkerDown());
      process.exit(1);
    }
    if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.log(formatWorkerDown());
      process.exit(1);
    }
    console.log(formatError(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

// Run main only when executed directly (not when imported for testing)
const isMainModule = typeof Bun !== 'undefined'
  ? Bun.main === import.meta.path
  : process.argv[1] === import.meta.filename;

if (isMainModule) {
  main();
}
