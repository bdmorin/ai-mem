/**
 * Default settings values for Claude Memory
 * Shared across UI components and hooks
 */
export const DEFAULT_SETTINGS = {
  AI_MEM_MODEL: 'claude-sonnet-4-5',
  AI_MEM_CONTEXT_OBSERVATIONS: '50',
  AI_MEM_WORKER_PORT: '37777',
  AI_MEM_WORKER_HOST: '127.0.0.1',

  // AI Provider Configuration
  AI_MEM_PROVIDER: 'claude',
  AI_MEM_GEMINI_API_KEY: '',
  AI_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
  AI_MEM_OPENROUTER_API_KEY: '',
  AI_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
  AI_MEM_OPENROUTER_SITE_URL: '',
  AI_MEM_OPENROUTER_APP_NAME: 'ai-mem',
  AI_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',

  // Token Economics (all true for backwards compatibility)
  AI_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
  AI_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
  AI_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
  AI_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',

  // Observation Filtering (all types and concepts)
  AI_MEM_CONTEXT_OBSERVATION_TYPES: 'bugfix,feature,refactor,discovery,decision,change',
  AI_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off',

  // Display Configuration
  AI_MEM_CONTEXT_FULL_COUNT: '5',
  AI_MEM_CONTEXT_FULL_FIELD: 'narrative',
  AI_MEM_CONTEXT_SESSION_COUNT: '10',

  // Feature Toggles
  AI_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  AI_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',

  // Exclusion Settings
  AI_MEM_EXCLUDED_PROJECTS: '',
  AI_MEM_FOLDER_MD_EXCLUDE: '[]',
} as const;
