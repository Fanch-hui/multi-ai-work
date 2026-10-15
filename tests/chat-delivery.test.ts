import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('群消息与主管资料', () => {
  it('普通群消息送达全群，只有用户显式指定才保存提及', async () => {
    const received = new Set<string>();
    const { core, connection, bot } = await setup(async context => { received.add(context.bot.id); return { text: '已读' }; });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
    const chiefId = core.state.settings().mainBotId!, member = bot('成员');
    const room = core.entities.createConversation({ name: '讨论', kind: 'group', chiefId,
      memberIds: [chiefId, member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const input = { conversationId: room.id, content: '给大家的消息', requestId: 'broadcast' };
    const sent = core.tasks.send(input);
    expect(core.tasks.send(input)).toEqual(sent);
    expect(sent.taskIds).toHaveLength(2);
    await eventually(() => sent.taskIds.every(taskId => core.state.storage.get<Task>('tasks', taskId)?.status === 'completed'));
    expect(received).toEqual(new Set([chiefId, member.id]));
    const message = core.state.storage.messages(room.id).find(item => item.id === sent.messageId)!;
    expect(message.mentionedBotIds).toBeUndefined();
    expect(message.targetBotIds).toEqual([chiefId, member.id]);
    core.scheduler.pause();
    const directed = core.tasks.send({ conversationId: room.id, content: '请成员补充', targetBotIds: [member.id] });
    expect(directed.taskIds).toHaveLength(1);
    expect(core.state.storage.messages(room.id).find(item => item.id === directed.messageId)?.mentionedBotIds).toEqual([member.id]);
  });

  it('主管可接收真实上传文件并通过授权成果读取，其他会话不能引用', async () => {
    let selectedPath = '', artifactId = '';
    const { core, root, connection } = await setup(async context => {
      const artifact = await context.executeTool('read_artifact', { artifactId }, 'read') as { content: string };
      expect(artifact.content).toBe('给主管的真实资料'); return { text: '资料已读' };
    }, async method => method === 'chooseFile' ? { path: selectedPath } : undefined);
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
    const roomId = core.state.settings().mainConversationId!;
    selectedPath = join(root, 'input.txt'); await writeFile(selectedPath, '给主管的真实资料');
    const attached = await core.request('conversations.attach', { conversationId: roomId }) as { artifact: Artifact };
    artifactId = attached.artifact.id;
    expect(await readFile(attached.artifact.path, 'utf8')).toBe('给主管的真实资料');
    const sent = core.tasks.send({ conversationId: roomId, content: '', artifactIds: [artifactId] });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(roomId).find(item => item.id === sent.messageId)?.artifactIds).toEqual([artifactId]);
    const other = core.entities.createConversation({ name: '其他对话', kind: 'private', memberIds: [core.state.settings().mainBotId!], workspaceId: core.state.snapshot().workspaces[0].id });
    expect(() => core.tasks.send({ conversationId: other.id, content: '读取资料', artifactIds: [artifactId] })).toThrow('当前会话');
  });
});
