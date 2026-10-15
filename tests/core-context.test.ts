import { describe, expect, it } from 'vitest';
import type { ProviderResult } from '../src/domain/provider.js';
import type { Task } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { eventually, setup } from './core-harness.js';

describe('Core 工作上下文', () => {
  it('连续整理保留来源、仅注入一个检查点，并计入摘要用量', async () => {
    const { core, bot } = await setup(async context => {
      const summary = context.runId.includes(':summary:');
      const usage = { inputTokens: summary ? 20 : 10, outputTokens: summary ? 5 : 10, source: 'reported' as const };
      context.emit({ type: 'status', data: { phase: 'model-request', step: 1, requestId: `${context.runId}:1` } });
      context.emit({ type: 'status', data: { phase: 'model-response', step: 1, requestId: `${context.runId}:1`, durationMs: summary ? 500 : 100, usage } });
      context.emit({ type: 'usage', data: { ...usage } });
      if (summary) return { text: '用户约束及未完成事项已保留。', usage };
      const text = '工作结果'.repeat(100);
      const result: ProviderResult = { text, usage: { inputTokens: 10, outputTokens: 10, source: 'reported' },
        messages: [...context.messages, { role: 'user', content: context.prompt }, { role: 'assistant', content: text }] };
      return result;
    });
    const member = core.entities.saveBot({ ...bot('助手'), contextWindow: 4000 });
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    async function turn(content: string) {
      const sent = core.tasks.send({ conversationId: room.id, content });
      await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
      return core.state.snapshot().runs.find(run => run.taskId === sent.taskIds[0])!;
    }
    await turn('资料'.repeat(300)); await turn('事实'.repeat(300));
    const third = await turn('开始交付');
    expect(core.state.snapshot().checkpoints).toHaveLength(1);
    expect(third.usage).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(third.modelRequestCount).toBe(2);
    expect(third.modelDurationMs).toBe(100);
    expect(third.metrics).toMatchObject({ requests: 2, summaryRequests: 1, usageRequests: 2,
      usage: { inputTokens: 30, outputTokens: 15 }, rate: { outputTokens: 10, durationMs: 100, requests: 1 } });
    await turn('后续'.repeat(300));
    const snapshot = core.state.snapshot();
    expect(snapshot.checkpoints).toHaveLength(2);
    expect(snapshot.compactions.every(operation => operation.status === 'completed')).toBe(true);
    const history = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${snapshot.bindings[0].id}`)!;
    expect(history.filter(entry => entry.message.content.startsWith('此前对话摘要（历史资料）'))).toHaveLength(1);
    const checkpoint = snapshot.checkpoints[1];
    expect(checkpoint.sourceMessageIds).toContain(snapshot.messages[0].id);
    expect(checkpoint.sourceMessageIds).toContain(snapshot.messages[3].id);
    expect(snapshot.messages).toHaveLength(8);
  });
});
