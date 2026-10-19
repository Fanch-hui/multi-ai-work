import { describe, expect, it } from 'vitest';
import type { Message } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

describe('任务补充接入', () => {
  it.each(['user', 'bot'] as const)('%s 补充接入原任务并重置主管跟进次数', async (authorType) => {
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const bot = createBot('处理成员');
    const room = core.entities.createConversation({
      name: '工作',
      kind: 'private',
      memberIds: [bot.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task = core.tasks.create({
      conversationId: room.id,
      botId: bot.id,
      goal: '整理资料',
    });
    const paused = core.tasks.update(task, {
      status: 'waiting_input',
      inputArtifactIds: ['existing'],
      coordinationPaused: true,
      error: '达到跟进次数上限',
    });
    core.state.storage.setMetadata(`coordination:${task.id}`, 5);
    const message: Message = core.state.storage.appendMessage({
      id: id(),
      conversationId: room.id,
      authorType,
      ...(authorType === 'bot' ? { authorBotId: bot.id } : {}),
      content: '补充要求',
      artifactIds: ['existing', 'new'],
      status: 'committed',
      createdAt: now(),
    });

    const updated = core.tasks.appendInput(paused, message);

    expect(updated).toMatchObject({
      id: task.id,
      status: 'queued',
      coordinationPaused: false,
      inputArtifactIds: ['existing', 'new'],
    });
    expect(updated.error).toBe(authorType === 'user' ? undefined : '达到跟进次数上限');
    expect(core.state.storage.metadata(`coordination:${task.id}`)).toBe(0);
    expect(core.state.snapshot().taskInputs).toEqual([
      expect.objectContaining({ taskId: task.id, messageId: message.id, status: 'pending' }),
    ]);
  });
});
