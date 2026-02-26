/**
 * Terminal Output Formatters for aim CLI
 *
 * Formats worker API responses for terminal display with ANSI color coding.
 * Each formatter takes a raw API response and returns a printable string.
 */

// ANSI escape codes for terminal colors
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const;

/**
 * Colorize text with an ANSI color code
 */
function c(color: string, text: string): string {
  return `${color}${text}${ANSI.reset}`;
}

/**
 * Pad or truncate a string to a fixed width
 */
function pad(text: string, width: number): string {
  if (text.length > width) {
    return text.slice(0, width - 1) + '\u2026'; // ellipsis
  }
  return text.padEnd(width);
}

/**
 * Format a Unix epoch (seconds or ms) as a short date string
 */
function formatDate(epoch: number): string {
  // Handle both seconds and millisecond epochs
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format a Unix epoch as a date-only string for grouping
 */
function formatDateGroup(epoch: number): string {
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// -- Observation type color map --
const TYPE_COLORS: Record<string, string> = {
  discovery: ANSI.cyan,
  decision: ANSI.magenta,
  bugfix: ANSI.red,
  feature: ANSI.green,
  refactor: ANSI.yellow,
  implementation: ANSI.blue,
};

function colorType(type: string): string {
  const color = TYPE_COLORS[type] || ANSI.white;
  return c(color, type);
}

// ---------- Search Results Formatter ----------

export interface SearchObservation {
  id: number;
  type: string;
  title: string;
  project?: string;
  created_at_epoch?: number;
  subtitle?: string;
}

export interface SearchResponse {
  observations?: SearchObservation[];
  sessions?: Array<{ id: number; summary_text?: string; project?: string; created_at_epoch?: number }>;
  prompts?: Array<{ id: number; prompt_text?: string; project?: string; created_at_epoch?: number }>;
  results?: SearchObservation[];
}

/**
 * Format search results as a terminal table
 *
 * Columns: [ID, Date, Type, Title, Project]
 */
export function formatSearchResults(data: SearchResponse): string {
  const observations = data.observations || data.results || [];

  if (observations.length === 0 && !data.sessions?.length && !data.prompts?.length) {
    return c(ANSI.yellow, 'No results found.');
  }

  const lines: string[] = [];

  if (observations.length > 0) {
    lines.push(c(ANSI.bold, 'Observations'));
    lines.push(
      `${c(ANSI.dim, pad('ID', 8))}${c(ANSI.dim, pad('Date', 14))}${c(ANSI.dim, pad('Type', 16))}${c(ANSI.dim, pad('Project', 20))}${c(ANSI.dim, 'Title')}`
    );
    lines.push(c(ANSI.dim, '\u2500'.repeat(80)));

    for (const obs of observations) {
      const id = pad(`#${obs.id}`, 8);
      const date = pad(obs.created_at_epoch ? formatDate(obs.created_at_epoch) : '--', 14);
      const type = pad(obs.type || 'unknown', 16);
      const project = pad(obs.project || '--', 20);
      const title = obs.title || '--';

      lines.push(`${id}${date}${colorType(type.trim()).padEnd(type.length + (colorType(type.trim()).length - type.trim().length))}${project}${title}`);
    }
  }

  if (data.sessions && data.sessions.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(c(ANSI.bold, 'Sessions'));
    lines.push(
      `${c(ANSI.dim, pad('ID', 8))}${c(ANSI.dim, pad('Date', 14))}${c(ANSI.dim, pad('Project', 20))}${c(ANSI.dim, 'Summary')}`
    );
    lines.push(c(ANSI.dim, '\u2500'.repeat(80)));

    for (const sess of data.sessions) {
      const id = pad(`S${sess.id}`, 8);
      const date = pad(sess.created_at_epoch ? formatDate(sess.created_at_epoch) : '--', 14);
      const project = pad(sess.project || '--', 20);
      const summary = sess.summary_text
        ? (sess.summary_text.length > 60 ? sess.summary_text.slice(0, 59) + '\u2026' : sess.summary_text)
        : '--';
      lines.push(`${id}${date}${project}${summary}`);
    }
  }

  if (data.prompts && data.prompts.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(c(ANSI.bold, 'Prompts'));
    lines.push(
      `${c(ANSI.dim, pad('ID', 8))}${c(ANSI.dim, pad('Date', 14))}${c(ANSI.dim, pad('Project', 20))}${c(ANSI.dim, 'Prompt')}`
    );
    lines.push(c(ANSI.dim, '\u2500'.repeat(80)));

    for (const p of data.prompts) {
      const id = pad(`P${p.id}`, 8);
      const date = pad(p.created_at_epoch ? formatDate(p.created_at_epoch) : '--', 14);
      const project = pad(p.project || '--', 20);
      const text = p.prompt_text
        ? (p.prompt_text.length > 60 ? p.prompt_text.slice(0, 59) + '\u2026' : p.prompt_text)
        : '--';
      lines.push(`${id}${date}${project}${text}`);
    }
  }

  return lines.join('\n');
}

// ---------- Timeline Formatter ----------

export interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: {
    id: number;
    type?: string;
    title?: string;
    summary_text?: string;
    prompt_text?: string;
    project?: string;
  };
  epoch: number;
  created_at?: string;
}

export interface TimelineResponse {
  timeline?: TimelineItem[];
  items?: TimelineItem[];
}

/**
 * Format timeline as date-grouped list with observation summaries
 */
export function formatTimeline(data: TimelineResponse): string {
  const items = data.timeline || data.items || [];

  if (items.length === 0) {
    return c(ANSI.yellow, 'No timeline data.');
  }

  // Group by date
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const dateKey = formatDateGroup(item.epoch);
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(item);
  }

  const lines: string[] = [];

  for (const [dateKey, groupItems] of groups) {
    lines.push('');
    lines.push(c(ANSI.bold + ANSI.white, `\u2501\u2501 ${dateKey} \u2501\u2501`));

    for (const item of groupItems) {
      const ms = item.epoch > 1e12 ? item.epoch : item.epoch * 1000;
      const d = new Date(ms);
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      if (item.type === 'observation') {
        const obsType = item.data.type || 'unknown';
        const title = item.data.title || '--';
        lines.push(`  ${c(ANSI.dim, time)}  ${colorType(obsType)}  ${title}`);
      } else if (item.type === 'session') {
        const summary = item.data.summary_text || '--';
        const truncated = summary.length > 70 ? summary.slice(0, 69) + '\u2026' : summary;
        lines.push(`  ${c(ANSI.dim, time)}  ${c(ANSI.blue, 'session')}  ${truncated}`);
      } else if (item.type === 'prompt') {
        const text = item.data.prompt_text || '--';
        const truncated = text.length > 70 ? text.slice(0, 69) + '\u2026' : text;
        lines.push(`  ${c(ANSI.dim, time)}  ${c(ANSI.yellow, 'prompt')}  ${truncated}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------- Status Formatter ----------

export interface HealthResponse {
  status: string;
  version?: string;
  uptime?: number;
  pid?: number;
  platform?: string;
  initialized?: boolean;
  managed?: boolean;
  ai?: Record<string, unknown>;
}

export interface StatsResponse {
  worker?: {
    version?: string;
    uptime?: number;
    activeSessions?: number;
    sseClients?: number;
    port?: number;
  };
  database?: {
    path?: string;
    size?: number;
    observations?: number;
    sessions?: number;
    summaries?: number;
  };
}

/**
 * Format an uptime in seconds to a human-readable string
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Format a byte count to a human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format health + stats as key-value pairs with color-coded indicators
 */
export function formatStatus(health: HealthResponse, stats?: StatsResponse): string {
  const lines: string[] = [];

  lines.push(c(ANSI.bold, 'Worker Status'));
  lines.push(c(ANSI.dim, '\u2500'.repeat(40)));

  // Health status
  const statusColor = health.status === 'ok' ? ANSI.green : ANSI.red;
  lines.push(`  Status:       ${c(statusColor, health.status)}`);

  if (health.version) {
    lines.push(`  Version:      ${health.version}`);
  }

  if (health.uptime !== undefined) {
    // Health endpoint returns uptime in milliseconds, convert to seconds
    const uptimeSec = Math.floor(health.uptime / 1000);
    lines.push(`  Uptime:       ${formatUptime(uptimeSec)}`);
  }

  if (health.pid !== undefined) {
    lines.push(`  PID:          ${health.pid}`);
  }

  if (health.initialized !== undefined) {
    const initColor = health.initialized ? ANSI.green : ANSI.yellow;
    lines.push(`  Initialized:  ${c(initColor, String(health.initialized))}`);
  }

  // Stats section
  if (stats) {
    if (stats.worker) {
      lines.push('');
      lines.push(c(ANSI.bold, 'Sessions'));
      lines.push(c(ANSI.dim, '\u2500'.repeat(40)));
      if (stats.worker.activeSessions !== undefined) {
        lines.push(`  Active:       ${stats.worker.activeSessions}`);
      }
      if (stats.worker.sseClients !== undefined) {
        lines.push(`  SSE Clients:  ${stats.worker.sseClients}`);
      }
      if (stats.worker.port !== undefined) {
        lines.push(`  Port:         ${stats.worker.port}`);
      }
    }

    if (stats.database) {
      lines.push('');
      lines.push(c(ANSI.bold, 'Database'));
      lines.push(c(ANSI.dim, '\u2500'.repeat(40)));
      if (stats.database.observations !== undefined) {
        lines.push(`  Observations: ${stats.database.observations}`);
      }
      if (stats.database.sessions !== undefined) {
        lines.push(`  Sessions:     ${stats.database.sessions}`);
      }
      if (stats.database.summaries !== undefined) {
        lines.push(`  Summaries:    ${stats.database.summaries}`);
      }
      if (stats.database.size !== undefined) {
        lines.push(`  Size:         ${formatBytes(stats.database.size)}`);
      }
      if (stats.database.path) {
        lines.push(`  Path:         ${c(ANSI.dim, stats.database.path)}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------- Live Stream Formatter ----------

export interface SSEObservation {
  type: string;
  timestamp?: number;
  // Observation events
  observation?: {
    id?: number;
    type?: string;
    title?: string;
    project?: string;
  };
  // Processing status
  isProcessing?: boolean;
  queueDepth?: number;
  // Session events
  sessionId?: number;
  project?: string;
}

/**
 * Format a single SSE event as a compact one-line terminal output
 */
export function formatSSEEvent(event: SSEObservation): string {
  const time = event.timestamp
    ? formatDate(event.timestamp)
    : formatDate(Date.now());

  switch (event.type) {
    case 'new_observation': {
      const obs = event.observation;
      if (!obs) return `${c(ANSI.dim, time)}  ${c(ANSI.cyan, 'observation')}  (no data)`;
      const obsType = obs.type || 'unknown';
      const title = obs.title || '--';
      const project = obs.project ? c(ANSI.dim, ` [${obs.project}]`) : '';
      return `${c(ANSI.dim, time)}  ${colorType(obsType)}  #${obs.id || '?'} ${title}${project}`;
    }

    case 'processing_status': {
      const processing = event.isProcessing;
      const queue = event.queueDepth || 0;
      const statusIcon = processing
        ? c(ANSI.yellow, 'processing')
        : c(ANSI.green, 'idle');
      return `${c(ANSI.dim, time)}  ${statusIcon}  queue: ${queue}`;
    }

    case 'session_started': {
      const project = event.project || '--';
      return `${c(ANSI.dim, time)}  ${c(ANSI.green, 'session+')}  ${project} (session #${event.sessionId || '?'})`;
    }

    case 'session_completed': {
      return `${c(ANSI.dim, time)}  ${c(ANSI.red, 'session-')}  session #${event.sessionId || '?'} completed`;
    }

    case 'connected': {
      return `${c(ANSI.dim, time)}  ${c(ANSI.green, 'connected')}  SSE stream established`;
    }

    case 'initial_load': {
      return `${c(ANSI.dim, time)}  ${c(ANSI.blue, 'loaded')}  initial data received`;
    }

    default: {
      return `${c(ANSI.dim, time)}  ${c(ANSI.dim, event.type)}  ${JSON.stringify(event).slice(0, 60)}`;
    }
  }
}

/**
 * Format an error message for terminal display
 */
export function formatError(message: string): string {
  return c(ANSI.red, `Error: ${message}`);
}

/**
 * Format a worker-down message
 */
export function formatWorkerDown(): string {
  const lines = [
    c(ANSI.red, 'Worker is not running.'),
    '',
    `Start it with: ${c(ANSI.bold, 'bun plugin/scripts/worker-service.cjs start')}`,
    `Or check status: ${c(ANSI.bold, 'aim status')}`,
  ];
  return lines.join('\n');
}
