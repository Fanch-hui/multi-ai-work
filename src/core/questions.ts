import { z } from 'zod';
import type { Run, Task, UserQuestion, Conversation, Bot } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { State, id, now } from './state.js';
import { required } from './errors.js';
import { questionChief, questionDeadline } from './question-policy.js';

export const userQuestionSchema = z.object({ question: z.string().trim().min(1).max(2000),
  options: z.array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(500).optional() }).strict()).min(2).max(4).optional() }).strict();

export class QuestionService {
  constructor(private state: State) {}
  forRun(runId: string) { return this.state.storage.all<UserQuestion>('questions').find(item => item.runId === runId && item.status !== 'cancelled'); }
  create(input: unknown, context: ToolExecutionContext): UserQuestion {
    const previous = this.forRun(context.runId);
    if (previous) return previous;
    const fields = userQuestionSchema.parse(input), s = this.state.storage;
    const question: UserQuestion = { ...fields, id: id(), taskId: context.task.id, runId: context.runId, botId: context.botId,
      conversationId: context.conversation.id, status: 'pending', createdAt: now() };
    if (questionChief(this.state, question)) question.autoAnswerAt = questionDeadline(question.createdAt);
    s.transaction(() => {
      s.put('questions', question);
      const task = required(s.get<Task>('tasks', question.taskId), '任务不存在');
      s.put('tasks', { ...task, status: 'waiting_input', updatedAt: now() });
    });
    this.state.changed(); return question;
  }
  answer(questionId: string, input: unknown) {
    const answer = z.string().trim().min(1).max(120000).parse(input), s = this.state.storage;
    const question = required(s.get<UserQuestion>('questions', questionId), '问题不存在');
    if (question.status === 'answered') {
      if (question.answer !== answer) throw new Error('问题已经回答');
      return question;
    }
    if (question.status !== 'pending') throw new Error('问题已取消');
    return this.resolve(question, answer, 'user');
  }
  answerFromChief(task: Task, output: string) {
    const question = task.questionId ? this.state.storage.get<UserQuestion>('questions', task.questionId) : undefined;
    if (!question || question.status !== 'pending' || question.chiefTaskId !== task.id
      || !this.state.settings().autoAnswerMemberQuestions || questionChief(this.state, question)?.id !== task.botId) return false;
    const text = output.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('主管返回的代答格式无效'); }
    const parsed = z.object({ answer: z.string().trim().min(1).max(120000), reason: z.string().trim().min(1).max(4000) })
      .strict().safeParse(value);
    if (!parsed.success) throw new Error('主管返回的代答缺少有效回答或依据');
    const fields = parsed.data;
    this.resolve(question, fields.answer, 'chief', task.botId, fields.reason);
    return true;
  }
  failDecision(task: Task, error: string) {
    const s = this.state.storage, question = task.questionId ? s.get<UserQuestion>('questions', task.questionId) : undefined;
    if (question?.status === 'pending' && question.chiefTaskId === task.id) {
      s.put('questions', { ...question, autoAnswerError: error }); this.state.changed();
    }
  }
  private resolve(question: UserQuestion, answer: string, source: 'user' | 'chief', chiefId?: string, reason?: string) {
    const s = this.state.storage;
    const task = required(s.get<Task>('tasks', question.taskId), '任务不存在');
    const room = required(s.get<Conversation>('conversations', question.conversationId), '会话不存在');
    const bot = required(s.get<Bot>('bots', question.botId), '成员不存在');
    if (task.status !== 'waiting_input' || room.archived || bot.archived || !room.memberIds.includes(bot.id)) throw new Error('问题所属任务已停止');
    if (task.reconciliationRequired) throw new Error('请先核查任务中的未知操作');
    const updated: UserQuestion = { ...question, status: 'answered', answer, answeredAt: now(),
      answerSource: source, answerBotId: chiefId, answerReason: reason, autoAnswerError: undefined };
    s.transaction(() => {
      s.put('questions', updated);
      s.appendMessage({ id: id(), conversationId: room.id, authorType: source === 'chief' ? 'bot' : 'user', authorBotId: chiefId,
        content: `${source === 'chief' ? '主管代答：' : ''}关于“${question.question}”：${answer}${reason ? `\n依据：${reason}` : ''}`,
        artifactIds: [], status: 'committed', createdAt: now(), targetBotIds: [bot.id] });
      const run = s.get<Run>('runs', question.runId);
      s.put('tasks', { ...task, status: run?.endedAt ? 'queued' : 'waiting_input', error: undefined, updatedAt: now() });
    });
    this.state.changed(); return updated;
  }
  cancelTask(taskId: string) {
    for (const item of this.state.storage.all<UserQuestion>('questions').filter(question => question.taskId === taskId && question.status === 'pending'))
      this.state.storage.put('questions', { ...item, status: 'cancelled', answeredAt: now() });
    this.state.changed();
  }
}
