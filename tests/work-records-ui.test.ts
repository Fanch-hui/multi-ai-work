import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Run, RunEvent, Snapshot, Task } from '../src/domain/types.js';
import type { TaskPlan } from '../src/domain/task-plan.js';
import { RunRecords } from '../apps/ui/src/RunRecords.js';
import { TaskDetail } from '../apps/ui/src/TaskDetail.js';
import { TaskWorkOverview } from '../apps/ui/src/TaskWorkOverview.js';
import { taskWorkOverview } from '../apps/ui/src/task-work-overview.js';
import { taskRecordActions } from '../apps/ui/src/conversation-records.js';
import { mergeRecordEvents, workRecordEvents } from '../apps/ui/src/work-record-events.js';

const at = (index: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, index)).toISOString();
const task: Task = {
  id: 'task',
  botId: 'member',
  conversationId: 'room',
  requestId: 'request',
  goal: '整理竞品资料',
  expectedOutput: '',
  dependencyIds: [],
  status: 'running',
  runIds: ['old', 'run'],
  artifactIds: [],
  depth: 0,
  createdAt: at(0),
  updatedAt: at(1),
};
const run: Run = {
  id: 'run',
  taskId: task.id,
  botId: task.botId,
  bindingId: 'binding',
  configRevision: 1,
  status: 'running',
  createdAt: at(1),
};
const event = (
  id: string,
  index: number,
  data: Record<string, unknown>,
  type: RunEvent['type'] = 'tool',
): RunEvent => ({
  id,
  runId: run.id,
  type,
  createdAt: at(index),
  data,
});
function fixture(): Snapshot {
  return {
    tasks: [task],
    bots: [],
    runs: [run],
    conversations: [],
    processes: [],
    questions: [],
    artifacts: [],
    approvals: [],
    events: [],
    taskPlans: [],
  } as unknown as Snapshot;
}

describe('work records presentation', () => {
  it('retains parallel operations and separates tool completion from real command exit', () => {
    const data = fixture();
    data.events = [
      event('read-start', 1, {
        callId: 'read',
        name: 'read_file',
        status: 'running',
        summary: '读取《需求说明.md》',
      }),
      event('command-start', 2, { callId: 'command', name: 'run_command', status: 'running' }),
      event('command-return', 3, {
        callId: 'command',
        name: 'run_command',
        status: 'completed',
        commandStatus: 'running',
      }),
    ];
    const actions = taskRecordActions(data, task);
    expect(actions.map((item) => [item.title, item.status])).toEqual([
      ['执行命令', '已完成'],
      ['读取《需求说明.md》', '执行中'],
    ]);
    data.processes = [
      {
        id: 'process',
        taskId: task.id,
        runId: run.id,
        botId: task.botId,
        conversationId: task.conversationId,
        workspaceId: 'workspace',
        command: 'node',
        args: ['private-command.js'],
        status: 'running',
        createdAt: at(2),
      },
    ];
    let html = renderToStaticMarkup(createElement(TaskWorkOverview, { task, data }));
    expect(html).toContain('正在处理：读取《需求说明.md》');
    expect(html).toContain('命令运行中');
    expect(html).not.toContain('private-command.js');
    data.processes[0] = { ...data.processes[0], status: 'failed', code: 3, endedAt: at(4) };
    html = renderToStaticMarkup(createElement(TaskWorkOverview, { task, data }));
    expect(html).toContain('命令失败');
    expect(html).toContain('退出码 3');
    expect(taskRecordActions(data, task)[0].status).toBe('已完成');
  });

  it('shows actual plan progress, current notes, bounded operations and real blockers', () => {
    const data = fixture();
    const plan: TaskPlan = {
      id: 'plan',
      taskId: task.id,
      conversationId: task.conversationId,
      title: '资料整理',
      createdAt: at(0),
      updatedAt: at(2),
      steps: [
        {
          id: 'one',
          title: '收集资料',
          kind: 'work',
          memberIds: ['member'],
          dependencyIds: [],
          status: 'completed',
          taskIds: [],
          conversationIds: [],
        },
        {
          id: 'two',
          title: '核对产品差异',
          kind: 'work',
          memberIds: ['member'],
          dependencyIds: ['one'],
          status: 'running',
          note: '已核实价格来源',
          taskIds: [],
          conversationIds: [],
        },
        {
          id: 'three',
          title: '生成报告',
          kind: 'work',
          memberIds: ['member'],
          dependencyIds: ['two'],
          status: 'pending',
          taskIds: [],
          conversationIds: [],
        },
      ],
    };
    data.taskPlans = [plan];
    const active: Task = {
      ...task,
      activity: {
        phase: 'tool',
        operations: [
          {
            runId: run.id,
            callId: 'read',
            name: 'read_file',
            summary: '读取《竞品对比.xlsx》',
            startedAt: at(2),
          },
        ],
        operationCount: 5,
      },
    };
    let html = renderToStaticMarkup(createElement(TaskWorkOverview, { task: active, data }));
    expect(html).toContain('当前步骤：核对产品差异');
    expect(html).toContain('已完成：1/3 步');
    expect(html).toContain('已核实价格来源');
    expect(html).toContain('另有 4 项操作');
    expect(html).not.toContain('等待事项');
    data.taskPlans = [];
    expect(taskWorkOverview(data, active).progress).toBeUndefined();
    html = renderToStaticMarkup(
      createElement(TaskWorkOverview, { task: { ...active, reconciliationRequired: true }, data }),
    );
    expect(html).toContain('等待事项：操作结果待核查');
    expect(html).not.toContain('%');
  });

  it('counts only the selected member’s linked steps and names the actual waiting member once', () => {
    const data = fixture();
    const member = { ...task, id: 'child', parentId: task.id, status: 'running' as const };
    data.tasks.push(member);
    data.taskPlans = [
      {
        id: 'plan',
        taskId: task.id,
        conversationId: task.conversationId,
        title: '协作安排',
        createdAt: at(0),
        updatedAt: at(1),
        steps: [
          {
            id: 'done',
            title: '主管准备',
            kind: 'work',
            memberIds: ['chief'],
            dependencyIds: [],
            status: 'completed',
            taskIds: [],
            conversationIds: [],
          },
          {
            id: 'active',
            title: '成员检索',
            kind: 'work',
            memberIds: ['member'],
            dependencyIds: ['done'],
            status: 'running',
            taskIds: ['child'],
            conversationIds: [],
          },
        ],
      },
    ];
    expect(taskWorkOverview(data, member)).toMatchObject({
      currentStep: '成员检索',
      progress: '0/1 步',
    });
    const waitingTask: Task = {
      ...task,
      status: 'waiting_children',
      activity: { phase: 'children', waitingFor: '等待成员完成' },
    };
    expect(taskWorkOverview(data, waitingTask).waiting).toEqual(['等待成员返回结果']);
  });

  it('merges more than 200 events across pages and preserves realtime terminal results', () => {
    const earlier = Array.from({ length: 240 }, (_, index) =>
      event(`start-${index}`, index, {
        callId: `call-${index}`,
        name: 'read_file',
        status: 'running',
        summary: `读取 ${index}.md`,
      }),
    );
    const latest = [event('done', 250, { callId: 'call-0', status: 'failed', source: 'app' })];
    const cache = mergeRecordEvents(latest, earlier);
    const records = taskRecordActions({ runs: [run], events: cache }, task);
    expect(cache).toHaveLength(241);
    expect(records).toHaveLength(240);
    expect(records.find((item) => item.key.endsWith(':call-0'))).toMatchObject({
      title: '读取 0.md',
      status: '失败',
    });
    const stale = event('done', 250, { callId: 'call-0', status: 'running' });
    expect(mergeRecordEvents(latest, [stale])[0]).toEqual(latest[0]);
    const lateStart = event('late-start', 251, { callId: 'call-0', status: 'running' });
    expect(
      taskRecordActions({ runs: [run], events: [...cache, lateStart] }, task).find((item) =>
        item.key.endsWith(':call-0'),
      )?.status,
    ).toBe('失败');
  });

  it('keeps separate compactions and summarizes native tools without exposing raw data', () => {
    const events = [
      event('compact-start', 1, { status: 'started' }, 'compaction'),
      event('compact-done', 2, { status: 'completed' }, 'compaction'),
      event('compact-next', 3, { status: 'started' }, 'compaction'),
      event('native', 4, {
        name: 'NativeFetch',
        callId: 'native',
        status: 'running',
        args: { secret: 'raw-value' },
        result: 'raw-body',
      }),
      event('retry', 5, { phase: 'model-retry', attempt: 2, error: 'raw-error' }, 'status'),
      event('metrics', 6, { phase: 'model-performance', durationMs: 2 }, 'status'),
      event('summary-error', 7, { phase: 'model-error', scope: 'compaction' }, 'status'),
      event('cancel', 8, { phase: 'cancel-requested' }, 'status'),
      event('object-field', 9, { name: { raw: 'object-value' }, summary: 'x'.repeat(300) }),
    ];
    const safe = workRecordEvents(events);
    expect(JSON.stringify(safe)).not.toMatch(
      /raw-value|raw-body|raw-error|durationMs|object-value|summary-error/,
    );
    expect(safe.find((item) => item.id === 'object-field')?.data.summary).toHaveLength(240);
    const actions = taskRecordActions({ runs: [run], events: safe }, task);
    expect(
      actions.filter((item) => item.event.type === 'compaction').map((item) => item.status),
    ).toEqual(['执行中', '已完成']);
    expect(actions.find((item) => item.event.id === 'native')?.title).toBe('使用工具 NativeFetch');
    expect(actions.find((item) => item.event.id === 'retry')?.title).toBe('正在恢复连接');
    expect(actions.find((item) => item.event.id === 'cancel')?.title).toBe('正在停止工作');
  });

  it('retains approval, question, reconciliation and deliverable preview entry points', () => {
    const data = fixture();
    data.approvals = [
      {
        id: 'approval',
        taskId: task.id,
        runId: run.id,
        botId: task.botId,
        toolName: 'write_file',
        summary: '保存资料报告',
        args: { path: 'report.md' },
        status: 'pending',
        createdAt: at(2),
      },
    ];
    data.questions = [
      {
        id: 'question',
        taskId: task.id,
        runId: run.id,
        botId: task.botId,
        conversationId: task.conversationId,
        question: '报告面向哪类读者？',
        status: 'pending',
        createdAt: at(3),
      },
    ];
    data.artifacts = [
      {
        id: 'report',
        name: '竞品报告.md',
        path: '/report.md',
        mimeType: 'text/markdown',
        purpose: 'deliverable',
        sha256: 'digest',
        size: 128,
        taskId: task.id,
        conversationId: task.conversationId,
        createdAt: at(4),
      },
    ];
    const pending: Task = {
      ...task,
      reconciliationRequired: true,
      artifactIds: ['report'],
      status: 'waiting_approval',
      activity: { phase: 'approval', waitingFor: '等待批准工具操作' },
    };
    const work = taskWorkOverview(data, pending);
    expect(work.waiting).toEqual(['有操作等待你的批准', '有问题等待你的回答', '操作结果待核查']);
    expect(work.deliverables).toBe(1);
    const html = renderToStaticMarkup(
      createElement(TaskDetail, {
        task: pending,
        data,
        mutate: async () => undefined as never,
      }),
    );
    expect(html).toContain('允许本次');
    expect(html).toContain('拒绝');
    expect(html).toContain('报告面向哪类读者？');
    expect(html).toContain('你的回答');
    expect(html).toContain('已核查完成');
    expect(html).toContain('竞品报告.md');
    expect(html).toContain('预览');
  });

  it('opens the newest work process and keeps historical runs and technical details collapsed', () => {
    const recent = [
      event('read', 1, {
        callId: 'read',
        name: 'read_file',
        summary: '读取需求文件',
        status: 'completed',
        args: { raw: 'private-args' },
      }),
    ];
    const newest = renderToStaticMarkup(
      createElement(RunRecords, { run, task, recent, defaultOpen: true }),
    );
    expect(newest.match(/<details[^>]*open=""[^>]*>/g)).toHaveLength(1);
    expect(newest).toContain('读取需求文件');
    expect(newest).toContain('已完成');
    expect(newest).toContain('技术详情');
    expect(newest).not.toContain('private-args');
    const historical = renderToStaticMarkup(
      createElement(RunRecords, { run: { ...run, id: 'old' }, task, recent }),
    );
    expect(historical).toContain('历史轮次');
    expect(historical.match(/<details[^>]*open=""[^>]*>/g)).toBeNull();
  });
});
