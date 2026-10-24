import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedHistory, type ProviderArchive } from '../src/core/managed-history.js';
import { Storage } from '../src/core/storage.js';
import type { State } from '../src/core/state.js';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Message, Run, SessionBinding } from '../src/domain/types.js';
import { ContextManager, type ContextInput } from '../src/runtime/context.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const marker: ModelMessage = {
  role: 'assistant',
  content: '',
  reasoningUpdate: { baseline: 'baseline-internal-only', effort: 'effort-internal-only' },
};

function storedMessage(
  id: string,
  sequence: number,
  authorType: Message['authorType'],
  content: string,
  runId?: string,
): Omit<Message, 'sequence'> {
  return {
    id,
    conversationId: 'room',
    authorType,
    ...(authorType === 'bot' ? { authorBotId: 'bot' } : {}),
    ...(runId ? { runId } : {}),
    content,
    artifactIds: [],
    status: 'committed',
    createdAt: `2026-10-22T00:00:0${sequence}Z`,
  };
}

const binding: SessionBinding = {
  id: 'binding',
  botId: 'bot',
  conversationId: 'room',
  connectionId: 'connection',
  generation: 1,
  configRevision: 1,
  connectionRevision: 1,
  workspaceId: 'workspace',
  lastDeliveredSequence: 0,
};

function modelHistory(): ModelHistoryEntry[] {
  return [
    {
      messageId: 'user-1',
      sequence: 1,
      message: { role: 'user', content: '历史背景'.repeat(500) },
    },
    { messageId: 'reply-1', sequence: 2, message: marker },
    {
      messageId: 'reply-1',
      sequence: 2,
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old-read', name: 'read_file', arguments: '{"path":"notes"}' }],
      },
    },
    {
      messageId: 'reply-1',
      sequence: 2,
      message: {
        role: 'tool',
        callId: 'old-read',
        content: '历史工具原始结果'.repeat(160),
        providerItems: [
          { type: 'function_call_output', call_id: 'old-read', output: 'raw-provider-result' },
        ],
      },
    },
    {
      messageId: 'user-2',
      sequence: 3,
      message: { role: 'user', content: '最新用户要求：保留完整工具配对' },
    },
    { messageId: 'reply-2', sequence: 4, message: marker },
  ];
}

function archiveMessages(): Message[] {
  return [
    { ...storedMessage('user-1', 1, 'user', '历史背景'.repeat(500)), sequence: 1 },
    { ...storedMessage('reply-1', 2, 'bot', '已读取历史资料'), sequence: 2 },
    { ...storedMessage('user-2', 3, 'user', '最新用户要求：保留完整工具配对'), sequence: 3 },
    { ...storedMessage('reply-2', 4, 'bot', '最新轮配置'), sequence: 4 },
  ];
}

function contextInput(messages: Message[], history: ModelHistoryEntry[]): ContextInput {
  return {
    binding,
    messages,
    instructions: '使用中文整理工作历史',
    tools: [],
    protocol: 'responses',
    history,
    historyIsCurrent: true,
    contextWindow: 40000,
    force: true,
    signal: new AbortController().signal,
    summarize: async () => '旧背景和已完成读取已整理。',
  };
}

describe('推理配置历史与压缩', () => {
  it('真实压缩时摘要忽略配置标记，保留工具配对与最新用户要求', async () => {
    const messages = archiveMessages();
    let summaryPrompt = '';
    const manager = new ContextManager({
      getCheckpoint: () => undefined,
      saveCheckpoint: () => {},
    });
    const prepared = await manager.prepare({
      ...contextInput(messages, modelHistory()),
      summarize: async (prompt) => {
        summaryPrompt = prompt;
        return '旧背景和已完成读取已整理。';
      },
    });

    expect(prepared.compaction?.status).toBe('completed');
    expect(summaryPrompt).toContain('read_file');
    expect(summaryPrompt).toContain('历史工具原始结果');
    expect(summaryPrompt).not.toContain('baseline-internal-only');
    expect(summaryPrompt).not.toContain('effort-internal-only');
    expect(prepared.messages.at(-1)).toMatchObject({
      role: 'user',
      content: '最新用户要求：保留完整工具配对',
    });
    expect(prepared.messages.some((message) => message.reasoningUpdate)).toBe(false);
    expect(prepared.checkpoint?.sourceMessageIds).toEqual(['user-1', 'reply-1']);
  });

  it.each(['summary_failed', 'source_changed'])('%s 时保留最新轮配置与原基线', async (reason) => {
    const messages = archiveMessages();
    const history = modelHistory();
    const originalMessages = structuredClone(messages);
    const originalHistory = structuredClone(history);
    let saved: unknown;
    const manager = new ContextManager({
      getCheckpoint: () => undefined,
      saveCheckpoint: (checkpoint) => {
        saved = checkpoint;
      },
    });
    const prepared = await manager.prepare({
      ...contextInput(messages, history),
      isSourceCurrent: () => reason !== 'source_changed',
      summarize: async () => {
        if (reason === 'summary_failed') throw new Error('summary unavailable');
        return '旧背景和已完成读取已整理。';
      },
    });

    expect(prepared.compaction).toMatchObject({ status: 'failed', reason });
    expect(prepared.messages).toEqual(
      history.map((entry) => ({
        ...entry.message,
        sourceMessageId: entry.messageId,
        sourceSequence: entry.sequence,
      })),
    );
    expect(messages).toEqual(originalMessages);
    expect(history).toEqual(originalHistory);
    expect(saved).toBeUndefined();
  });

  it('run 内压缩跳过配置标记并保留最新用户要求和完整工具交换', async () => {
    const oldToolCall: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'old', name: 'read_file', arguments: '{}' }],
    };
    const oldToolResult: ModelMessage = {
      role: 'tool',
      callId: 'old',
      content: '较早工具结果'.repeat(1800),
    };
    const latestCall: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'latest', name: 'read_file', arguments: '{"path":"final"}' }],
    };
    const latestResult: ModelMessage = {
      role: 'tool',
      callId: 'latest',
      content: '最新工具结果',
    };
    const original: ModelMessage[] = [
      { role: 'assistant', content: '早期背景'.repeat(1600) },
      marker,
      oldToolCall,
      oldToolResult,
      { role: 'user', content: '最新用户要求：输出最终清单' },
      latestCall,
      latestResult,
    ];
    const before = structuredClone(original);
    let summaryPrompt = '';
    const projected = await compactRunMessages(original, {
      currentStart: 0,
      force: false,
      budget: 9000,
      trigger: 6500,
      fixedTokens: 100,
      protocol: 'responses',
      signal: new AbortController().signal,
      summarize: async (prompt) => {
        summaryPrompt = prompt;
        return '早期背景和工具结果已整理。';
      },
    });

    expect(projected).toBeDefined();
    expect(summaryPrompt).toContain('较早工具结果');
    expect(summaryPrompt).not.toContain('baseline-internal-only');
    expect(summaryPrompt).not.toContain('effort-internal-only');
    expect(projected!.messages).toContainEqual({
      role: 'user',
      content: '最新用户要求：输出最终清单',
    });
    expect(projected!.messages.slice(-2)).toEqual([latestCall, latestResult]);
    expect(original).toEqual(before);
  });

  it('持久历史重新打开后保留配置标记和工具原始结果', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reasoning-context-history-'));
    const databasePath = join(directory, 'history.sqlite');
    const storage = new Storage(databasePath);
    let activeStorage: Storage | undefined = storage;
    cleanups.push(() => {
      activeStorage?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const user = storage.appendMessage(storedMessage('user-1', 1, 'user', '执行读取'));
    const reply = storage.appendMessage(storedMessage('reply-1', 2, 'bot', '已读取', 'run-1'));
    storage.put('runs', { id: 'run-1' } as Run);
    const input = {
      runId: 'run-1',
      binding: { ...binding, conversationId: 'room' },
      bot: { id: 'bot' },
      connection: { protocol: 'responses' },
      messages: [],
      instructions: 'instructions',
      tools: [],
    } as unknown as RunContext;
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: '执行读取',
        sourceMessageId: user.id,
        sourceSequence: user.sequence,
      },
      {
        ...marker,
        sourceMessageId: reply.id,
        sourceSequence: reply.sequence,
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"notes"}' }],
        sourceMessageId: reply.id,
        sourceSequence: reply.sequence,
      },
      {
        role: 'tool',
        callId: 'call-1',
        content: '完整原始工具结果',
        providerItems: [
          { type: 'function_call_output', call_id: 'call-1', output: '完整协议结果' },
        ],
        sourceMessageId: reply.id,
        sourceSequence: reply.sequence,
      },
    ];
    const histories = new ManagedHistory({ storage } as State);
    storage.transaction(() =>
      histories.commit({
        input,
        messages,
        draft: reply,
        cutoff: user.sequence,
        output: '已读取',
      }),
    );
    const expectedArchive = storage.byField<ProviderArchive>(
      'provider_archive',
      'bindingId',
      binding.id,
    );

    storage.close();
    activeStorage = undefined;
    const reopened = new Storage(databasePath);
    activeStorage = reopened;
    const restored = new ManagedHistory({ storage: reopened } as State).load(
      input,
      reopened.messages('room'),
      reply.sequence,
    );

    expect(restored.historyIsCurrent).toBe(true);
    expect(restored.history).toEqual(
      messages.map((message, index) => ({
        messageId: index === 0 ? user.id : reply.id,
        sequence: index === 0 ? user.sequence : reply.sequence,
        message,
      })),
    );
    expect(restored.loadArchiveHistory()).toEqual(
      expectedArchive.flatMap((record) => record.entries),
    );
    expect(restored.loadArchiveHistory()).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          reasoningUpdate: marker.reasoningUpdate,
          content: '',
        }),
      }),
    );
    expect(JSON.stringify(restored.loadArchiveHistory())).toContain('完整协议结果');
  });
});
