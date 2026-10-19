import { describe, expect, it } from 'vitest';
import type { ProviderResult, ManagedProgress, ModelMessage } from '../src/domain/provider.js';
import type { Task } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { eventually, setup } from './core-harness.js';

describe('Core 工作上下文', () => {
  it('reuses the saved working projection and rebuilds raw history after memory revocation', async () => {
    const seen: string[] = [];
    const { core, bot } = await setup(async (context) => {
      seen.push(JSON.stringify(context.messages));
      const user: ModelMessage = { role: 'user', content: context.prompt };
      const answer: ModelMessage = { role: 'assistant', content: '完成' };
      if (seen.length === 1)
        return {
          text: answer.content,
          messages: [
            user,
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}' }],
            },
            { role: 'tool', callId: 'read', content: '原始工具证据' },
            answer,
          ],
          contextMessages: [
            user,
            { role: 'assistant', content: '工作摘要含旧约定', contextSummary: true },
            answer,
          ],
        };
      return {
        text: answer.content,
        messages: [...context.messages, user, answer],
        contextMessages: [...context.messages, user, answer],
      };
    });
    const member = bot('摘要助手');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const memory = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      content: '采用旧约定',
      allowedConversationIds: [room.id],
    });
    const turn = async () => {
      const task = core.tasks.send({ conversationId: room.id, content: '继续处理' }).taskIds[0];
      await eventually(() => core.state.storage.get<Task>('tasks', task)?.status === 'completed');
    };
    await turn();
    await turn();
    expect(seen[1]).toContain('工作摘要含旧约定');
    expect(seen[1]).not.toContain('原始工具证据');
    core.memories.revoke(memory.id);
    await turn();
    expect(seen[2]).not.toContain('工作摘要含旧约定');
    expect(seen[2]).toContain('原始工具证据');
  });

  it('rebuilds an interrupted run from its raw ledger when memory was revoked', async () => {
    let resumed: ManagedProgress | undefined;
    let first = true;
    const { core, bot } = await setup(async (context) => {
      if (first) {
        first = false;
        const user: ModelMessage = { role: 'user', content: context.prompt };
        await context.saveProgress!({
          messages: [
            user,
            { role: 'assistant', content: '含已撤销记忆的摘要', contextSummary: true },
          ],
          currentStart: 0,
          archiveStart: 0,
          contextSignature: context.contextSignature,
          compaction: {
            archived: [user, { role: 'assistant', content: '原始完成证据' }],
            start: 2,
          },
          text: '',
          pendingInputIds: [],
          turnId: 'before-crash',
          attempt: 0,
          phase: 'ready',
        });
        throw new Error('durable interrupted run');
      }
      resumed = context.progress;
      return {
        text: '完成',
        messages: [...context.progress!.messages, { role: 'assistant', content: '完成' }],
      };
    });
    const member = bot('恢复助手');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const memory = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      content: '旧约定',
      allowedConversationIds: [room.id],
    });
    const taskId = core.tasks.send({ conversationId: room.id, content: '处理资料' }).taskIds[0];
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'failed');
    core.memories.revoke(memory.id);
    await core.request('tasks.retry', { id: taskId });
    await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
    expect(resumed?.compaction).toBeUndefined();
    expect(JSON.stringify(resumed?.messages)).not.toContain('含已撤销记忆的摘要');
    expect(JSON.stringify(resumed?.messages)).toContain('原始完成证据');
  });

  it('连续整理保留来源、仅注入一个检查点，并计入摘要用量', async () => {
    const { core, bot } = await setup(async (context) => {
      const summary = context.runId.includes(':summary:');
      const usage = {
        inputTokens: summary ? 20 : 10,
        outputTokens: summary ? 5 : 10,
        source: 'reported' as const,
      };
      context.emit({
        type: 'status',
        data: { phase: 'model-request', step: 1, requestId: `${context.runId}:1` },
      });
      context.emit({
        type: 'status',
        data: {
          phase: 'model-response',
          step: 1,
          requestId: `${context.runId}:1`,
          durationMs: summary ? 500 : 100,
          usage,
        },
      });
      context.emit({ type: 'usage', data: { ...usage } });
      if (summary) return { text: '用户约束及未完成事项已保留。', usage };
      const text = '工作结果'.repeat(100);
      const result: ProviderResult = {
        text,
        usage: { inputTokens: 10, outputTokens: 10, source: 'reported' },
        messages: [
          ...context.messages,
          { role: 'user', content: context.prompt },
          { role: 'assistant', content: text },
        ],
      };
      return result;
    });
    const member = core.entities.saveBot({ ...bot('助手'), contextWindow: 6000 });
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    async function turn(content: string) {
      const sent = core.tasks.send({ conversationId: room.id, content });
      await eventually(
        () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
      );
      return core.state.snapshot().runs.find((run) => run.taskId === sent.taskIds[0])!;
    }
    await turn('资料'.repeat(300));
    await turn('事实'.repeat(300));
    const third = await turn('开始交付');
    expect(core.state.snapshot().checkpoints).toHaveLength(1);
    expect(third.usage).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(third.modelRequestCount).toBe(2);
    expect(third.modelDurationMs).toBe(100);
    expect(third.metrics).toMatchObject({
      requests: 2,
      summaryRequests: 1,
      usageRequests: 2,
      usage: { inputTokens: 30, outputTokens: 15 },
      rate: { outputTokens: 10, durationMs: 100, requests: 1 },
    });
    await turn('后续'.repeat(300));
    const snapshot = core.state.snapshot();
    expect(snapshot.checkpoints).toHaveLength(2);
    expect(snapshot.compactions.every((operation) => operation.status === 'completed')).toBe(true);
    const history = core.state.storage.metadata<ModelHistoryEntry[]>(
      `history:${snapshot.bindings[0].id}`,
    )!;
    expect(
      history.filter((entry) => entry.message.content.startsWith('此前对话摘要（历史资料）')),
    ).toHaveLength(1);
    const checkpoint = snapshot.checkpoints[1];
    expect(checkpoint.sourceMessageIds).toContain(snapshot.messages[0].id);
    expect(checkpoint.sourceMessageIds).toContain(snapshot.messages[3].id);
    expect(snapshot.messages).toHaveLength(8);
  });
});
