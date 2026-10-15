import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bot, Conversation, ProcessRecord, Run, RunEvent, Snapshot, Task } from '../src/domain/types.js';
import { ConversationRecords } from '../apps/ui/src/ConversationRecords.js';
import { TaskDetail } from '../apps/ui/src/TaskDetail.js';
import { conversationMemberRecords, conversationRecordTasks, taskRecordActions, taskRecordStatus } from '../apps/ui/src/conversation-records.js';

const time = '2026-10-12T10:00:00Z';
const room = (id: string, values: Partial<Conversation> = {}): Conversation => ({
  id, name: id, kind: 'group', memberIds: ['chief', 'member'], workspaceId: 'workspace', createdAt: time, ...values,
});
const task = (id: string, conversationId: string, values: Partial<Task> = {}): Task => ({
  id, conversationId, botId: 'chief', dependencyIds: [], goal: id, expectedOutput: '', status: 'completed',
  runIds: [], artifactIds: [], requestId: id, depth: 0, createdAt: time, updatedAt: time, ...values,
});
const run = (id: string, taskId: string, values: Partial<Run> = {}): Run => ({
  id, taskId, botId: 'chief', bindingId: 'binding', configRevision: 1, status: 'running', createdAt: time, ...values,
});
const event = (id: string, runId: string, values: Partial<RunEvent> = {}): RunEvent => ({
  id, runId, type: 'tool', data: { name: 'read_file', callId: 'call', source: 'app', status: 'running' }, createdAt: time, ...values,
});

describe('conversation work records', () => {
  it('includes explicit task-group descendants and memory work while isolating other conversations', () => {
    const main = room('main', { purpose: 'chief', kind: 'private' });
    const group = room('group', { purpose: 'task', sourceConversationId: 'main', sourceTaskId: 'root' });
    const data = { conversations: [main, group, room('private'), room('other')], tasks: [
      task('root', 'main'), task('memory', 'main', { kind: 'memory-review', status: 'running' }),
      task('member', 'group', { parentId: 'root', botId: 'member' }),
      task('nested', 'group', { parentId: 'member', botId: 'member' }),
      task('private', 'private', { parentId: 'root' }), task('unrelated', 'group'), task('other', 'other'),
    ] };
    expect(conversationRecordTasks(data, main).map(item => item.id)).toEqual(['memory', 'member', 'nested', 'root']);
    expect(conversationRecordTasks(data, group).map(item => item.id)).toEqual(['member', 'nested', 'unrelated']);
  });

  it('uses the latest real tool event per call and never exposes model text as an action', () => {
    const owner = task('task', 'room', { runIds: ['run'] });
    const data = { runs: [run('run', owner.id)], events: [
      event('start', 'run'),
      event('done', 'run', { createdAt: '2026-10-12T10:00:01Z', data: {
        name: 'read_file', callId: 'call', source: 'app', status: 'completed', summary: '读取 report.md',
      } }),
      event('text', 'run', { type: 'text', data: { delta: '模型输出' } }),
      event('other', 'unrelated'),
    ] };
    expect(taskRecordActions(data, owner).map(action => [action.event.id, action.title, action.status]))
      .toEqual([['done', '读取 report.md', '已完成']]);
    data.events.push(event('next', 'run', { createdAt: '2026-10-12T10:00:02Z',
      data: { name: 'search_text', callId: 'next', source: 'native', status: 'running' } }));
    data.runs[0] = run('run', owner.id, { status: 'completed', endedAt: '2026-10-12T10:00:03Z' });
    expect(taskRecordActions(data, owner)[0]).toMatchObject({ title: '搜索文件内容', status: '结果未报告' });
  });

  it('reflects real background process and memory states on subsequent snapshots', () => {
    const owner = task('task', 'room', { status: 'running' });
    const process: ProcessRecord = { id: 'process', taskId: owner.id, runId: 'run', botId: owner.botId,
      conversationId: 'room', workspaceId: 'workspace', command: 'node', args: [], status: 'running', createdAt: time };
    expect(taskRecordStatus(owner, [process])).toBe('执行命令中');
    expect(taskRecordStatus(owner, [{ ...process, status: 'completed' }])).toBe('思考中');
    expect(taskRecordStatus({ ...owner, kind: 'memory-review' }, [])).toBe('后台整理记忆');
    expect(taskRecordStatus({ ...owner, status: 'waiting_input' }, [])).toBe('等待你的回答');
    expect(taskRecordStatus({ ...owner, status: 'waiting_input', coordinationPaused: true }, [])).toBe('等待继续');
    expect(taskRecordStatus({ ...owner, status: 'failed' }, [process])).toBe('失败');
    expect(taskRecordStatus({ ...owner, status: 'completed' }, [process])).toBe('已完成');
    expect(taskRecordStatus({ ...owner, status: 'waiting_input' }, [process])).toBe('等待你的回答');
  });

  it('groups background work under its owner and keeps normal tasks separate', () => {
    const records = conversationMemberRecords([
      task('chief-work', 'main', { status: 'running' }),
      task('member-work', 'main', { botId: 'member', status: 'failed' }),
      task('member-memory', 'main', { botId: 'member', kind: 'memory-review', status: 'running' }),
      task('decision', 'main', { kind: 'question-decision' }),
      task('removed-work', 'main', { botId: 'removed' }),
    ], ['member', 'chief']);
    expect(records.map(record => [record.botId, record.tasks.map(task => task.id), record.background.map(task => task.id), record.active, record.failed]))
      .toEqual([['member', ['member-work'], ['member-memory'], 0, 1], ['chief', ['chief-work'], ['decision'], 1, 0], ['removed', ['removed-work'], [], 0, 0]]);
  });

  it('labels the actual reason for a queued task', () => {
    const queued = task('queued', 'main', { status: 'queued' });
    expect(taskRecordStatus(queued, [])).toBe('准备开始');
    for (const [queueReason, label] of Object.entries({ global_limit: '等待空闲名额', account_limit: '等待连接空闲',
      session_busy: '等待上一轮', dependencies: '等待前置任务' })) {
      expect(taskRecordStatus({ ...queued, queueReason } as Task, [])).toBe(label);
    }
  });

  it('shows member selection and one member’s compact task list without expanding commands or runs', () => {
    const bot = (id: string, name: string): Bot => ({ id, name, role: '', instructions: '', connectionId: 'connection',
      model: 'model', color: 'blue', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false });
    const main = room('main');
    const owner = task('task', main.id, { goal: '主管工作', status: 'failed', error: '模型请求中断' });
    const data: Snapshot = { connections: [], bots: [bot('chief', '主管'), bot('member', '计划成员')],
      conversations: [main], workspaces: [], messages: [], tasks: [owner,
        task('other', main.id, { botId: 'member', goal: '另一位成员的长任务内容' }),
        task('memory', main.id, { kind: 'memory-review', goal: '后台整理原始指令' })],
      runs: [run('run', owner.id)], approvals: [], artifacts: [], questions: [], processes: [{
        id: 'process', taskId: owner.id, runId: 'run', botId: 'chief', conversationId: main.id,
        workspaceId: 'workspace', command: 'node', args: ['verbose-script.js'], status: 'running', createdAt: time,
      }], memories: [], events: [], toolConnections: [], skills: [], bindings: [], checkpoints: [], compactions: [], taskPlans: [], taskInputs: [], dataDirectory: '',
      settings: { maxActiveRuns: 3, maxChildren: 5, maxCoordinationRounds: 0, trayEnabled: true, autoAnswerMemberQuestions: true } };
    const html = renderToStaticMarkup(createElement(ConversationRecords, { data, conversation: main, mutate: async () => undefined as never }));
    expect(html).toContain('按智能体查看记录');
    expect(html).toContain('计划成员');
    expect(html).toContain('主管工作');
    expect(html).toContain('模型请求中断');
    expect(html).toContain('条仍在运行');
    expect(html).toContain('后台工作');
    expect(html).not.toContain('另一位成员的长任务内容');
    expect(html).not.toContain('verbose-script.js');
    expect(html).not.toContain('后台整理原始指令');
    expect(html).not.toContain('本轮执行错误');
    expect(html.match(/<details[^>]*>/g)?.every(tag => !tag.includes('open'))).toBe(true);
    const detail = renderToStaticMarkup(createElement(TaskDetail, { task: owner, data, mutate: async () => undefined as never }));
    expect(detail).toContain('继续原任务');
    expect(detail).toContain('命令进程');
    expect(detail).toContain('命令运行中');
    expect(detail).toContain('任务错误');
    expect(detail).toContain('工具操作与运行记录');
    expect(detail.match(/<details[^>]*>/g)?.every(tag => !tag.includes('open'))).toBe(true);
  });

  it('merges managed phases with Core events and retains the actual failure and safe target summary', () => {
    const owner = task('task', 'room', { runIds: ['run'] });
    const toolEvent = (id: string, second: number, data: Record<string, unknown>) => event(id, 'run', {
      createdAt: `2026-10-12T10:00:0${second}Z`, data: { name: 'read_file', callId: 'call', ...data },
    });
    const data = { runs: [run('run', owner.id)], events: [
      toolEvent('start', 0, { phase: 'started' }),
      toolEvent('core-start', 1, { source: 'app', status: 'running', summary: '读取 report.md' }),
      toolEvent('core-failed', 2, { source: 'app', status: 'failed', error: '文件不存在', summary: '读取 report.md' }),
      toolEvent('returned', 3, { phase: 'completed' }),
    ] };
    const actions = taskRecordActions(data, owner);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ title: '读取 report.md', status: '失败', event: {
      data: { source: 'app', status: 'failed', error: '文件不存在', phase: 'completed' },
    } });
    data.events = [toolEvent('phase-only', 0, { phase: 'completed' })];
    expect(taskRecordActions(data, owner)[0]).toMatchObject({ status: '已完成' });
    data.events = [toolEvent('phase-only', 0, { phase: 'started' })];
    expect(taskRecordActions(data, owner)[0]).toMatchObject({ status: '执行中' });
  });
});
