import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Snapshot, Task, UserQuestion } from '../src/domain/types.js';
import { MessageFeed } from '../apps/ui/src/MessageFeed.js';
import { UserQuestionCard } from '../apps/ui/src/UserQuestionCard.js';

const time = '2026-10-12T12:00:00Z';
const bot = (id: string, name: string): Bot => ({ id, name, role: '', instructions: '', connectionId: 'connection',
  model: 'model', color: 'blue', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false });
const question: UserQuestion = { id: 'question', taskId: 'member-task', runId: 'member-run', botId: 'member',
  conversationId: 'group', question: '输出哪种格式？', status: 'pending', createdAt: time,
  autoAnswerAt: '2026-10-12T12:02:00Z' };
const snapshot = (): Snapshot => ({ bots: [bot('member', '成员'), bot('chief', 'Chief')], tasks: [],
  settings: { maxActiveRuns: 3, maxChildren: 5, maxCoordinationRounds: 0, trayEnabled: true,
    mainBotId: 'chief', autoAnswerMemberQuestions: true },
  connections: [], conversations: [], workspaces: [], messages: [], runs: [], approvals: [], artifacts: [],
  questions: [], processes: [], memories: [], events: [], toolConnections: [], skills: [], dataDirectory: '',
  bindings: [], checkpoints: [], compactions: [], taskPlans: [], taskInputs: [] });
const render = (item: UserQuestion, data = snapshot(), hideResolved = false) => renderToStaticMarkup(createElement(UserQuestionCard, {
  question: item, data, mutate: async () => undefined as never, hideResolved,
}));

describe('member question card', () => {
  it('keeps user answer and cancellation available while the Chief is deciding', () => {
    const data = snapshot();
    const task: Task = { id: 'decision', conversationId: 'group', botId: 'chief', dependencyIds: [],
      goal: '选择输出格式', expectedOutput: '', status: 'running', runIds: [], artifactIds: [], requestId: 'decision',
      depth: 0, createdAt: time, updatedAt: time, kind: 'question-decision', questionId: question.id };
    data.tasks.push(task);
    const html = render({ ...question, chiefTaskId: task.id }, data);
    expect(html).toContain('主管正在代答');
    expect(html).toContain('<textarea');
    expect(html).toContain('提交回答');
    expect(html).toContain('取消任务');
    expect(html).not.toContain('主管代答</span>');
  });

  it('attributes the completed answer and its reason to Chief without changing manual answers', () => {
    const answer: UserQuestion = { ...question, status: 'answered', answer: 'CSV', answerSource: 'chief',
      answerBotId: 'chief', answerReason: '已有数据是表格。' };
    const html = render(answer);
    expect(html).toContain('<details');
    expect(html.match(/<details[^>]*>/)?.[0]).not.toMatch(/\sopen(?:=|\s|>)/);
    expect(html).toContain('Chief · 主管代答');
    expect(html).toContain('CSV');
    expect(html).toContain('已有数据是表格。');
    expect(html).not.toContain('<textarea');
    expect(render(answer, snapshot(), true)).toBe('');
    const manual = render({ ...answer, answerSource: 'user' });
    expect(manual).toContain('CSV');
    expect(manual).not.toContain('主管代答');
    expect(manual).not.toContain('已有数据是表格。');
  });

  it('keeps cancelled questions collapsed with their original text available to expand', () => {
    const html = render({ ...question, status: 'cancelled' });
    expect(html).toContain('<details');
    expect(html.match(/<details[^>]*>/)?.[0]).not.toMatch(/\sopen(?:=|\s|>)/);
    expect(html).toContain('已取消');
    expect(html).toContain(question.question);
    expect(html).not.toContain('<textarea');
    expect(render({ ...question, status: 'cancelled' }, snapshot(), true)).toBe('');
  });

  it('shows only unanswered questions for the current conversation in the message feed', () => {
    const data = snapshot();
    data.questions = [question,
      { ...question, id: 'answered', status: 'answered', question: '已处理的问题', answer: 'CSV' },
      { ...question, id: 'cancelled', status: 'cancelled', question: '已取消的问题' },
      { ...question, id: 'elsewhere', conversationId: 'other', question: '另一个对话的问题' },
    ];
    const conversation: Conversation = { id: 'group', name: '任务讨论', kind: 'group',
      memberIds: ['member'], workspaceId: 'workspace', createdAt: time };
    const html = renderToStaticMarkup(createElement(MessageFeed, { data, conversation,
      mutate: async () => undefined as never, onSelectConversation: () => undefined }));
    expect(html).toContain(question.question);
    expect(html).toContain('提交回答');
    expect(html).not.toContain('已处理的问题');
    expect(html).not.toContain('已取消的问题');
    expect(html).not.toContain('另一个对话的问题');
  });

  it('shows a decision failure while retaining the answer form and respects disabled automatic answers', () => {
    const failed = render({ ...question, autoAnswerError: '模型服务繁忙' });
    expect(failed).toContain('主管未能代答：模型服务繁忙');
    expect(failed).toContain('<textarea');
    expect(failed).not.toContain('2 分钟内未回答');
    const data = snapshot();
    data.settings.autoAnswerMemberQuestions = false;
    const html = render({ ...question, autoAnswerError: '模型服务繁忙' }, data);
    expect(html).toContain('主管未能代答：模型服务繁忙');
    expect(html).toContain('<textarea');
    expect(html).not.toContain('2 分钟内未回答');
    expect(render({ ...question, autoAnswerAt: undefined })).not.toContain('2 分钟内未回答');
    expect(render(question)).toContain('2 分钟内未回答');
  });
});
