import { describe, expect, it } from 'vitest';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Bot, Connection, Conversation, Task } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { conversationStatistics } from '../apps/ui/src/conversation-statistics.js';
import { eventually, setup } from './core-harness.js';

async function turn(core: Awaited<ReturnType<typeof setup>>['core'], conversationId: string, content: string) {
  const taskId = core.tasks.send({ conversationId, content }).taskIds[0];
  await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
}

function answer(context: RunContext) {
  const text = '整理结果'.repeat(150);
  return { text, messages: [...context.messages, { role: 'user', content: context.prompt },
    { role: 'assistant', content: text }] as ModelMessage[] };
}

describe('手动上下文压缩', () => {
  it('提前压缩并持久保存，保留聊天记录，压缩期间的新消息排队后使用摘要', async () => {
    let started = false, finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const seen: string[] = [];
    const { core, bot } = await setup(async context => {
      if (context.runId.includes(':summary:')) {
        started = true;
        await ready;
        context.emit({ type: 'status', data: { phase: 'model-request', step: 1 } });
        context.emit({ type: 'status', data: { phase: 'model-response', step: 1, durationMs: 20,
          usage: { source: 'reported', inputTokens: 100, outputTokens: 10 } } });
        expect(context.tools).toEqual([]);
        return { text: '较早对话已整理为摘要', usage: { source: 'reported' as const, inputTokens: 100, outputTokens: 10 } };
      }
      seen.push(JSON.stringify(context.messages));
      return answer(context);
    });
    const member = core.entities.saveBot({ ...bot('助手', ['ask_user']), contextWindow: 40000 });
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    await turn(core, room.id, '早期资料'.repeat(250));
    await turn(core, room.id, '近期要求请保留原文');
    const before = core.state.storage.messages(room.id);
    const archiveBefore = core.state.storage.all('provider_archive');
    const binding = core.state.snapshot().bindings.find(binding => binding.conversationId === room.id)!;
    const compact = await core.request('conversations.compact', { id: room.id }) as Task;
    await eventually(() => started);
    expect((await core.request('conversations.compact', { id: room.id }) as Task).id).toBe(compact.id);
    const sent = core.tasks.send({ conversationId: room.id, content: '压缩后继续的新消息' });
    expect(sent.taskIds[0]).not.toBe(compact.id);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status).toBe('queued');
    expect(core.state.storage.messages(room.id).slice(0, before.length)).toEqual(before);
    finish();
    await eventually(() => core.state.storage.get<Task>('tasks', compact.id)?.status === 'completed');
    const checkpoint = core.state.snapshot().checkpoints.at(-1)!;
    expect(checkpoint.content).toContain('较早对话已整理为摘要');
    expect(core.state.storage.messages(room.id).slice(0, before.length)).toEqual(before);
    expect(core.state.storage.all('provider_archive').slice(0, archiveBefore.length)).toEqual(archiveBefore);
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(seen.at(-1)).toContain('较早对话已整理为摘要');
    expect(seen.at(-1)).toContain('近期要求请保留原文');
    expect(seen.at(-1)).not.toContain('手动压缩上下文');
    const snapshot = core.state.snapshot();
    expect(snapshot.bindings.find(item => item.id === binding.id)?.generation).toBe(binding.generation);
    const run = snapshot.runs.find(run => run.taskId === compact.id)!;
    expect(run.metrics).toMatchObject({ requests: 1, summaryRequests: 1 });
    expect(run.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(conversationStatistics(snapshot, room).turns).toBe(3);
  });

  it('摘要失败保留原工作上下文与聊天记录', async () => {
    const { core, bot } = await setup(async context => {
      if (context.runId.includes(':summary:')) throw new Error('summary unavailable');
      return answer(context);
    });
    const member = core.entities.saveBot({ ...bot('助手'), contextWindow: 40000 });
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    await turn(core, room.id, '早期资料'.repeat(250)); await turn(core, room.id, '近期内容');
    const before = core.state.storage.messages(room.id);
    const binding = core.state.snapshot().bindings.find(binding => binding.conversationId === room.id)!;
    const history = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${binding.id}`);
    const compact = await core.request('conversations.compact', { id: room.id }) as Task;
    await eventually(() => core.state.storage.get<Task>('tasks', compact.id)?.status === 'failed');
    expect(core.state.storage.get<Task>('tasks', compact.id)?.error).toContain('摘要生成未完成');
    expect(core.state.storage.metadata(`history:${binding.id}`)).toEqual(history);
    expect(core.state.storage.messages(room.id)).toEqual(before);
    expect(core.state.snapshot().checkpoints).toHaveLength(0);
  });

  it('仅接受空闲的托管单成员对话', async () => {
    const { core, bot, connection } = await setup(async context => answer(context));
    const member: Bot = bot('助手');
    const room: Conversation = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    await expect(core.request('conversations.compact', { id: room.id })).rejects.toThrow('设置上下文窗口');
    core.entities.saveBot({ ...member, contextWindow: 40000 });
    await expect(core.request('conversations.compact', { id: room.id })).rejects.toThrow('当前历史较少');
    core.tasks.send({ conversationId: room.id, content: '正在工作' });
    await expect(core.request('conversations.compact', { id: room.id })).rejects.toThrow('当前对话任务结束');
    core.state.storage.put('connections', { ...connection, provider: 'qoder', status: 'ready' } as Connection);
    await expect(core.request('conversations.compact', { id: room.id })).rejects.toThrow('原生运行时管理');
  });
});
