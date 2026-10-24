import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Task } from '../src/domain/types.js';
import type { ChiefInput } from '../src/domain/chief-work.js';
import { migrateChiefWork } from '../src/core/chief-migration.js';
import { scopedTask, returnTaskArtifacts } from '../src/core/task-access.js';
import { accessibleArtifacts } from '../src/core/tool-access.js';
import { setup } from './core-harness.js';

describe('管家公共契约', () => {
  it('主段整理期间输入按提交顺序接入连续上下文，历史引用保持独立', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const historical = core.chief.contexts.create({ kind: 'history', title: '报告 A' });
    const main = core.chief.contexts.main();
    const key = `chief-maintenance:${main.context.id}`;
    core.state.storage.setMetadata(key, { status: 'judging' });
    const first = core.chief.routing.send({ content: '补充 A', targetContextId: historical.id });
    const second = core.chief.routing.send({ content: '另外讨论 B', newContext: true });
    for (const sent of [first, second]) {
      expect(core.state.storage.get<ChiefInput>('chief_inputs', sent.inputId)?.status).toBe(
        'pending',
      );
      expect(core.state.storage.getMessage(sent.messageId)).toBeUndefined();
    }
    core.state.storage.setMetadata(key, { status: 'settled' });
    const third = core.chief.routing.send({ content: '继续刚才的讨论' });
    const messages = core.state.storage
      .messages(main.room.id)
      .filter((message) => message.authorType === 'user');
    expect(messages.map((message) => message.id)).toEqual([
      first.messageId,
      second.messageId,
      third.messageId,
    ]);
    for (const sent of [first, second, third])
      expect(core.state.storage.get<ChiefInput>('chief_inputs', sent.inputId)).toMatchObject({
        status: 'dispatched',
        contextId: main.context.id,
      });
    expect(core.chief.contexts.main().context.id).toBe(main.context.id);
    expect(core.chief.contexts.list().filter((context) => context.kind === 'work')).toEqual([]);
  });

  it('所有配置入口共用跨事项模型门禁，同模型推理强度可调整', async () => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const chief = bot('Chief');
    const context = core.chief.contexts.create({ title: '后台报告' });
    const task = core.tasks.create({
      conversationId: context.conversationId,
      botId: chief.id,
      goal: '生成报告',
    });
    await expect(core.request('chief.configure', { input: { model: 'another' } })).rejects.toThrow(
      '结束或停止',
    );
    expect(() => core.entities.saveBot({ ...chief, model: 'another' })).toThrow('结束或停止');
    const other = await core.entities.saveConnection({
      name: '另一个连接',
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:7778',
    });
    core.state.storage.put('connections', { ...other, status: 'ready' });
    expect(() => core.entities.saveBot({ ...chief, connectionId: other.id })).toThrow('结束或停止');
    core.team.updateChiefConversation(core.state.settings().mainConversationId!, {
      reasoning: 'high',
    });
    expect(core.state.storage.get<Bot>('bots', chief.id)?.reasoning).toBe('high');
    expect(core.state.storage.get<Bot>('bots', chief.id)?.connectionId).toBe(connection.id);
    core.state.storage.put('tasks', { ...task, status: 'completed' });
    expect(core.entities.saveBot({ ...chief, model: 'another' }).model).toBe('another');
  });

  it('长输入的原文完整保存并直接进入主段，首尾要求与消息锚点稳定', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const content = `开始报告 A\n${'资料'.repeat(30000)}\n最后继续昨天报告`;
    const sent = core.chief.routing.send({ content, requestId: 'long-input' });
    const message = core.state.storage.getMessage(sent.messageId)!;
    expect(message.content).toBe(content);
    expect(message.conversationId).toBe(core.chief.contexts.main().room.id);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.goal).toContain(content);
    expect(core.state.storage.get<ChiefInput>('chief_inputs', sent.inputId)).toMatchObject({
      status: 'dispatched',
      messageId: message.id,
    });
    expect(
      core.state.storage.get<ChiefInput>('chief_inputs', sent.inputId)?.content,
    ).toBeUndefined();
    expect(
      core.state.storage.all<Task>('tasks').some((task) => task.kind === 'chief-routing'),
    ).toBe(false);
  });

  it('跨段访问旧任务与显式绑定群，其他事项仍需确切历史授权', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const chief = bot('Chief');
    const first = core.chief.contexts.create({ title: '报告 A' });
    const source = core.tasks.create({
      conversationId: first.conversationId,
      botId: chief.id,
      goal: '报告 A',
    });
    const member = bot('成员');
    const group = core.team.createTaskGroup(source, {
      name: '报告群',
      goal: '核对',
      memberIds: [member.id],
    });
    for (const task of core.state.storage.all<Task>('tasks'))
      core.state.storage.put('tasks', { ...task, status: 'completed' });
    const next = core.chief.contexts.rotate(first.id, '继续报告', [], []);
    const room = core.state.storage.get<Conversation>('conversations', next.conversationId)!;
    expect(scopedTask(core.state, room, chief.id, source.id)?.id).toBe(source.id);
    expect(scopedTask(core.state, room, chief.id, group.task.id)?.id).toBe(group.task.id);
    const other = core.chief.contexts.create({ title: '事项 B' });
    const unrelated = core.tasks.create({
      conversationId: other.conversationId,
      botId: chief.id,
      goal: 'B',
    });
    expect(scopedTask(core.state, room, chief.id, unrelated.id)).toBeUndefined();
    core.state.storage.setMetadata(`chief-task-grants:${room.id}`, [unrelated.id]);
    expect(scopedTask(core.state, room, chief.id, unrelated.id)?.id).toBe(unrelated.id);
    core.state.storage.put('artifacts', {
      id: 'old-report',
      conversationId: other.conversationId,
      taskId: unrelated.id,
    });
    returnTaskArtifacts(core.state, room, chief.id, unrelated, ['old-report', 'missing']);
    expect(accessibleArtifacts(core.state, room, chief.id).map((item) => item.id)).toContain(
      'old-report',
    );
    expect(scopedTask(core.state, room, member.id, source.id)).toBeUndefined();
    core.state.storage.put('artifacts', {
      id: 'group-file',
      conversationId: group.conversation.id,
      taskId: group.task.id,
    });
    returnTaskArtifacts(core.state, room, chief.id, source, ['group-file']);
    expect(accessibleArtifacts(core.state, room, chief.id).map((item) => item.id)).toContain(
      'group-file',
    );
    returnTaskArtifacts(core.state, room, chief.id, group.task, ['group-file', 'missing']);
    expect(accessibleArtifacts(core.state, room, chief.id).map((item) => item.id)).toContain(
      'group-file',
    );
  });

  it('旧数据只有例行工作会话时建立独立固定入口，重复迁移映射稳定', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const s = core.state.storage;
    const oldId = core.state.settings().mainConversationId!;
    const old = s.get<Conversation>('conversations', oldId)!;
    s.db.exec(
      'DELETE FROM chief_contexts; DELETE FROM chief_parts; DELETE FROM chief_inputs; DELETE FROM chief_timeline;',
    );
    s.setMetadata('chief-work-v1', false);
    s.put('conversations', {
      ...old,
      chiefRole: undefined,
      chiefContextId: undefined,
      chiefHomeId: undefined,
    });
    s.put('routines', { id: 'daily', conversationId: oldId });
    migrateChiefWork(core.state);
    const homeId = core.state.settings().mainConversationId!;
    expect(homeId).not.toBe(oldId);
    expect(s.get<Conversation>('conversations', oldId)?.chiefRole).toBe('routine');
    expect(s.get<Conversation>('conversations', homeId)?.chiefRole).toBe('home');
    const mapping = core.chief.contexts.list();
    migrateChiefWork(core.state);
    expect(core.chief.contexts.list()).toEqual(mapping);
    expect(core.state.settings().mainConversationId).toBe(homeId);
  });
});
