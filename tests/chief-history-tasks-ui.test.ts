import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChiefHistoryTaskRead,
  ChiefHistoryTaskView,
} from '../src/domain/chief-history-tasks.js';
import type { Snapshot } from '../src/domain/types.js';
import { ChiefHistoryTasks, ChiefHistoryTaskListPanel } from '../apps/ui/src/ChiefHistoryTasks.js';
import { ChiefHistoryTaskDetails } from '../apps/ui/src/ChiefHistoryTaskDetails.js';

const resources = vi.hoisted(() => ({
  list: {} as unknown,
  read: {} as unknown,
  loading: false,
  error: '',
  calls: [] as unknown[],
  reload: vi.fn(),
  confirmations: [] as { onConfirm: () => Promise<unknown>; description: string }[],
}));
vi.mock('../apps/ui/src/local-work/useResource.js', () => ({
  useResource: (method: string, params: unknown) => {
    resources.calls.push([method, params]);
    return {
      value: method.endsWith('.list') ? resources.list : resources.read,
      loading: resources.loading,
      error: resources.error,
      reload: resources.reload,
    };
  },
}));
vi.mock('../apps/ui/src/components.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/ui/src/components.js')>()),
  Confirm: (props: {
    onConfirm: () => Promise<unknown>;
    description: string;
    children: unknown;
  }) => {
    resources.confirmations.push(props);
    return props.children;
  },
}));

const time = '2026-10-25T10:00:00Z';
const context = (id: string, values: Partial<ChiefHistoryTaskView> = {}): ChiefHistoryTaskView => ({
  id,
  kind: 'work',
  title: '编制工程量报告',
  workspaceId: 'workspace',
  createdAt: time,
  updatedAt: time,
  partCount: 2,
  taskCount: 1,
  activeTaskIds: [],
  deletable: true,
  ...values,
});
const data = {
  workspaces: [{ id: 'workspace', name: '课程设计' }],
  bots: [{ id: 'chief', name: '管家' }],
  tasks: [],
  artifacts: [],
  conversations: [{ id: 'work-part', kind: 'direct', memberIds: ['chief'] }],
} as unknown as Snapshot;
const mutate = vi.fn(async () => ({ deletedContextId: 'work' }) as never);
const listMarkup = () =>
  renderToStaticMarkup(createElement(ChiefHistoryTaskListPanel, { data, mutate }));

beforeEach(() => {
  resources.list = { items: [] };
  resources.read = undefined;
  resources.loading = false;
  resources.error = '';
  resources.calls = [];
  resources.confirmations = [];
  resources.reload.mockClear();
  mutate.mockReset().mockResolvedValue({ deletedContextId: 'work' } as never);
});

describe('历史任务记录', () => {
  it('折叠时保留入口，打开后请求真实分页列表', () => {
    const collapsed = renderToStaticMarkup(createElement(ChiefHistoryTasks, { data, mutate }));
    expect(collapsed).toContain('历史任务');
    expect(resources.calls).toEqual([]);
    resources.list = { items: [context('work')], nextBefore: 'work' };
    const markup = listMarkup();
    expect(resources.calls).toEqual([
      ['chief.history.tasks.list', { query: undefined, before: undefined, limit: 20 }],
    ]);
    expect(markup).toContain('编制工程量报告');
    expect(markup).toContain('课程设计');
    expect(markup).toContain('历史任务分页');
    expect(markup).toContain('下一页');
  });

  it('固定主上下文和活跃工作显示真实保护原因', () => {
    resources.list = {
      items: [
        context('main', { kind: 'main', title: '管家', deleteBlockedReason: '固定主上下文保留' }),
        context('running', {
          deletable: false,
          activeTaskIds: ['active'],
          deleteBlockedReason: '任务仍在进行',
        }),
        context('routine', {
          kind: 'history',
          deletable: false,
          deleteBlockedReason: '已绑定例行规则',
        }),
      ],
    };
    const markup = listMarkup();
    expect(markup).toContain('主对话上下文');
    expect(markup).toContain('1 项进行中');
    for (const reason of ['固定主上下文保留', '任务仍在进行', '已绑定例行规则']) {
      expect(markup).toMatch(new RegExp(`disabled[^>]*title="${reason}"`));
    }
    expect(resources.confirmations).toHaveLength(0);
  });

  it('确认删除调用真实上下文 ID，成功后才刷新列表', async () => {
    resources.list = { items: [context('work')] };
    listMarkup();
    expect(resources.confirmations).toHaveLength(1);
    expect(resources.confirmations[0].description).toContain(
      '主对话中已显示的消息、交付成果和独立任务群会保留',
    );
    expect(mutate).not.toHaveBeenCalled();
    await resources.confirmations[0].onConfirm();
    expect(mutate).toHaveBeenCalledExactlyOnceWith('chief.history.tasks.delete', {
      contextId: 'work',
    });
    expect(resources.reload).toHaveBeenCalledOnce();
  });

  it('删除被 Core 拒绝时将原因留给确认窗并保留当前列表', async () => {
    resources.list = { items: [context('work')] };
    mutate.mockRejectedValue(new Error('任务仍在进行'));
    listMarkup();
    await expect(resources.confirmations[0].onConfirm()).rejects.toThrow('任务仍在进行');
    expect(resources.reload).not.toHaveBeenCalled();
    expect(listMarkup()).toContain('编制工程量报告');
  });

  it('按真实执行段展示来源指令、消息、交接和关联任务', () => {
    const part = {
      id: 'part',
      contextId: 'work',
      conversationId: 'work-part',
      sourceMessageIds: ['instruction'],
      sourceArtifactIds: [],
      createdAt: time,
      handoff: '已核对图纸，继续计算工程量。',
    };
    resources.read = {
      context: context('work'),
      part,
      parts: [part, { ...part, id: 'part-two' }],
      nextBefore: 12,
      instructions: [
        {
          messageId: 'instruction',
          conversationId: 'home',
          contextId: 'main',
          contextTitle: '管家主对话',
          content: '请根据图纸制作报告',
          createdAt: time,
          taskIds: ['task'],
        },
      ],
      messages: [
        {
          id: 'message',
          conversationId: 'work-part',
          sequence: 12,
          authorType: 'bot',
          authorBotId: 'chief',
          content: '基础工程量已完成',
          artifactIds: [],
          status: 'committed',
          createdAt: time,
        },
      ],
      tasks: [
        {
          id: 'task',
          botId: 'chief',
          conversationId: 'work-part',
          goal: '核算基础工程量',
          status: 'completed',
          runIds: [],
          dependencyIds: [],
          expectedOutput: '工程量清单',
          artifactIds: [],
          requestId: 'request',
          depth: 0,
          createdAt: time,
          updatedAt: time,
        },
      ],
    } as ChiefHistoryTaskRead;
    const markup = renderToStaticMarkup(
      createElement(ChiefHistoryTaskDetails, { contextId: 'work', data, mutate }),
    );
    expect(resources.calls).toEqual([
      [
        'chief.history.tasks.read',
        { contextId: 'work', partId: undefined, before: undefined, limit: 40 },
      ],
    ]);
    for (const text of [
      '选择执行上下文',
      '第 2 段',
      '指令来源',
      '来源：管家主对话',
      '请根据图纸制作报告',
      '基础工程量已完成',
      '已核对图纸',
      '查看任务：核算基础工程量',
      '更早消息',
    ])
      expect(markup).toContain(text);
    expect(markup).toContain('data-instruction-context-id="main"');
    expect(markup).not.toContain('来源：编制工程量报告');
    expect(markup).toContain('data-context-message-id="message"');
    expect(markup).not.toContain('较新消息');
  });
});
