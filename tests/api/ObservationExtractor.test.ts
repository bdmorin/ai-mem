import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ObservationExtractor } from '../../src/services/api/ObservationExtractor';
import { ModeManager } from '../../src/services/domain/ModeManager';

// Ensure mode is loaded before tests run (parser depends on it)
beforeEach(() => {
  try {
    ModeManager.getInstance().getActiveMode();
  } catch {
    ModeManager.getInstance().loadMode('code');
  }
});

function createMockClient(responseText: string) {
  return {
    sendMessages: mock(() =>
      Promise.resolve({
        text: responseText,
        inputTokens: 500,
        outputTokens: 100,
        stopReason: 'end_turn',
      })
    ),
  };
}

describe('ObservationExtractor', () => {
  test('extracts observation from tool use', async () => {
    const mockClient = createMockClient(`<observation>
      <type>discovery</type>
      <title>Auth pattern found</title>
      <subtitle>JWT validation</subtitle>
      <facts><fact>Uses RS256</fact></facts>
      <narrative>Found JWT auth pattern in middleware.</narrative>
      <concepts><concept>how-it-works</concept></concepts>
      <files_read><file>src/auth.ts</file></files_read>
      <files_modified></files_modified>
    </observation>`);

    const extractor = new ObservationExtractor(mockClient as any);
    const result = await extractor.extract({
      toolName: 'Read',
      toolInput: { file_path: 'src/auth.ts' },
      toolOutput: 'export function validateJWT...',
      cwd: '/project',
      userPrompt: 'Fix the auth bug',
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('discovery');
    expect(result.observations[0].title).toBe('Auth pattern found');
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(100);
    expect(mockClient.sendMessages).toHaveBeenCalledTimes(1);
  });

  test('returns empty array for skippable tools', async () => {
    const mockClient = createMockClient('should not be called');
    const extractor = new ObservationExtractor(mockClient as any);

    const result = await extractor.extract({
      toolName: 'TodoWrite',
      toolInput: {},
      toolOutput: '',
      cwd: '/project',
      userPrompt: 'test',
    });

    expect(result.observations).toHaveLength(0);
    expect(result.text).toBe('');
    expect(mockClient.sendMessages).not.toHaveBeenCalled();
  });

  test('skips AskUserQuestion tool', async () => {
    const mockClient = createMockClient('');
    const extractor = new ObservationExtractor(mockClient as any);

    const result = await extractor.extract({
      toolName: 'AskUserQuestion',
      toolInput: {},
      toolOutput: '',
      cwd: '/project',
      userPrompt: 'test',
    });

    expect(result.observations).toHaveLength(0);
    expect(mockClient.sendMessages).not.toHaveBeenCalled();
  });

  test('maintains conversation history across multiple extractions', async () => {
    let callCount = 0;
    const mockClient = {
      sendMessages: mock(({ messages }: any) => {
        callCount++;
        return Promise.resolve({
          text: `<observation>
            <type>discovery</type>
            <title>Call ${callCount}</title>
            <subtitle>test</subtitle>
            <facts><fact>fact</fact></facts>
            <narrative>narrative</narrative>
            <concepts><concept>how-it-works</concept></concepts>
            <files_read></files_read>
            <files_modified></files_modified>
          </observation>`,
          inputTokens: 100 * callCount,
          outputTokens: 50,
          stopReason: 'end_turn',
        });
      }),
    };

    const extractor = new ObservationExtractor(mockClient as any);

    // First extraction
    await extractor.extract({
      toolName: 'Read',
      toolInput: { file_path: 'a.ts' },
      toolOutput: 'content',
      cwd: '/project',
      userPrompt: 'check files',
    });

    // Second extraction -- history should include the first exchange
    await extractor.extract({
      toolName: 'Write',
      toolInput: { file_path: 'b.ts', content: 'new content' },
      toolOutput: 'written',
      cwd: '/project',
      userPrompt: 'check files',
    });

    expect(mockClient.sendMessages).toHaveBeenCalledTimes(2);

    // After 2 extractions, history should be:
    // init_msg (user) + obs1 (user) + resp1 (assistant) + obs2 (user) + resp2 (assistant) = 5
    expect(extractor.getHistoryLength()).toBe(5);
  });

  test('summarize extracts summary from response', async () => {
    const mockClient = createMockClient(`<summary>
      <request>Fix auth bug</request>
      <investigated>JWT validation code</investigated>
      <learned>RS256 is used</learned>
      <completed>Fixed the token validation</completed>
      <next_steps>Add tests</next_steps>
      <notes>Consider rotation</notes>
    </summary>`);

    const extractor = new ObservationExtractor(mockClient as any);
    const result = await extractor.summarize({
      lastAssistantMessage: 'I fixed the auth bug.',
      userPrompt: 'Fix the auth bug',
      project: 'test-project',
    });

    expect(result.summary).not.toBeNull();
    expect(result.summary!.request).toBe('Fix auth bug');
    expect(result.summary!.learned).toBe('RS256 is used');
    expect(result.inputTokens).toBe(500);
  });

  test('reset clears conversation history', async () => {
    const mockClient = createMockClient('<observation><type>discovery</type></observation>');
    const extractor = new ObservationExtractor(mockClient as any);

    await extractor.extract({
      toolName: 'Read',
      toolInput: {},
      toolOutput: '',
      cwd: '/project',
      userPrompt: 'test',
    });

    expect(extractor.getHistoryLength()).toBeGreaterThan(0);

    extractor.reset();
    expect(extractor.getHistoryLength()).toBe(0);
  });

  test('supports custom skip tools set', async () => {
    const mockClient = createMockClient('<observation><type>discovery</type></observation>');

    // Custom skip set that includes 'Read'
    const customSkip = new Set(['Read', 'Write']);
    const extractor = new ObservationExtractor(mockClient as any, customSkip);

    const result = await extractor.extract({
      toolName: 'Read',
      toolInput: {},
      toolOutput: '',
      cwd: '/project',
      userPrompt: 'test',
    });

    expect(result.observations).toHaveLength(0);
    expect(mockClient.sendMessages).not.toHaveBeenCalled();
  });

  test('handles multiple observations in single response', async () => {
    const mockClient = createMockClient(`
      <observation>
        <type>discovery</type>
        <title>First</title>
        <subtitle>sub1</subtitle>
        <facts><fact>f1</fact></facts>
        <narrative>n1</narrative>
        <concepts><concept>how-it-works</concept></concepts>
        <files_read></files_read>
        <files_modified></files_modified>
      </observation>
      <observation>
        <type>bugfix</type>
        <title>Second</title>
        <subtitle>sub2</subtitle>
        <facts><fact>f2</fact></facts>
        <narrative>n2</narrative>
        <concepts><concept>problem-solution</concept></concepts>
        <files_read></files_read>
        <files_modified></files_modified>
      </observation>`);

    const extractor = new ObservationExtractor(mockClient as any);
    const result = await extractor.extract({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      toolOutput: 'all pass',
      cwd: '/project',
      userPrompt: 'run tests',
    });

    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].title).toBe('First');
    expect(result.observations[1].title).toBe('Second');
  });

  test('auto-initializes on first extract if not explicitly initialized', async () => {
    const mockClient = createMockClient('<observation><type>discovery</type><title>Auto Init</title></observation>');
    const extractor = new ObservationExtractor(mockClient as any);

    // Don't call init() -- should auto-init
    const result = await extractor.extract({
      toolName: 'Grep',
      toolInput: { pattern: 'TODO' },
      toolOutput: 'found matches',
      cwd: '/project',
      userPrompt: 'find TODOs',
    });

    expect(result.observations).toHaveLength(1);
    expect(mockClient.sendMessages).toHaveBeenCalledTimes(1);
  });
});
