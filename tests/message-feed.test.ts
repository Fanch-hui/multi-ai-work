import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact, Bot, Conversation, Message, ProcessRecord, Run, RunEvent, Snapshot, Task } from '../src/domain/types.js';
import { agentActivity } from '../apps/ui/src/AgentActivity.js';
import { MessageFeed } from '../apps/ui/src/MessageFeed.js';
import { Composer } from '../apps/ui/src/Composer.js';
import { conversationMessages, recoveringTasks, workingMembers } from '../apps/ui/src/message-feed.js';
import { busyInputMembers, messageInputFeedback, messageInputFeedbackIndex } from '../apps/ui/src/task-input-feedback.js';

const time = '2026-10-13T10:00:00Z';
const room: Conversation = { id: 'room', name: '验收群', kind: 'group', memberIds: ['member'], workspaceId: 'workspace', createdAt: time };
const bot = (id: string): Bot => ({ id, name: `${id} 成员`, role: '', instructions: '', connectionId: 'connection',
  model: 'model', color: '', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false });
const task = (id: string, values: Partial<Task> = {}): Task => ({ id, conversationId: room.id, botId: id,
  goal: id, expectedOutput: '', dependencyIds: [], status: 'running', runIds: [id], artifactIds: [],
  requestId: id, depth: 0, createdAt: time, updatedAt: time, ...values });
const run = (id: string, values: Partial<Run> = {}): Run => ({ id, taskId: id, botId: id,
  bindingId: 'binding', status: 'running', configRevision: 1, createdAt: time, ...values });
const message = (id: string, values: Partial<Message> = {}): Message => ({ id, conversationId: room.id,
  sequence: 1, authorType: 'bot', authorBotId: 'member', runId: 'member', content: '',
  artifactIds: [], status: 'draft', createdAt: time, ...values });
const event = (id: string, values: Partial<RunEvent> = {}): RunEvent => ({ id, runId: 'member',
  type: 'tool', data: { name: 'read_file', callId: 'call', status: 'running' }, createdAt: time, ...values });
function snapshot(values: Partial<Snapshot> = {}): Snapshot {
  return { connections: [], bots: [bot('member')], tasks: [], conversations: [room], workspaces: [],
    messages: [], runs: [], approvals: [], artifacts: [], questions: [], processes: [], memories: [], events: [],
    toolConnections: [], skills: [], bindings: [], checkpoints: [], compactions: [], taskPlans: [], taskInputs: [], dataDirectory: '',
    settings: { maxActiveRuns: 3, maxChildren: 5, maxCoordinationRounds: 0, trayEnabled: true,
      autoAnswerMemberQuestions: true }, ...values };
}
const render = (data: Snapshot, conversation = room) => renderToStaticMarkup(createElement(MessageFeed, {
  data, conversation, mutate: async () => undefined as never, onSelectConversation: () => undefined,
}));

describe('conversation message feed', () => {
  it('indexes all message feedback without mixing conversations or duplicating task recipients', () => {
    const data = snapshot({ bots: [bot('busy'), bot('idle')],
      messages: ['first', 'second', 'plain'].map(id => message(id, { authorType: 'user', status: 'committed' })),
      tasks: [task('busy-task', { botId: 'busy', sourceMessageId: 'first' }),
        task('idle-task', { botId: 'idle', sourceMessageId: 'first', status: 'queued', runIds: [] }),
        task('other-room', { conversationId: 'elsewhere', sourceMessageId: 'second' })],
      taskInputs: [{ id: 'delivered', kind: 'user-input', taskId: 'busy-task', botId: 'busy', conversationId: room.id,
        messageId: 'first', status: 'delivered', createdAt: time },
      { id: 'retained', kind: 'user-input', taskId: 'deleted-task', botId: 'deleted-member', conversationId: room.id,
        messageId: 'second', status: 'pending', createdAt: time },
      { id: 'foreign', kind: 'user-input', taskId: 'busy-task', botId: 'busy', conversationId: 'elsewhere',
        messageId: 'first', status: 'claimed', createdAt: time }] });
    const feedback = messageInputFeedbackIndex(data, room.id);
    expect(feedback.get('first')).toEqual([
      { id: 'delivered', name: 'busy 成员', status: '成员已接收' },
      { id: 'idle-task', name: 'idle 成员', status: '任务已派发' },
    ]);
    expect(feedback.get('second')).toEqual([{ id: 'retained', name: '成员', status: '任务已结束，保留待接入' }]);
    expect(feedback.get('plain')).toEqual([{ id: 'plain', name: '消息', status: '已发布' }]);
  });

  it('reports task supplementation per receiving member and retains unprocessed inputs after termination', () => {
    const data = snapshot({ bots: [bot('busy'), bot('idle'), bot('stopped')], tasks: [task('busy'), task('stopped', { status: 'cancelled' })],
      messages: [message('supplement', { authorType: 'user', content: '请调整目标', status: 'committed' })],
      taskInputs: [{ id: 'busy-input', kind: 'user-input', taskId: 'busy', botId: 'busy', conversationId: room.id,
        messageId: 'supplement', status: 'pending', createdAt: time },
      { id: 'stopped-input', kind: 'user-input', taskId: 'stopped', botId: 'stopped', conversationId: room.id,
        messageId: 'supplement', status: 'claimed', runId: 'stopped', createdAt: time }] });
    expect(messageInputFeedback(data, 'supplement', room.id)).toEqual([
      { id: 'busy-input', name: 'busy 成员', status: '等待接入' },
      { id: 'stopped-input', name: 'stopped 成员', status: '任务已结束，保留待接入' },
    ]);
    let html = render(data);
    expect(html).toContain('busy 成员 · 等待接入');
    expect(html).toContain('stopped 成员 · 任务已结束，保留待接入');
    expect(html).not.toContain('idle 成员');
    data.taskInputs[0].status = 'claimed';
    expect(messageInputFeedback(data, 'supplement', room.id)[0].status).toBe('已接入当前请求，待确认');
    data.taskInputs[0].status = 'delivered';
    data.tasks[0].status = 'completed';
    html = render(data);
    expect(html).toContain('busy 成员 · 成员已接收');
    expect(messageInputFeedback(data, 'another-message', room.id)).toEqual([]);
    expect(messageInputFeedback(data, 'supplement', 'another-room')).toEqual([]);
  });

  it('distinguishes publishing a message, dispatching its task and starting the member', () => {
    const data = snapshot({ messages: [message('new-request', { authorType: 'user', status: 'committed' })] });
    expect(messageInputFeedback(data, 'new-request', room.id)).toEqual([{ id: 'new-request', name: '消息', status: '已发布' }]);
    data.tasks.push(task('member', { sourceMessageId: 'new-request', status: 'queued', runIds: [] }));
    expect(messageInputFeedback(data, 'new-request', room.id)[0].status).toBe('任务已派发');
    data.tasks[0].runIds.push('member-run');
    expect(messageInputFeedback(data, 'new-request', room.id)[0].status).toBe('成员已开始');
    expect(messageInputFeedback(data, 'new-request', 'another-room')).toEqual([]);
  });

  it('detects supplementation targets within the current conversation and explicit member selection', () => {
    const conversation = { ...room, memberIds: ['busy', 'idle', 'background', 'elsewhere', 'archived', 'queued'] };
    const data = snapshot({ bots: conversation.memberIds.map(id => ({ ...bot(id), archived: id === 'archived' })),
      tasks: [task('busy'), task('idle', { status: 'completed' }), task('background', { kind: 'memory-review' }),
        task('elsewhere', { conversationId: 'another-room' }), task('archived'), task('queued', { status: 'queued' })] });
    expect(busyInputMembers(data, conversation, []).map(member => member.id)).toEqual(['busy']);
    expect(busyInputMembers(data, conversation, ['busy']).map(member => member.id)).toEqual(['busy']);
    expect(busyInputMembers(data, conversation, ['idle'])).toEqual([]);
    expect(busyInputMembers(data, { ...conversation, purpose: 'chief', chiefId: 'busy' }, ['idle']).map(member => member.id)).toEqual(['busy']);
    data.taskInputs.push({ id: 'continuation', kind: 'user-input', taskId: 'queued', botId: 'queued', conversationId: room.id,
      messageId: 'supplement', status: 'pending', createdAt: time });
    expect(busyInputMembers(data, conversation, []).map(member => member.id)).toEqual(['busy', 'queued']);
  });

  it('explains supplementation while leaving idle group members available for replies', () => {
    const conversation = { ...room, memberIds: ['busy', 'idle'] };
    const data = snapshot({ bots: [bot('busy'), bot('idle')], tasks: [task('busy')] });
    const compose = (current: Conversation) => renderToStaticMarkup(createElement(Composer, {
      data, conversation: current, mutate: async () => undefined as never,
    }));
    expect(compose(conversation)).toContain('执行中的成员接收任务补充，空闲成员正常回复。');
    const privateHtml = compose({ ...conversation, kind: 'private', memberIds: ['busy'] });
    expect(privateHtml).toContain('placeholder="补充、纠正或调整当前任务…"');
    expect(privateHtml).toContain('消息将补充到正在执行的任务。');
    data.tasks = [];
    expect(compose(conversation)).toContain('placeholder="发消息…"');
    expect(compose(conversation)).not.toContain('task-input-hint');
  });

  it('collapses group deliverables into a compact entry while keeping user attachments available', () => {
    const file = (id: string, values: Partial<Artifact> = {}): Artifact => ({ id, name: `${id}.json`, path: `/files/${id}.json`,
      mimeType: 'application/json', sha256: id, size: 10, conversationId: room.id, createdAt: time, ...values });
    const data = snapshot({ artifacts: [file('final', { purpose: 'deliverable', botId: 'member' }),
      file('process', { purpose: 'intermediate' }), file('preview', { source: 'render_document' }),
      file('input', { source: 'user-attachment', purpose: 'intermediate' })], messages: [
      message('result', { content: '已完成', status: 'committed', artifactIds: ['final', 'process', 'preview'] }),
      message('user-input', { authorType: 'user', status: 'committed', sequence: 2, artifactIds: ['input'] }),
    ] });
    const html = render(data);
    expect(html).toContain('1 个交付物');
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\bopen[= >]/);
    expect(html).toContain('final.json');
    expect(html).toContain('input.json');
    expect(html).not.toContain('process.json');
    expect(html).not.toContain('preview.json');
    expect(render(data, { ...room, kind: 'private', purpose: 'chief' })).not.toContain('个交付物');
  });

  it('keeps actual replies and attachments in publication order while dropping empty drafts and system dispatches', () => {
    const data = snapshot({ messages: [
      message('second', { content: '第二条', status: 'committed', sequence: 4 }),
      message('empty-failure', { status: 'interrupted' }), message('empty-draft'),
      message('system', { authorType: 'system', content: '派发目标', status: 'committed', sequence: 2 }),
      message('attachment', { authorType: 'user', artifactIds: ['image'], status: 'committed', sequence: 3 }),
      message('first', { content: '第一条', status: 'committed', sequence: 1 }),
      message('partial', { content: '已生成的部分内容', status: 'interrupted', sequence: 5 }),
    ] });
    expect(conversationMessages(data, room).map(item => item.id)).toEqual(['first', 'attachment', 'second', 'partial']);
    expect(data.messages[0].id).toBe('second');
  });

  it('shows working members by name and hides queued, waiting, failed and background task placeholders', () => {
    const ids = ['member', 'queued', 'waiting', 'failed', 'memory', 'decision'];
    const data = snapshot({ bots: ids.map(bot), tasks: [task('member'), task('queued', { status: 'queued' }),
      task('waiting', { status: 'waiting_children' }), task('failed', { status: 'failed' }),
      task('memory', { kind: 'memory-review' }), task('decision', { kind: 'question-decision' })],
      runs: ids.map(id => run(id)), messages: [message('user', { authorType: 'user', content: '开始验收', status: 'committed' }), message('empty')] });
    expect(workingMembers(data, room, conversationMessages(data, room)).map(item => item.run.id)).toEqual(['member']);
    const html = render(data);
    expect(html).toContain('member 成员');
    expect(html).toContain('思考中');
    for (const id of ids.slice(1)) expect(html).not.toContain(`${id} 成员`);
    expect(html).toContain('消息 · 已发布');
    expect(html.match(/class="agent-activity /g)).toHaveLength(1);
  });

  it('shows connection recovery in private conversations while keeping group waiters in records', () => {
    const recovery = { attempt: 2, maxAttempts: 5, nextAttemptAt: '2026-10-13T10:00:05Z' };
    const owner = task('member', { status: 'recovering', recovery });
    const data = snapshot({ tasks: [owner], runs: [run('member', { status: 'interrupted', endedAt: time })] });
    expect(workingMembers(data, room, [])).toEqual([]);
    expect(recoveringTasks(data, room, [])).toEqual([]);
    const privateRoom = { ...room, kind: 'private' as const, purpose: 'chief' as const };
    expect(recoveringTasks(data, privateRoom, []).map(item => item.id)).toEqual(['member']);
    const html = render({ ...data, runs: [] }, privateRoom);
    expect(html).toContain('正在恢复连接，第 2/5 次');
    expect(html).toContain('下次尝试');
    expect(html).not.toContain('agent-activity-animated');
    expect(agentActivity(owner, data.runs[0])).toContain('正在恢复连接，第 2/5 次');
  });

  it('keeps a streamed reply once and never turns post_message receipts into new group messages', () => {
    const data = snapshot({ tasks: [task('member')], runs: [run('member')],
      messages: [message('stream', { content: '正在撰写' })], events: [event('receipt', { type: 'text', data: { delta: '内部回执' } })] });
    let html = render(data);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('正在撰写');
    data.messages = [message('posted', { content: '实际发言', status: 'committed' })];
    html = render(data);
    expect(html).toContain('实际发言');
    expect(html).toContain('正在工作的成员');
    expect(html).not.toContain('内部回执');
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(render({ ...data, messages: [message('stream', { content: '主管答复' })] },
      { ...room, kind: 'private', purpose: 'chief' })).toContain('主管答复');
  });

  it('preserves pending questions and approvals, while leaving resolved questions in the records', () => {
    const data = snapshot({ tasks: [task('member', { status: 'waiting_input' })], runs: [run('member', { status: 'waiting_input' })],
      questions: [{ id: 'question', taskId: 'member', runId: 'member', botId: 'member', conversationId: room.id,
        question: '每天投入多少分钟？', status: 'pending', createdAt: time },
      { id: 'answered', taskId: 'member', runId: 'member', botId: 'member', conversationId: room.id,
        question: '已回答的问题', status: 'answered', answer: '30', createdAt: time }],
      approvals: [{ id: 'approval', taskId: 'member', runId: 'member', botId: 'member', toolName: 'write_file',
        summary: '覆盖计划文件', args: {}, status: 'pending', createdAt: time }] });
    const html = render(data);
    expect(html).toContain('每天投入多少分钟？');
    expect(html).toContain('覆盖计划文件');
    expect(html).not.toContain('已回答的问题');
    expect(html).not.toContain('正在工作的成员');
  });
});

describe('working member activity', () => {
  it('follows the current real process and tool state rather than an old start event', () => {
    const owner = task('member'), current = run('member');
    const process: ProcessRecord = { id: 'process', taskId: 'member', runId: 'member', botId: 'member',
      conversationId: room.id, workspaceId: 'workspace', command: 'node', args: [], status: 'running', createdAt: time };
    expect(agentActivity(owner, current, [], true, [process])).toBe('命令运行中');
    const events = [event('start'), event('done', { data: { callId: 'call', status: 'completed' } }),
      event('phase', { data: { callId: 'call', phase: 'completed' } })];
    expect(agentActivity(owner, current, events)).toBe('思考中');
    expect(agentActivity(owner, current, [event('start')], true)).toBe('正在工作中');
  });
});
