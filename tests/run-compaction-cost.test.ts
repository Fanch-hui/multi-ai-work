import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import { estimateModelMessagesTokens } from '../src/runtime/model-history.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';

vi.mock('../src/runtime/model-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtime/model-history.js')>();
  return {
    ...actual,
    estimateModelMessagesTokens: vi.fn(actual.estimateModelMessagesTokens),
  };
});

const options = {
  currentStart: 0,
  force: false,
  budget: 100_000,
  trigger: 1000,
  fixedTokens: 100,
  protocol: 'responses' as const,
  signal: new AbortController().signal,
  summarize: async (_prompt: string, _signal: AbortSignal) => '保留结论',
};

function exchange(id: string, content = '材料'.repeat(200)): ModelMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: '{}' }] },
    { role: 'tool', callId: id, content },
  ];
}

function replacement(tool: ModelMessage): ModelMessage {
  return {
    ...tool,
    providerItems: undefined,
    contextSummary: true,
    contextArtifactIds: [`artifact-${tool.callId}`],
    content: `工具结果摘要：\n保留结论\n读取 ${tool.callId}`,
  };
}

const preserveToolOutput = async (tool: ModelMessage) => ({
  text: `读取 ${tool.callId}`,
  artifactIds: [`artifact-${tool.callId}`],
});

beforeEach(() => {
  vi.mocked(estimateModelMessagesTokens).mockClear();
});

describe('run compaction estimation cost', () => {
  it('estimates a long tool history and its candidate once each', async () => {
    const original: ModelMessage[] = [
      { role: 'user', content: '完成报告' },
      ...Array.from({ length: 50 }, (_, index) => exchange(String(index))).flat(),
      ...exchange('latest', '最新材料'),
    ];
    const summarize = vi.fn(options.summarize);
    const projected = await compactRunMessages(original, { ...options, summarize });

    expect(projected?.messages).toEqual([
      original[0],
      {
        role: 'assistant',
        contextSummary: true,
        content: '已完成工作摘要（历史资料）：\n保留结论',
      },
      ...original.slice(-2),
    ]);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(estimateModelMessagesTokens).mock.calls.map(([items]) => items.length),
    ).toEqual([103, 4]);
  });

  it('carries the reduced size through separate history ranges in their original order', async () => {
    const original: ModelMessage[] = [
      { role: 'user', content: '制作报告' },
      ...exchange('one'),
      { role: 'user', content: '补充要求' },
      ...exchange('two'),
      ...exchange('latest', '最新资料'),
    ];
    const summary: ModelMessage = {
      role: 'assistant',
      contextSummary: true,
      content: '已完成工作摘要（历史资料）：\n保留结论',
    };
    const expected = [original[0], summary, original[3], summary, ...original.slice(-2)];
    const trigger = options.fixedTokens + estimateModelMessagesTokens(expected);
    vi.mocked(estimateModelMessagesTokens).mockClear();
    const summarize = vi.fn(options.summarize);

    const projected = await compactRunMessages(original, { ...options, trigger, summarize });

    expect(projected?.messages).toEqual(expected);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[0][0]).toContain('one');
    expect(summarize.mock.calls[1][0]).toContain('two');
    expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(3);
  });

  it.each(['responses', 'chat-completions'] as const)(
    'stops exactly at the trigger after two latest results using %s costs',
    async (protocol) => {
      const tools: ModelMessage[] = ['one', 'two', 'three'].map((id, index) => ({
        role: 'tool',
        callId: id,
        content: '材料'.repeat(900 - index * 100),
        providerItems: [{ type: 'function_call_output', call_id: id, output: '文'.repeat(2000) }],
      }));
      const original: ModelMessage[] = [
        { role: 'user', content: '分析材料' },
        {
          role: 'assistant',
          content: '',
          toolCalls: tools.map((tool) => ({
            id: tool.callId!,
            name: 'read_file',
            arguments: '{}',
          })),
        },
        ...tools,
      ];
      const expected = [
        ...original.slice(0, 2),
        replacement(tools[0]),
        replacement(tools[1]),
        tools[2],
      ];
      const trigger = options.fixedTokens + estimateModelMessagesTokens(expected, protocol);
      vi.mocked(estimateModelMessagesTokens).mockClear();
      const preserve = vi.fn(preserveToolOutput);
      const summarize = vi.fn(options.summarize);

      const projected = await compactRunMessages(original, {
        ...options,
        protocol,
        trigger,
        preserveToolOutput: preserve,
        summarize,
      });

      expect(projected?.messages).toEqual(expected);
      expect(preserve.mock.calls.map(([tool]) => tool.callId)).toEqual(['one', 'two']);
      expect(summarize).toHaveBeenCalledTimes(2);
      expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(1);
    },
  );

  it('counts every occurrence when a preserved tool object is shared by earlier exchanges', async () => {
    const repeated = exchange('shared', '材料'.repeat(500));
    const original = [...repeated, ...repeated];
    const expected = [repeated[0], replacement(repeated[1]), repeated[0], replacement(repeated[1])];
    const trigger = options.fixedTokens + estimateModelMessagesTokens(expected);
    const summarize = vi.fn(async () => '过长摘要'.repeat(500));
    summarize.mockResolvedValueOnce('过长摘要'.repeat(500)).mockResolvedValueOnce('保留结论');

    const projected = await compactRunMessages(original, {
      ...options,
      trigger,
      summarize,
      preserveToolOutput,
    });

    expect(projected?.messages).toEqual(expected);
    expect(projected?.messages[1]).toBe(projected?.messages[3]);
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('keeps the original when the historical candidate grows', async () => {
    const original = [...exchange('old'), ...exchange('latest')];
    const before = structuredClone(original);

    expect(
      await compactRunMessages(original, {
        ...options,
        summarize: async () => '过长摘要'.repeat(1000),
      }),
    ).toBeUndefined();
    expect(original).toEqual(before);
    expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(2);
  });

  it('keeps the original when the latest-result replacement grows', async () => {
    const original = exchange('latest', '材料'.repeat(20));
    const before = structuredClone(original);

    expect(
      await compactRunMessages(original, {
        ...options,
        force: true,
        summarize: async () => '过长摘要'.repeat(100),
        preserveToolOutput,
      }),
    ).toBeUndefined();
    expect(original).toEqual(before);
    expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(1);
  });

  it('stops cancellation after summarization before producing a candidate', async () => {
    const original = [...exchange('old'), ...exchange('latest')];
    const before = structuredClone(original);
    const controller = new AbortController();

    await expect(
      compactRunMessages(original, {
        ...options,
        signal: controller.signal,
        summarize: async () => {
          controller.abort(new Error('任务停止'));
          return '保留结论';
        },
      }),
    ).rejects.toThrow('任务停止');
    expect(original).toEqual(before);
    expect(estimateModelMessagesTokens).toHaveBeenCalledTimes(1);
  });
});
