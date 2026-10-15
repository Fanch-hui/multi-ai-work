import { describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import type { Bot, Task, UserQuestion } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { resources, setup, eventually, caps } from './core-harness.js';

const decisionOutput = JSON.stringify({ answer: 'Markdown', reason: '任务要求可直接阅读的报告' });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const untilStopped = (context: RunContext) => new Promise<never>((_, reject) => {
  context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
});

async function delegated(decide: (context: RunContext) => Promise<{ text: string }> = async () => ({ text: decisionOutput })) {
  let member!: Bot, chiefRounds = 0, memberRounds = 0;
  const decisions: RunContext[] = [];
  const run = async (context: RunContext) => {
    if (context.binding.purpose === 'question-decision') { decisions.push(context); return decide(context); }
    if (context.bot.name === 'Chief') {
      if (++chiefRounds === 1)
        await context.executeTool('delegate_task', { botId: member.id, goal: '编写可直接阅读的报告', expectedOutput: '报告' }, 'delegate');
      return { text: '已安排报告工作' };
    }
    if (++memberRounds === 1) {
      await context.executeTool('ask_user', { question: '报告使用哪种格式？', options: [{ label: 'Markdown' }, { label: 'PDF' }] }, 'ask');
      return { text: '' };
    }
    expect(context.prompt).toContain('Markdown');
    return { text: 'Markdown 报告已完成' };
  };
  const fixture = await setup(run);
  const chief = fixture.core.entities.saveBot({ ...fixture.bot('Chief', ['delegate_task']), memoryMode: 'off' });
  member = fixture.core.entities.saveBot({ ...fixture.bot('报告员', ['ask_user']), memoryMode: 'off' });
  const room = fixture.core.entities.createConversation({ name: '报告任务', kind: 'group', chiefId: chief.id,
    memberIds: [chief.id, member.id], workspaceId: fixture.core.state.snapshot().workspaces[0].id });
  fixture.core.tasks.send({ conversationId: room.id, content: '请写一份可直接阅读的报告', targetBotIds: [chief.id] });
  await eventually(() => fixture.core.state.snapshot().questions[0]?.status === 'pending' && !fixture.core.scheduler.hasActive());
  const question = fixture.core.state.snapshot().questions[0];
  const getQuestion = () => fixture.core.state.storage.get<UserQuestion>('questions', question.id)!;
  const getTask = () => fixture.core.state.storage.get<Task>('tasks', question.taskId)!;
  return { ...fixture, chief, member, room, run, question, getQuestion, getTask, decisions,
    memberRounds: () => memberRounds, decisionTime: () => Date.parse(getQuestion().autoAnswerAt!) };
}

describe('主管两分钟代答成员问题', () => {
  it('到期只启动一次，独立绑定和无工具执行，主管身份回答后继续原成员任务', async () => {
    const gate = deferred();
    const fixture = await delegated(async context => {
      expect(context.tools).toEqual([]);
      await expect(context.executeTool('ask_user', { question: '再问一次' }, 'blocked')).rejects.toThrow();
      expect(context.binding.purpose).toBe('question-decision');
      expect(context.messages).toEqual([]);
      expect(context.prompt).toContain('可直接阅读');
      expect(context.instructions).toContain('2分钟');
      await gate.promise; return { text: decisionOutput };
    });
    const { core, question, getQuestion, getTask, chief, decisions, decisionTime } = fixture;
    expect(Date.parse(question.autoAnswerAt!) - Date.parse(question.createdAt)).toBe(120000);
    core.questionDecisions.tick(decisionTime() - 1);
    expect(getQuestion().chiefTaskId).toBeUndefined();
    core.questionDecisions.tick(decisionTime());
    const decisionId = getQuestion().chiefTaskId;
    core.questionDecisions.tick(decisionTime() + 1000);
    expect(getQuestion().chiefTaskId).toBe(decisionId);
    await eventually(() => decisions.length === 1);
    const chiefBinding = core.state.snapshot().runs.find(item => item.botId === chief.id && item.taskId !== decisionId)!.bindingId;
    expect(decisions[0].binding.id).not.toBe(chiefBinding);
    const firstRun = getTask().runIds[0];
    gate.resolve();
    await eventually(() => getTask().status === 'completed');
    expect(getQuestion()).toMatchObject({ status: 'answered', answer: 'Markdown', answerSource: 'chief',
      answerBotId: chief.id, answerReason: '任务要求可直接阅读的报告' });
    expect(getTask().runIds).toHaveLength(2);
    expect(getTask().runIds[0]).toBe(firstRun);
    expect(fixture.memberRounds()).toBe(2);
    const replies = core.state.snapshot().messages.filter(message => message.content.startsWith('主管代答：'));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ authorType: 'bot', authorBotId: chief.id, targetBotIds: [fixture.member.id] });
    expect(core.state.snapshot().messages.filter(message => message.authorType === 'user')).toHaveLength(1);
    expect(core.state.snapshot().approvals).toHaveLength(0);
  });

  it('主管代答在途时用户回答优先，重复回答不重复消息或执行', async () => {
    const fixture = await delegated(untilStopped);
    fixture.core.questionDecisions.tick(fixture.decisionTime());
    await eventually(() => fixture.decisions.length === 1);
    await fixture.core.request('questions.answer', { id: fixture.question.id, answer: 'Markdown' });
    await fixture.core.request('questions.answer', { id: fixture.question.id, answer: 'Markdown' });
    await eventually(() => fixture.getTask().status === 'completed');
    expect(fixture.getQuestion()).toMatchObject({ answerSource: 'user', answer: 'Markdown' });
    expect(fixture.getQuestion().answerBotId).toBeUndefined();
    expect(fixture.core.state.storage.get<Task>('tasks', fixture.getQuestion().chiefTaskId!)!.status).toBe('cancelled');
    expect(fixture.memberRounds()).toBe(2);
    const messages = fixture.core.state.snapshot().messages;
    expect(messages.filter(message => message.content.includes('关于“报告使用哪种格式？”：'))).toHaveLength(1);
    expect(messages.filter(message => message.content.startsWith('主管代答：'))).toHaveLength(0);
  });

  it.each(['取消问题', '移除成员'])('%s 停止在途主管代答和原成员任务', async action => {
    const fixture = await delegated(untilStopped);
    fixture.core.questionDecisions.tick(fixture.decisionTime());
    await eventually(() => fixture.decisions.length === 1);
    if (action === '取消问题') await fixture.core.request('questions.cancel', { id: fixture.question.id });
    else await fixture.core.request('conversations.members.update', { id: fixture.room.id, memberIds: [fixture.chief.id] });
    expect(fixture.getQuestion().status).toBe('cancelled');
    expect(fixture.getTask().status).toBe('cancelled');
    expect(fixture.decisions[0].signal.aborted).toBe(true);
    expect(fixture.core.state.storage.get<Task>('tasks', fixture.getQuestion().chiefTaskId!)!.status).toBe('cancelled');
    fixture.core.questionDecisions.tick(fixture.decisionTime() + 10000);
    expect(fixture.decisions).toHaveLength(1);
  });

  it('已有问题按创建时间收敛为两分钟，截止前不启动主管代答', async () => {
    const fixture = await delegated();
    const time = Date.now(), createdAt = new Date(time - 90000).toISOString();
    fixture.core.state.storage.put('questions', { ...fixture.getQuestion(), createdAt,
      autoAnswerAt: new Date(Date.parse(createdAt) + 180000).toISOString() });
    fixture.core.questionDecisions.tick(time);
    expect(fixture.decisionTime()).toBe(Date.parse(createdAt) + 120000);
    expect(fixture.getQuestion().chiefTaskId).toBeUndefined();
    fixture.core.questionDecisions.tick(fixture.decisionTime());
    await eventually(() => fixture.getTask().status === 'completed');
    expect(fixture.decisions).toHaveLength(1);
  });

  it('重启后按两分钟政策检查已有问题，保留创建时间和成员任务 ID', async () => {
    const fixture = await delegated();
    const createdAt = new Date(Date.now() - 150000).toISOString();
    const deadline = new Date(Date.parse(createdAt) + 120000).toISOString();
    fixture.core.state.storage.put('questions', { ...fixture.getQuestion(), createdAt,
      autoAnswerAt: new Date(Date.parse(createdAt) + 180000).toISOString() });
    await fixture.core.close();
    resources.splice(resources.findIndex(item => item.core === fixture.core), 1);
    const second = new CoreService(fixture.root, undefined, undefined,
      [{ kind: 'custom', probe: async () => ({ models: [], capabilities: caps }), run: fixture.run }]);
    resources.push({ core: second, root: fixture.root }); await second.start();
    await eventually(() => second.state.storage.get<Task>('tasks', fixture.question.taskId)?.status === 'completed');
    expect(second.state.storage.get<UserQuestion>('questions', fixture.question.id)).toMatchObject({
      createdAt, autoAnswerAt: deadline, answerSource: 'chief', answer: 'Markdown' });
    expect(fixture.decisions).toHaveLength(1);
  });

  it.each(['坏 JSON', '服务失败'])('%s 保留问题，显示错误且不重复自动请求', async failure => {
    const fixture = await delegated(async () => {
      if (failure === '服务失败') throw new Error('本地测试服务失败');
      return { text: '答案不是 JSON' };
    });
    fixture.core.questionDecisions.tick(fixture.decisionTime());
    await eventually(() => !!fixture.getQuestion().autoAnswerError && !fixture.core.scheduler.hasActive());
    expect(fixture.getQuestion().status).toBe('pending');
    expect(fixture.getTask().status).toBe('waiting_input');
    const decisionId = fixture.getQuestion().chiefTaskId!;
    expect(fixture.core.state.storage.get<Task>('tasks', decisionId)!.status).toBe('failed');
    fixture.core.questionDecisions.tick(fixture.decisionTime() + 600000);
    expect(fixture.getQuestion().chiefTaskId).toBe(decisionId);
    expect(fixture.decisions).toHaveLength(1);
    await fixture.core.request('questions.answer', { id: fixture.question.id, answer: 'Markdown' });
    await eventually(() => fixture.getTask().status === 'completed');
    expect(fixture.getQuestion().autoAnswerError).toBeUndefined();
  });

  it('主管自身和普通私聊问题只等待用户', async () => {
    const fixture = await setup(async context => {
      await context.executeTool('ask_user', { question: '需要用户决定的内容' }, 'ask'); return { text: '' };
    });
    const chief = fixture.core.entities.saveBot({ ...fixture.bot('Chief', ['ask_user']), memoryMode: 'off' });
    const member = fixture.core.entities.saveBot({ ...fixture.bot('私聊助手', ['ask_user']), memoryMode: 'off' });
    for (const bot of [chief, member]) {
      const room = fixture.core.entities.createConversation({ name: bot.name, kind: 'private', memberIds: [bot.id],
        chiefId: bot.id === chief.id ? chief.id : undefined, workspaceId: fixture.core.state.snapshot().workspaces[0].id });
      fixture.core.tasks.send({ conversationId: room.id, content: '开始任务' });
    }
    await eventually(() => fixture.core.state.snapshot().questions.length === 2 && !fixture.core.scheduler.hasActive());
    fixture.core.questionDecisions.tick(Date.now() + 600000);
    expect(fixture.core.state.snapshot().questions.every(question => !question.autoAnswerAt && !question.chiefTaskId)).toBe(true);
    expect(fixture.core.state.snapshot().tasks).toHaveLength(2);
  });
});
