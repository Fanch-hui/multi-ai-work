import type { Run, Task, UserQuestion } from '../domain/types.js';
import { State } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { publicError } from './errors.js';
import { questionChief, questionDeadline } from './question-policy.js';

export class QuestionDecisions {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private state: State,
    private tasks: TaskService,
  ) {}

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref?.();
  }
  close() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(time = Date.now()) {
    if (!this.state.settings().autoAnswerMemberQuestions) return;
    const s = this.state.storage;
    for (let question of s
      .all<UserQuestion>('questions')
      .filter((item) => item.status === 'pending')) {
      const chief = questionChief(this.state, question);
      if (!chief) continue;
      const deadline = questionDeadline(question.createdAt);
      if (question.autoAnswerAt !== deadline) {
        question = { ...question, autoAnswerAt: deadline };
        s.put('questions', question);
        this.state.changed();
      }
      const task = s.get<Task>('tasks', question.taskId),
        run = s.get<Run>('runs', question.runId);
      if (
        Date.parse(question.autoAnswerAt!) > time ||
        task?.status !== 'waiting_input' ||
        !run?.endedAt
      )
        continue;
      const previous = question.chiefTaskId
        ? s.get<Task>('tasks', question.chiefTaskId)
        : undefined;
      if (
        question.autoAnswerError ||
        (previous &&
          (!terminal(previous.status) ||
            previous.status === 'failed' ||
            previous.status === 'completed'))
      )
        continue;
      try {
        s.transaction(() => {
          if (previous) this.tasks.update(previous, { status: 'queued', error: undefined });
          else {
            const decision = this.tasks.create({
              conversationId: question.conversationId,
              botId: chief.id,
              kind: 'question-decision',
              questionId: question.id,
              goal: `代答成员问题：${question.question}`,
              requestId: `question-decision:${question.id}`,
            });
            s.put('questions', { ...question, chiefTaskId: decision.id });
          }
        });
        this.state.changed();
      } catch (error) {
        s.put('questions', { ...question, autoAnswerError: publicError(error) });
        this.state.changed();
      }
    }
  }
}
