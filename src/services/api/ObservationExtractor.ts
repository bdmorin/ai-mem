/**
 * ObservationExtractor - Extracts structured observations from tool usage via raw API
 *
 * Replaces the SDKAgent's message loop. Takes raw tool observations,
 * sends them to the Anthropic Messages API with the observer system prompt,
 * and returns parsed observations.
 *
 * Maintains conversation history per session (array of messages).
 * Each new tool observation appends a user message. The API call
 * includes the full history for context.
 */

import type { AnthropicClient, Message, SendMessagesResponse } from './AnthropicClient.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from './parser.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { logger } from '../../utils/logger.js';

/** Tools that produce low-value or meta observations -- skip them */
const DEFAULT_SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',
  'SlashCommand',
  'Skill',
  'TodoWrite',
  'AskUserQuestion',
]);

export interface ExtractRequest {
  toolName: string;
  toolInput: any;
  toolOutput: any;
  cwd: string;
  userPrompt: string;
  promptNumber?: number;
}

export interface SummarizeRequest {
  lastAssistantMessage: string;
  userPrompt: string;
  project: string;
}

export interface ExtractResult {
  observations: ParsedObservation[];
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SummarizeResult {
  summary: ParsedSummary | null;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export class ObservationExtractor {
  private client: AnthropicClient;
  private conversationHistory: Message[] = [];
  private systemPrompt: string | null = null;
  private skipTools: Set<string>;
  private initialized = false;

  constructor(client: AnthropicClient, skipTools?: Set<string>) {
    this.client = client;
    this.skipTools = skipTools || DEFAULT_SKIP_TOOLS;
  }

  /**
   * Initialize with a session context (first prompt).
   * Builds the system prompt from the active mode config.
   */
  init(project: string, userPrompt: string): void {
    const mode = ModeManager.getInstance().getActiveMode();
    this.systemPrompt = this.buildSystemPrompt(mode);

    // First user message provides session context
    const initMessage = this.buildInitMessage(project, userPrompt, mode);
    this.conversationHistory = [{ role: 'user', content: initMessage }];
    this.initialized = true;

    logger.debug('EXTRACTOR', 'Initialized', {
      project,
      promptLength: userPrompt.length,
      historyLength: this.conversationHistory.length,
    });
  }

  /**
   * Extract observations from a tool use event.
   * Returns empty observations for skipped tools.
   */
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    // Skip low-value tools
    if (this.skipTools.has(request.toolName)) {
      return { observations: [], text: '', inputTokens: 0, outputTokens: 0 };
    }

    // Auto-init if not yet initialized (handles late starts)
    if (!this.initialized) {
      this.init(request.cwd, request.userPrompt);
    }

    // Build the observation message
    const obsMessage = this.buildObservationMessage(request);
    this.conversationHistory.push({ role: 'user', content: obsMessage });

    // Send to API with full conversation history
    const response = await this.client.sendMessages({
      system: this.systemPrompt!,
      messages: this.conversationHistory,
    });

    // Add assistant response to history
    this.conversationHistory.push({ role: 'assistant', content: response.text });

    // Parse observations from response
    const observations = parseObservations(response.text);

    logger.debug('EXTRACTOR', 'Extracted observations', {
      tool: request.toolName,
      observationCount: observations.length,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    return {
      observations,
      text: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }

  /**
   * Request a session summary.
   */
  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    if (!this.initialized) {
      this.init(request.project, request.userPrompt);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const summaryMessage = this.buildSummaryMessage(request, mode);
    this.conversationHistory.push({ role: 'user', content: summaryMessage });

    const response = await this.client.sendMessages({
      system: this.systemPrompt!,
      messages: this.conversationHistory,
    });

    this.conversationHistory.push({ role: 'assistant', content: response.text });

    const summary = parseSummary(response.text);

    logger.debug('EXTRACTOR', 'Summary extracted', {
      hasSummary: !!summary,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    return {
      summary,
      text: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }

  /**
   * Get current conversation history length (for diagnostics).
   */
  getHistoryLength(): number {
    return this.conversationHistory.length;
  }

  /**
   * Reset conversation history (e.g., on session restart).
   */
  reset(): void {
    this.conversationHistory = [];
    this.systemPrompt = null;
    this.initialized = false;
  }

  // ========================================================================
  // Prompt Builders (ported from src/sdk/prompts.ts)
  // ========================================================================

  private buildSystemPrompt(mode: ModeConfig): string {
    return `${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

\`\`\`xml
<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
\`\`\`
${mode.prompts.format_examples}

${mode.prompts.footer}`;
  }

  private buildInitMessage(project: string, userPrompt: string, mode: ModeConfig): string {
    return `<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.header_memory_start}`;
  }

  /**
   * Build an observation message from tool use data.
   * Ported from buildObservationPrompt in src/sdk/prompts.ts.
   */
  private buildObservationMessage(request: ExtractRequest): string {
    let toolInput: any;
    let toolOutput: any;

    try {
      toolInput = typeof request.toolInput === 'string'
        ? JSON.parse(request.toolInput)
        : request.toolInput;
    } catch {
      toolInput = request.toolInput;
    }

    try {
      toolOutput = typeof request.toolOutput === 'string'
        ? JSON.parse(request.toolOutput)
        : request.toolOutput;
    } catch {
      toolOutput = request.toolOutput;
    }

    return `<observed_from_primary_session>
  <what_happened>${request.toolName}</what_happened>
  <occurred_at>${new Date().toISOString()}</occurred_at>${request.cwd ? `\n  <working_directory>${request.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>`;
  }

  private buildSummaryMessage(request: SummarizeRequest, mode: ModeConfig): string {
    return `${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${request.lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

${mode.prompts.summary_footer}`;
  }
}
