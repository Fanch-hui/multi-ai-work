import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bot, Skill, Task, ToolConnection } from '../src/domain/types.js';
import { setup } from './core-harness.js';

async function fixture() {
  const result = await setup(async () => ({ text: '完成' }));
  const { core, bot } = result;
  core.scheduler.pause();
  const member = bot('助手');
  const other = bot('其他成员');
  const skillPath = join(result.root, 'SKILL.md');
  await writeFile(skillPath, '按来源编写周报');
  core.state.storage.put<Skill>('skills', {
    id: 'skill',
    name: '周报',
    content: '按来源编写周报',
    path: skillPath,
  });
  core.state.storage.put<ToolConnection>('tool_connections', {
    id: 'connector',
    name: '资料服务',
    kind: 'mcp',
    url: 'https://example.com/mcp',
    enabled: true,
    status: 'ready',
    toolNames: [],
  });
  core.state.storage.put<Bot>('bots', {
    ...member,
    skillIds: ['skill'],
    toolConnectionIds: ['connector'],
  });
  const room = core.entities.createConversation({
    name: '工作',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  return { ...result, member, other, room };
}
describe('聊天明确引用', () => {
  it('只列出接收成员获准的资源，引用保存至消息并进入任务要求', async () => {
    const { core, room } = await fixture();
    const options = (await core.request('conversations.references', {
      conversationId: room.id,
    })) as { kind: string; id: string }[];
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', id: 'skill' }),
        expect.objectContaining({ kind: 'connector', id: 'connector' }),
      ]),
    );
    const sent = (await core.request('conversations.send', {
      conversationId: room.id,
      content: '生成本周报告',
      references: [
        { kind: 'skill', id: 'skill' },
        { kind: 'connector', id: 'connector' },
      ],
    })) as { messageId: string; taskIds: string[] };
    expect(core.state.storage.getMessage(sent.messageId)?.references).toHaveLength(2);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.goal).toContain('技能：周报');
  });
  it('资源更名后重发同一请求仍保持幂等', async () => {
    const { core, room } = await fixture();
    const input = {
      conversationId: room.id,
      content: '整理资料',
      requestId: 'stable-reference',
      references: [{ kind: 'skill' as const, id: 'skill' }],
    };
    const sent = core.tasks.send(input);
    const skill = core.state.storage.get<Skill>('skills', 'skill')!;
    core.state.storage.put('skills', { ...skill, name: '团队周报' });
    expect(core.tasks.send(input)).toEqual(sent);
    expect(core.state.storage.messages(room.id)).toHaveLength(1);
  });
  it('拒绝过期权限与跨会话回复，并保持用户消息未写入', async () => {
    const { core, room, other } = await fixture();
    const privateRoom = core.entities.createConversation({
      name: '另一个私聊',
      kind: 'private',
      memberIds: [other.id],
      workspaceId: room.workspaceId,
    });
    const foreign = core.tasks.send({ conversationId: privateRoom.id, content: '私聊' });
    await expect(
      core.request('conversations.send', {
        conversationId: room.id,
        content: '回复',
        replyToMessageId: foreign.messageId,
      }),
    ).rejects.toThrow('当前会话');
    await expect(
      core.request('conversations.send', {
        conversationId: privateRoom.id,
        content: '读取',
        references: [{ kind: 'skill', id: 'skill' }],
      }),
    ).rejects.toThrow('未获授权');
    expect(core.state.storage.messages(room.id)).toHaveLength(0);
  });
  it('群内回复具体成员，保留消息原文与幂等标识', async () => {
    const { core, member, other } = await fixture();
    const room = core.entities.createConversation({
      name: '群',
      kind: 'group',
      chiefId: member.id,
      memberIds: [member.id, other.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const message = core.state.storage.appendMessage({
      id: 'answer',
      conversationId: room.id,
      authorType: 'bot',
      authorBotId: other.id,
      content: '请确认标题',
      artifactIds: [],
      status: 'committed',
      createdAt: new Date().toISOString(),
    });
    const input = {
      conversationId: room.id,
      content: '用第一版',
      replyToMessageId: message.id,
      requestId: 'reply-once',
    };
    const sent = core.tasks.send(input);
    expect(core.tasks.send(input)).toEqual(sent);
    const reply = core.state.storage.getMessage(sent.messageId)!;
    expect(reply).toMatchObject({
      content: '用第一版',
      replyToMessageId: 'answer',
      targetBotIds: [other.id],
    });
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.goal).toContain('请确认标题');
  });
});
