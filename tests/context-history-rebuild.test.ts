import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Task } from '../src/domain/types.js';
import type { ProviderArchive } from '../src/core/managed-context.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { eventually, setup } from './core-harness.js';

describe('旧工作上下文重建', () => {
  it('从原始档案修复旧版错误的位置记录，重新压缩后继续复用摘要', async () => {
    let summaries = 0, latest!: RunContext;
    const summary = '旧项目历史已整理为交接摘要';
    const { core, bot } = await setup(async context => {
      if (context.runId.includes(':summary:')) { summaries++; return { text: summary }; }
      latest = context;
      return { text: '完成', messages: [...context.messages, { role: 'user', content: context.prompt },
        { role: 'assistant', content: '完成' }] as ModelMessage[] };
    });
    const member = core.entities.saveBot({ ...bot('助手'), contextWindow: 40000, memoryMode: 'off' });
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    const turn = async (content: string) => {
      const taskId = core.tasks.send({ conversationId: room.id, content }).taskIds[0];
      await eventually(() => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed');
    };
    const compact = async () => {
      const task = await core.request('conversations.compact', { id: room.id }) as Task;
      await eventually(() => ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', task.id)?.status ?? ''));
      return core.state.storage.get<Task>('tasks', task.id)!;
    };
    await turn('ORIGINAL_HISTORY '.repeat(500));
    await turn('近期要求保留原文');
    expect(await compact()).toMatchObject({ status: 'completed', contextCompactionOutcome: 'compressed' });
    const visible = core.state.storage.messages(room.id);
    const binding = core.state.snapshot().bindings.find(item => item.conversationId === room.id)!;
    const checkpoint = core.state.snapshot().checkpoints.at(-1)!;
    const archives = core.state.storage.byField<ProviderArchive>('provider_archive', 'bindingId', binding.id);
    const legacySignature = createHash('sha256').update(JSON.stringify({ version: 3,
      instructions: latest.contextInstructions ?? latest.instructions, tools: latest.tools,
      protocol: latest.connection.protocol })).digest('hex');
    const last = visible.at(-1)!;
    const damaged = archives.flatMap(record => record.entries).map(entry => {
      const message = { ...entry.message };
      delete message.sourceMessageId; delete message.sourceSequence;
      return { messageId: last.id, sequence: last.sequence, message };
    });
    core.state.storage.put('context_checkpoints', { ...checkpoint, instructionsHash: legacySignature });
    core.state.storage.setMetadata(`history:${binding.id}`, damaged);
    core.state.storage.setMetadata(`history-validity:${binding.id}`, {
      ...core.state.storage.metadata<Record<string, unknown>>(`history-validity:${binding.id}`), signature: legacySignature,
    });
    expect(await compact()).toMatchObject({ status: 'completed', contextCompactionOutcome: 'compressed' });
    expect(summaries).toBe(2);
    expect(core.state.snapshot().checkpoints.at(-1)?.id).not.toBe(checkpoint.id);
    expect(core.state.storage.messages(room.id)).toEqual(visible);
    expect(core.state.storage.byField('provider_archive', 'bindingId', binding.id)).toEqual(archives);
    const restored = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${binding.id}`)!;
    const recent = visible.find(message => message.content === '近期要求保留原文')!;
    expect(restored.find(entry => entry.message.content.includes('近期要求保留原文')))
      .toMatchObject({ messageId: recent.id, sequence: recent.sequence });
    await turn('修复后继续');
    expect(JSON.stringify(latest.messages)).toContain(summary);
    expect(JSON.stringify(latest.messages)).not.toContain('ORIGINAL_HISTORY');
  });
});
