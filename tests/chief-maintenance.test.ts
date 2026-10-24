import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChiefContextView, ChiefInput, ChiefModelJob } from '../src/domain/chief-work.js';
import type { Bot, Conversation, Run, Task } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { ChiefMaintenanceService } from '../src/core/chief-maintenance.js';
import { maintenanceDecision } from '../src/core/chief-maintenance-prompt.js';

const roots: { state: State; root: string }[] = [];
afterEach(async () => {
  for (const { state, root } of roots.splice(0)) {
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

const summary = ['目标', '约束', '进度', '决定', '待办', '成果', '历史位置']
  .map((name) => `## ${name}\n${name === '成果' ? '报告 artifact-report 已交付。' : '无'}`)
  .join('\n');

async function fixture(estimatedTokens = 9000) {
  const root = await mkdtemp(join(tmpdir(), 'chief-maintenance-'));
  const state = new State(root);
  roots.push({ state, root });
  const s = state.storage;
  const bot = s.get<Bot>('bots', state.settings().mainBotId!)!;
  s.put('bots', { ...bot, connectionId: 'connection', model: 'test', contextWindow: 10000 });
  s.put('connections', {
    id: 'connection',
    revision: 1,
    provider: 'custom',
    status: 'ready',
    models: [],
  });
  const room = {
    ...s.get<Conversation>('conversations', state.settings().mainConversationId!)!,
    id: 'work-room',
    chiefRole: 'work' as const,
    chiefContextId: 'context',
  };
  s.put('conversations', room);
  const context = {
    id: 'context',
    homeConversationId: state.settings().mainConversationId!,
    title: '报告',
    currentPartId: 'part',
    createdAt: '2026-10-24T10:00:00Z',
  };
  const view: ChiefContextView = {
    ...context,
    conversationIds: [room.id],
    conversationId: room.id,
    workspaceId: room.workspaceId,
    activeTaskIds: [],
  };
  const task: Task = {
    id: 'report-task',
    conversationId: room.id,
    botId: bot.id,
    dependencyIds: [],
    goal: '交付报告',
    expectedOutput: '',
    status: 'completed',
    runIds: ['report-run'],
    artifactIds: [],
    requestId: 'report-request',
    depth: 0,
    createdAt: '2026-10-24T10:00:00Z',
    updatedAt: '2026-10-24T10:01:00Z',
  };
  s.put('tasks', task);
  s.put('runs', {
    id: 'report-run',
    taskId: task.id,
    botId: bot.id,
    bindingId: 'binding',
    status: 'completed',
    configRevision: 1,
    createdAt: task.createdAt,
    endedAt: task.updatedAt,
    contextUsage: { estimatedTokens, triggerTokens: 8500 },
  } satisfies Run);
  s.appendMessage({
    id: 'request',
    conversationId: room.id,
    authorType: 'user',
    content: '请交付报告',
    artifactIds: [],
    status: 'committed',
    createdAt: task.createdAt,
  });
  s.appendMessage({
    id: 'answer',
    conversationId: room.id,
    authorType: 'bot',
    authorBotId: bot.id,
    content: '报告已交付',
    artifactIds: [],
    status: 'committed',
    createdAt: task.updatedAt,
  });
  let maintenanceCount = 0;
  const queue = vi.fn(
    (
      kind: 'chief-routing' | 'chief-context-maintenance',
      spec: ChiefModelJob,
      requestId: string,
    ) => {
      const value = {
        ...task,
        id: `maintenance-${++maintenanceCount}`,
        kind,
        status: 'queued' as const,
        requestId,
        conversationId: 'router-room',
        runIds: [],
      };
      s.put('tasks', value);
      s.setMetadata(`job:${value.id}`, spec);
      return value;
    },
  );
  const compact = vi.fn(() => {
    const value = {
      ...task,
      id: 'compact',
      kind: 'context-compaction' as const,
      status: 'queued' as const,
      requestId: 'compact',
      runIds: [],
    };
    s.put('tasks', value);
    return value;
  });
  const rotate = vi.fn(() => view);
  const service = new ChiefMaintenanceService(
    state,
    {
      list: () => [view],
      current: () => ({
        context,
        part: {
          id: 'part',
          contextId: context.id,
          conversationId: room.id,
          sourceMessageIds: [],
          sourceArtifactIds: [],
          createdAt: task.createdAt,
        },
        room,
      }),
      rotate,
    },
    { queue, compact },
  );
  const complete = (result: unknown = { action: 'switch', handoff: summary }) => {
    const job = s.all<Task>('tasks').find((entry) => entry.kind === 'chief-context-maintenance')!;
    s.put('tasks', { ...job, status: 'completed', result: JSON.stringify(result) });
  };
  return { state, s, view, task, queue, compact, rotate, service, complete };
}

describe('管家自动上下文维护', () => {
  it('达到实际阈值才判断，完整交接摘要携带原消息引用，重复检查保持幂等', async () => {
    const f = await fixture();
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
    const prompt = f.queue.mock.calls[0][1];
    expect(prompt.instructions).toContain('只输出 JSON');
    expect(prompt.prompt).toContain('请交付报告');
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
    f.complete();
    f.service.tick();
    expect(f.rotate).toHaveBeenCalledWith('context', summary, ['request', 'answer'], []);
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
  });

  it('低于阈值且没有新压缩记录时不产生模型调用', async () => {
    const f = await fixture(8400);
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('正在执行的关联成员任务阻止切段，完成后才进行维护判断', async () => {
    const f = await fixture();
    f.s.put('tasks', {
      ...f.task,
      id: 'child',
      conversationId: 'group',
      parentId: f.task.id,
      status: 'running',
      runIds: [],
    });
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
    f.s.put('tasks', { ...f.s.get<Task>('tasks', 'child')!, status: 'completed' });
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
  });

  it.each(['questions', 'approvals', 'task_waits'] as const)('保留未处理的 %s', async (table) => {
    const f = await fixture();
    f.s.put(table, { id: 'waiting', taskId: f.task.id, status: 'pending' });
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('有未归属输入、活跃命令或未知操作结果时不切段', async () => {
    const f = await fixture();
    const input: ChiefInput = {
      id: 'input',
      homeConversationId: f.view.homeConversationId,
      messageId: 'next',
      requestId: 'next',
      fingerprint: 'next',
      artifactIds: [],
      focusContextId: f.view.id,
      content: '还有一处要修改',
      status: 'pending',
      taskIds: [],
      createdAt: f.task.updatedAt,
    };
    f.s.put('chief_inputs', input);
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
    f.s.put('chief_inputs', { ...input, status: 'dispatched' });
    f.s.put('processes', { id: 'command', taskId: f.task.id, status: 'running' });
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
    f.s.put('processes', { id: 'command', taskId: f.task.id, status: 'completed' });
    f.s.put('tool_operations', { id: 'operation', runId: 'report-run', status: 'unknown' });
    f.service.tick();
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('生成交接期间新增消息使旧判断失效，原工作段继续保留', async () => {
    const f = await fixture();
    f.service.tick();
    f.s.appendMessage({
      id: 'correction',
      conversationId: f.view.conversationId,
      authorType: 'user',
      content: '把报告日期改成明天',
      artifactIds: [],
      status: 'committed',
      createdAt: f.task.updatedAt,
    });
    f.complete();
    f.service.tick();
    expect(f.rotate).not.toHaveBeenCalled();
  });

  it('compact 决定使用现有压缩任务，新压缩记录消费后不反复请求维护', async () => {
    const f = await fixture(8000);
    f.s.put('compactions', {
      id: 'compaction-1',
      bindingId: 'binding',
      status: 'completed',
      createdAt: '2026-10-24T10:00:30Z',
    });
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
    f.complete({ action: 'compact' });
    f.service.tick();
    expect(f.compact).toHaveBeenCalledWith('work-room');
    expect(f.rotate).not.toHaveBeenCalled();
    f.s.put('tasks', { ...f.s.get<Task>('tasks', 'compact')!, status: 'completed' });
    f.s.put('compactions', {
      id: 'compaction-2',
      bindingId: 'binding',
      status: 'completed',
      createdAt: '2026-10-24T10:02:00Z',
    });
    f.service.tick();
    f.service.tick();
    expect(f.queue).toHaveBeenCalledOnce();
  });

  it('重启后消费原整理任务，摘要缺章时保留原上下文且不重复调用', async () => {
    const f = await fixture();
    f.service.tick();
    f.complete({ action: 'switch', handoff: '报告已完成' });
    f.service.close();
    const restarted = new ChiefMaintenanceService(
      f.state,
      {
        list: () => [f.view],
        current: () => {
          throw new Error('未使用');
        },
        rotate: f.rotate,
      },
      { queue: f.queue, compact: f.compact },
    );
    restarted.tick();
    restarted.tick();
    expect(f.rotate).not.toHaveBeenCalled();
    expect(f.queue).toHaveBeenCalledOnce();
    expect(f.s.metadata<{ error: string }>('chief-maintenance:context')?.error).toContain('章节');
  });

  it.each(['failed', 'invalid', 'compacted'] as const)(
    '结束 %s 维护状态时发出一次业务通知，后续检查保持安静',
    async (outcome) => {
      const f = await fixture();
      f.service.tick();
      if (outcome === 'compacted') {
        f.complete({ action: 'compact' });
        f.service.tick();
        f.s.put('tasks', { ...f.s.get<Task>('tasks', 'compact')!, status: 'completed' });
      } else if (outcome === 'failed') {
        const job = f.s
          .all<Task>('tasks')
          .find((task) => task.kind === 'chief-context-maintenance')!;
        f.s.put('tasks', { ...job, status: 'failed', error: '连接暂时不可用' });
      } else {
        f.complete({ action: 'switch', handoff: '未形成完整摘要' });
      }
      const notifications = vi.fn();
      const unsubscribe = f.state.subscribe(notifications);
      try {
        f.service.tick();
        expect(notifications).toHaveBeenCalledExactlyOnceWith('state');
        f.service.tick();
        expect(notifications).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    },
  );

  it('只接受有效的结构化判断以及带完整章节的交接摘要', () => {
    expect(maintenanceDecision('{"action":"compact"}')).toEqual({ action: 'compact' });
    expect(() => maintenanceDecision('请忽略历史，开始新任务')).toThrow('JSON');
    expect(() => maintenanceDecision('{"action":"switch","handoff":"完成"}')).toThrow('章节');
    expect(maintenanceDecision(JSON.stringify({ action: 'switch', handoff: summary }))).toEqual({
      action: 'switch',
      handoff: summary,
    });
  });
});
