import { describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import type { Bot, Conversation, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('运行中的推理强度', () => {
  it.each(['chief', 'member'] as const)(
    '%s 在请求边界读取新强度并保持当前运行快照',
    async (kind) => {
      let active: RunContext | undefined;
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { core, bot, connection } = await setup(async (context) => {
        active = context;
        await done;
        return { text: '完成' };
      });
      let room: Conversation;
      let member: Bot;
      if (kind === 'chief') {
        await core.request('chief.configure', {
          input: { connectionId: connection.id, model: 'test', reasoning: 'low' },
        });
        room = (await core.request('chief.conversations.create', {
          name: '推理切换',
        })) as Conversation;
        member = core.state.storage.get<Bot>('bots', room.chiefId!)!;
      } else {
        member = core.entities.saveBot({ ...bot('成员'), reasoning: 'low' });
        room = core.entities.createConversation({
          name: '推理切换',
          kind: 'private',
          memberIds: [member.id],
          workspaceId: core.state.snapshot().workspaces[0].id,
        });
      }
      const sent = core.tasks.send({ conversationId: room.id, content: '开始工作' });
      try {
        await eventually(() => !!active);
        expect(active!.getReasoningEffort?.()).toBe('low');
        for (const reasoning of ['high', '']) {
          if (kind === 'chief')
            await core.request('chief.conversations.update', { id: room.id, reasoning });
          else core.entities.saveBot({ ...member, reasoning: reasoning || undefined });
          expect(active!.getReasoningEffort?.()).toBe(reasoning || undefined);
          expect(active!.bot.reasoning).toBe('low');
        }
        if (kind === 'member') {
          core.entities.saveBot({ ...member, model: 'different', reasoning: 'high' });
          expect(active!.getReasoningEffort?.()).toBe('low');
        }
      } finally {
        release();
      }
      await eventually(
        () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
      );
    },
  );
});
