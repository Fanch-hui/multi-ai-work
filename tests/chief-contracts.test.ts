import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Task } from '../src/domain/types.js';
import type { ChiefInput } from '../src/domain/chief-work.js';
import { chiefRoutingPrompt } from '../src/core/chief-routing-prompt.js';
import { migrateChiefWork } from '../src/core/chief-migration.js';
import { scopedTask, returnTaskArtifacts } from '../src/core/task-access.js';
import { accessibleArtifacts } from '../src/core/tool-access.js';
import { setup } from './core-harness.js';

describe('管家公共契约', () => {
  it('较早输入在整理后恢复派发时保持较新输入的事项焦点', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const a = core.chief.contexts.create({ title: '报告 A' });
    core.chief.contexts.activate(a.id);
    const key = `chief-maintenance:${a.id}`;
    core.state.storage.setMetadata(key, { status: 'judging' });
    const first = core.chief.routing.send({ content: '补充 A', targetContextId: a.id });
    expect(core.state.storage.get<ChiefInput>('chief_inputs', first.inputId)?.status).toBe(
      'pending',
    );
    const second = core.chief.routing.send({ content: '独立事项 B', newContext: true });
    const b = core.state.storage.get<ChiefInput>('chief_inputs', second.inputId)?.contextId;
    expect(core.chief.contexts.focus().contextId).toBe(b);
    core.state.storage.setMetadata(key, { status: 'settled' });
    core.chief.routing.send({ content: '继续 B', targetContextId: b });
    expect(core.state.storage.get<ChiefInput>('chief_inputs', first.inputId)?.status).toBe(
      'dispatched',
    );
    expect(core.chief.contexts.focus().contextId).toBe(b);
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

  it('长输入保留首尾要求及候选，路由资料始终为完整 JSON', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const context = core.chief.contexts.create({ title: '报告' });
    const pending: ChiefInput = {
      id: 'long-input',
      homeConversationId: core.state.settings().mainConversationId!,
      messageId: 'long-message',
      requestId: 'long-request',
      fingerprint: 'long',
      content: `开始报告 A\n${'资料'.repeat(30000)}\n最后继续昨天报告`,
      artifactIds: [],
      focusContextId: context.id,
      status: 'pending',
      taskIds: [],
      createdAt: new Date().toISOString(),
    };
    const job = chiefRoutingPrompt(core.state, core.chief.contexts, core.chief.history, pending);
    const data = JSON.parse(job.prompt);
    expect(data.message).toContain('开始报告 A');
    expect(data.message).toContain('最后继续昨天报告');
    expect(data.contexts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: context.id })]),
    );
    expect(data.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: context.workspaceId })]),
    );
    expect(job.prompt.length).toBeLessThan(24000);
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
