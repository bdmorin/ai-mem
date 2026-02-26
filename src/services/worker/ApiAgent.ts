/**
 * ApiAgent: Raw Anthropic API agent for observation extraction
 *
 * Replaces SDKAgent's subprocess model with direct HTTP calls.
 * No subprocess spawning, no PID tracking, no Claude executable needed.
 * Just fetch() to the Anthropic Messages API.
 *
 * Implements the same interface as SDKAgent so it can be swapped in
 * without changing SessionRoutes or WorkerService wiring.
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { AnthropicClient } from '../api/AnthropicClient.js';
import { ObservationExtractor } from '../api/ObservationExtractor.js';
import { processAgentResponse, type WorkerRef } from './agents/index.js';

/** Default model for observation extraction (fast + cheap) */
const DEFAULT_OBSERVATION_MODEL = 'claude-haiku-4-5-20251001';

export class ApiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Start API agent for a session (event-driven, no subprocess)
   * @param worker WorkerService reference for SSE broadcasting (optional)
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Track cwd from messages for CLAUDE.md generation (worktree support)
    const cwdTracker = { lastCwd: undefined as string | undefined };

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = settings.AI_MEM_MODEL || DEFAULT_OBSERVATION_MODEL;

    logger.info('API', 'Starting API agent', {
      sessionDbId: session.sessionDbId,
      contentSessionId: session.contentSessionId,
      model,
      lastPromptNumber: session.lastPromptNumber,
    });

    // Create client and extractor for this session
    const client = new AnthropicClient({ model });
    const extractor = new ObservationExtractor(client, this.getSkipTools(settings));

    // Initialize the extractor with session context
    extractor.init(session.project, session.userPrompt);

    // Use contentSessionId directly as the memory session ID.
    // No more two-phase handoff -- we don't get a separate session_id from a subprocess.
    if (!session.memorySessionId) {
      session.memorySessionId = session.contentSessionId;

      // Persist to database for FK constraint compliance
      this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(
        session.sessionDbId,
        session.contentSessionId
      );

      logger.info('SESSION', `MEMORY_ID_SET | sessionDbId=${session.sessionDbId} | memorySessionId=${session.contentSessionId}`, {
        sessionId: session.sessionDbId,
        memorySessionId: session.contentSessionId,
      });
    }

    // Consume pending messages from SessionManager (event-driven, no polling)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      // Check abort
      if (session.abortController.signal.aborted) {
        logger.info('API', 'Session aborted, stopping', { sessionDbId: session.sessionDbId });
        break;
      }

      // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
      session.processingMessageIds.push(message._persistentId);

      // Capture cwd from each message for worktree support
      if (message.cwd) {
        cwdTracker.lastCwd = message.cwd;
      }

      if (message.type === 'observation') {
        // Update last prompt number
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }

        // Capture earliest timestamp BEFORE processing
        const originalTimestamp = session.earliestPendingTimestamp;

        try {
          const result = await extractor.extract({
            toolName: message.tool_name!,
            toolInput: message.tool_input,
            toolOutput: message.tool_response,
            cwd: message.cwd || '',
            userPrompt: session.userPrompt,
            promptNumber: message.prompt_number,
          });

          // Track token usage
          session.cumulativeInputTokens += result.inputTokens;
          session.cumulativeOutputTokens += result.outputTokens;
          const discoveryTokens = result.inputTokens + result.outputTokens;

          if (result.text) {
            // Add to shared conversation history for provider interop
            session.conversationHistory.push({ role: 'user', content: `[${message.tool_name}]` });
            session.conversationHistory.push({ role: 'assistant', content: result.text });
          }

          // Process response if there are observations (skipped tools return empty)
          if (result.observations.length > 0) {
            await processAgentResponse(
              result.text,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              discoveryTokens,
              originalTimestamp,
              'API',
              cwdTracker.lastCwd
            );
          } else {
            // No observations -- still need to confirm message processing
            const pendingStore = this.sessionManager.getPendingMessageStore();
            for (const messageId of session.processingMessageIds) {
              pendingStore.confirmProcessed(messageId);
            }
            session.processingMessageIds = [];
            session.earliestPendingTimestamp = null;
          }
        } catch (error) {
          if (session.abortController.signal.aborted) break;

          logger.error('API', 'Observation extraction failed', {
            sessionDbId: session.sessionDbId,
            tool: message.tool_name,
            error: (error as Error).message,
          }, error as Error);

          // Confirm messages to prevent infinite retry -- the observation is lost
          // but we don't want to block the queue
          const pendingStore = this.sessionManager.getPendingMessageStore();
          for (const messageId of session.processingMessageIds) {
            pendingStore.confirmProcessed(messageId);
          }
          session.processingMessageIds = [];
          session.earliestPendingTimestamp = null;
        }
      } else if (message.type === 'summarize') {
        const originalTimestamp = session.earliestPendingTimestamp;

        try {
          const result = await extractor.summarize({
            lastAssistantMessage: message.last_assistant_message || '',
            userPrompt: session.userPrompt,
            project: session.project,
          });

          // Track token usage
          session.cumulativeInputTokens += result.inputTokens;
          session.cumulativeOutputTokens += result.outputTokens;
          const discoveryTokens = result.inputTokens + result.outputTokens;

          if (result.text) {
            session.conversationHistory.push({ role: 'assistant', content: result.text });
          }

          if (result.summary) {
            await processAgentResponse(
              result.text,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              discoveryTokens,
              originalTimestamp,
              'API',
              cwdTracker.lastCwd
            );
          } else {
            // No summary -- confirm messages
            const pendingStore = this.sessionManager.getPendingMessageStore();
            for (const messageId of session.processingMessageIds) {
              pendingStore.confirmProcessed(messageId);
            }
            session.processingMessageIds = [];
            session.earliestPendingTimestamp = null;
          }
        } catch (error) {
          if (session.abortController.signal.aborted) break;

          logger.error('API', 'Summary extraction failed', {
            sessionDbId: session.sessionDbId,
            error: (error as Error).message,
          }, error as Error);

          const pendingStore = this.sessionManager.getPendingMessageStore();
          for (const messageId of session.processingMessageIds) {
            pendingStore.confirmProcessed(messageId);
          }
          session.processingMessageIds = [];
          session.earliestPendingTimestamp = null;
        }
      }
    }

    // Mark session complete
    const sessionDuration = Date.now() - session.startTime;
    logger.success('API', 'Agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      observations: extractor.getHistoryLength(),
    });
  }

  /**
   * Parse skip tools from settings
   */
  private getSkipTools(settings: Record<string, any>): Set<string> {
    const skipStr = settings.AI_MEM_SKIP_TOOLS || 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion';
    return new Set(skipStr.split(',').map((t: string) => t.trim()).filter(Boolean));
  }
}
