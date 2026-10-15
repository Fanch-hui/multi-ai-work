import { describe, expect, it } from 'vitest';
import type { Task, UserQuestion } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { resources, setup, eventually } from './core-harness.js';

describe('持久用户问答', () => {
  it('等待时释放执行，回答继续同任务且重复回答不重复执行', async () => {
    let rounds = 0;
    const { core, bot } = await setup(async context => {
      if (++rounds === 1) {
        const input = { question: '报告用哪种格式？', options: [{ label: 'Markdown' }, { label: 'PDF' }] };
        const result = await context.executeTool('ask_user', input, 'ask');
        expect(await context.executeTool('ask_user', input, 'ask')).toEqual(result);
        return { text: '' };
      }
      expect(context.prompt).toContain('Markdown'); return { text: '按 Markdown 继续完成' };
    });
    const member = bot('助手', ['ask_user']);
    const room = core.entities.createConversation({ name: '任务', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '写报告' });
    await eventually(() => core.state.snapshot().runs[0]?.status === 'waiting_input' && !core.scheduler.hasActive());
    const question = core.state.snapshot().questions[0];
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])!.status).toBe('waiting_input');
    await core.request('questions.answer', { id: question.id, answer: 'Markdown' });
    await core.request('questions.answer', { id: question.id, answer: 'Markdown' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])!.status === 'completed');
    expect(rounds).toBe(2); expect(core.state.snapshot().tasks).toHaveLength(1);
    expect(core.state.snapshot().messages.filter(item => item.authorType === 'user')).toHaveLength(2);
    expect(core.state.snapshot().approvals).toHaveLength(0);
  });

  it('App 重启后问题仍可回答并继续原任务', async () => {
    const first = await setup(async context => {
      await context.executeTool('ask_user', { question: '请补充标题' }, 'ask');
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      context.signal.throwIfAborted(); return { text: '' };
    });
    const member = first.bot('助手', ['ask_user']);
    const room = first.core.entities.createConversation({ name: '任务', kind: 'private', memberIds: [member.id], workspaceId: first.core.state.snapshot().workspaces[0].id });
    const sent = first.core.tasks.send({ conversationId: room.id, content: '写报告' });
    await eventually(() => first.core.state.snapshot().questions[0]?.status === 'pending');
    const question = first.core.state.snapshot().questions[0];
    await first.core.close(); resources.splice(resources.findIndex(item => item.core === first.core), 1);
    const second = new CoreService(first.root, undefined, undefined, [{ kind: 'custom', probe: async () => ({ models: [], capabilities: first.connection.capabilities! }),
      run: async context => { expect(context.prompt).toContain('年度报告'); return { text: '已完成年度报告' }; } }]);
    resources.push({ core: second, root: first.root }); await second.start();
    await second.request('questions.answer', { id: question.id, answer: '年度报告' });
    await eventually(() => second.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
  });

  it('取消问题取消任务，回答取消的问题被拒绝', async () => {
    const { core, bot } = await setup(async context => { await context.executeTool('ask_user', { question: '继续吗？' }, 'ask'); return { text: '' }; });
    const member = bot('助手', ['ask_user']);
    const room = core.entities.createConversation({ name: '任务', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '执行工作' });
    await eventually(() => core.state.snapshot().runs[0]?.status === 'waiting_input');
    const question = core.state.snapshot().questions[0];
    await core.request('questions.cancel', { id: question.id });
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])!.status).toBe('cancelled');
    expect(core.state.storage.get<UserQuestion>('questions', question.id)!.status).toBe('cancelled');
    await expect(core.request('questions.answer', { id: question.id, answer: '继续' })).rejects.toThrow('已取消');
  });
});
