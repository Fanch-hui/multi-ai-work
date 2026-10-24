import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChiefContextView } from '../src/domain/chief-work.js';
import type { Conversation, Message, Snapshot, Task } from '../src/domain/types.js';
import { conversationMessages } from '../apps/ui/src/message-feed.js';
import { conversationRecordTasks } from '../apps/ui/src/conversation-records.js';
import {
  chiefTaskContext,
  contextRecordTasks,
  focusedConversation,
} from '../apps/ui/src/chief-work.js';
import { readableBotMessageIds } from '../apps/ui/src/conversation-read.js';
import { ComposerDraftStore, composerSubmission } from '../apps/ui/src/composer-drafts.js';
import { currentTaskPlan } from '../apps/ui/src/task-plans.js';
import { TeamSnapshotStore } from '../apps/ui/src/snapshot-store.js';
import { SidebarConversationList } from '../apps/ui/src/SidebarConversationList.js';
import { ChiefInputCards } from '../apps/ui/src/ChiefInputCards.js';
import { artifactGroups } from '../apps/ui/src/artifact-groups.js';
import { ApprovalCard } from '../apps/ui/src/TaskDetail.js';
import { UserQuestionCard } from '../apps/ui/src/UserQuestionCard.js';
import { conversationStatistics } from '../apps/ui/src/conversation-statistics.js';

const time = '2026-10-24T10:00:00Z';
const room = (id: string, fields: Partial<Conversation> = {}): Conversation => ({
  id,
  name: id,
  kind: 'private',
  purpose: 'chief',
  chiefId: 'chief',
  memberIds: ['chief'],
  workspaceId: 'project',
  createdAt: time,
  ...fields,
});
const home = room('home', { chiefRole: 'home' });
const context = (id: string, conversationIds: string[]): ChiefContextView => ({
  id,
  title: `事项 ${id}`,
  homeConversationId: 'home',
  currentPartId: id,
  conversationId: conversationIds.at(-1)!,
  conversationIds,
  workspaceId: 'project',
  activeTaskIds: [],
  createdAt: time,
});
const task = (id: string, conversationId: string, parentId?: string): Task => ({
  id,
  conversationId,
  parentId,
  botId: 'chief',
  dependencyIds: [],
  goal: id,
  expectedOutput: '',
  status: 'running',
  runIds: [],
  artifactIds: [],
  requestId: id,
  depth: 0,
  createdAt: time,
  updatedAt: time,
});
const message = (
  id: string,
  conversationId: string,
  sequence: number,
  display?: number,
): Message => ({
  id,
  conversationId,
  sequence,
  content: id,
  authorType: 'bot',
  authorBotId: 'chief',
  status: 'committed',
  artifactIds: [],
  createdAt: time,
  ...(display === undefined ? {} : { chiefTimelineSequence: display }),
});
function snapshot(): Snapshot {
  return {
    connections: [],
    bots: [],
    conversations: [home, room('a1'), room('a2'), room('b1')],
    workspaces: [],
    messages: [],
    tasks: [],
    runs: [],
    approvals: [],
    artifacts: [],
    questions: [],
    processes: [],
    memories: [],
    events: [],
    toolConnections: [],
    skills: [],
    bindings: [],
    checkpoints: [],
    compactions: [],
    taskPlans: [],
    taskInputs: [],
    dataDirectory: '',
    settings: {
      mainConversationId: 'home',
      mainBotId: 'chief',
      maxActiveRuns: 6,
      maxChildren: 5,
      maxCoordinationRounds: 0,
      trayEnabled: true,
      autoAnswerMemberQuestions: true,
    },
    chief: {
      homeConversationId: 'home',
      focusContextId: 'b',
      contexts: [context('a', ['a1', 'a2']), context('b', ['b1'])],
      inputs: [],
    },
  };
}

describe('single Chief workspace presentation', () => {
  it('accumulates work usage across parts and reads only the current part context window', () => {
    const data = snapshot();
    data.tasks = [task('old', 'a1'), task('current', 'a2'), task('other', 'b1')];
    data.runs = data.tasks.map((item, index) => ({
      id: `run-${item.id}`,
      taskId: item.id,
      botId: 'chief',
      bindingId: item.id,
      status: 'completed',
      configRevision: 1,
      createdAt: `${time}-${index}`,
      usage: { source: 'reported', inputTokens: 10, outputTokens: 1 },
      contextUsage: { source: 'app-estimated', estimatedTokens: 5, contextWindow: 100 },
    }));
    const current = data.conversations.find((item) => item.id === 'a2')!;
    const stats = conversationStatistics(data, current);
    expect(stats.turns).toBe(2);
    expect(stats.usage.total).toBe(22);
    expect(stats.context.percent).toBe(5);
    const next = room('a3');
    data.chief!.contexts[0] = context('a', ['a1', 'a2', 'a3']);
    const continued = conversationStatistics(data, next);
    expect(continued.usage.total).toBe(22);
    expect(continued.context.percent).toBeUndefined();
  });

  it('shows projected messages from different work sessions while preserving their source', () => {
    const data = snapshot();
    const a = message('report', 'a1', 900, 1);
    const b = message('code', 'b1', 2, 2);
    data.messages = [a, b, message('private material', 'foreign', 3)];
    expect(conversationMessages(data, home)).toEqual([a, b]);
    expect(a.conversationId).toBe('a1');
    expect(a.sequence).toBe(900);
    expect(readableBotMessageIds(data.messages, 'home', true)).toEqual(['report', 'code']);
    expect(readableBotMessageIds(data.messages, 'a1')).toEqual(['report']);
  });

  it('keeps background work available and scopes the selected work record across parts', () => {
    const data = snapshot();
    data.conversations.push(
      room('group', {
        kind: 'group',
        purpose: 'task',
        sourceConversationId: 'a1',
        sourceTaskId: 'a',
      }),
    );
    data.tasks = [
      task('a', 'a1'),
      task('a-next', 'a2'),
      task('member', 'group', 'a'),
      task('b', 'b1'),
      task('foreign', 'other'),
    ];
    const records = conversationRecordTasks(data, home);
    expect(new Set(records.map((item) => item.id))).toEqual(
      new Set(['a', 'a-next', 'member', 'b']),
    );
    expect(contextRecordTasks(records, ['a1', 'a2']).map((item) => item.id)).toEqual([
      'a',
      'a-next',
      'member',
    ]);
    expect(focusedConversation(data, home).id).toBe('b1');
    expect(chiefTaskContext(data, 'member')?.id).toBe('a');
  });

  it('identifies background work on pending questions and permission requests', () => {
    const data = snapshot();
    data.tasks = [task('a', 'a1'), task('member', 'group', 'a')];
    const mutate = async () => undefined as never;
    const approval = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval: {
          id: 'approval',
          runId: 'run',
          taskId: 'member',
          botId: 'chief',
          toolName: 'write_file',
          summary: '写入报告',
          args: {},
          status: 'pending',
          createdAt: time,
        },
        data,
        mutate,
      }),
    );
    const question = renderToStaticMarkup(
      createElement(UserQuestionCard, {
        question: {
          id: 'question',
          runId: 'run',
          taskId: 'member',
          conversationId: 'group',
          botId: 'chief',
          question: '选择哪个报告格式？',
          status: 'pending',
          createdAt: time,
        },
        data,
        mutate,
      }),
    );
    expect(approval).toContain('事项 a');
    expect(question).toContain('事项 a');
    expect(approval).not.toContain('事项 b');
    expect(question).not.toContain('事项 b');
  });

  it('uses the focused work plan when another background plan is newer', () => {
    const data = snapshot();
    data.tasks = [task('a', 'a2'), task('b', 'b1')];
    data.taskPlans = [
      {
        id: 'plan-a',
        taskId: 'a',
        conversationId: 'a2',
        title: 'A',
        steps: [],
        createdAt: '2026-10-24T12:00:00Z',
        updatedAt: time,
      },
      {
        id: 'plan-b',
        taskId: 'b',
        conversationId: 'b1',
        title: 'B',
        steps: [],
        createdAt: time,
        updatedAt: time,
      },
    ];
    expect(currentTaskPlan(data, home)?.id).toBe('plan-b');
  });

  it('binds a manually chosen work target to its draft and clears it after sending', () => {
    const drafts = new ComposerDraftStore();
    drafts.edit('home', { content: '修改报告', targetContextId: 'a' });
    const submitted = drafts.beginSend('home')!;
    expect(composerSubmission(home, submitted)).toMatchObject({
      targetContextId: 'a',
      content: '修改报告',
    });
    drafts.finishSend('home', submitted.requestId);
    expect(drafts.read('home').targetContextId).toBeUndefined();
    expect(drafts.read('home').content).toBe('');
  });

  it('shows one Chief entry and history while keeping internal sessions out of the sidebar', () => {
    const data = snapshot();
    data.conversations = [
      home,
      room('hidden-work', { chiefRole: 'work' }),
      room('hidden-router', { chiefRole: 'router' }),
      room('old-history', { chiefRole: 'history' }),
    ];
    const html = renderToStaticMarkup(
      createElement(SidebarConversationList, {
        data,
        archived: false,
        query: '',
        selectedId: 'home',
        onSelect: () => undefined,
        onManage: () => undefined,
      }),
    );
    expect(html).toContain('home');
    expect(html).toContain('历史');
    expect(html).toContain('old-history');
    expect(html).not.toContain('hidden-work');
    expect(html).not.toContain('hidden-router');
  });

  it('renders clarification candidates and retains a retry action for failed routing', () => {
    const data = snapshot();
    data.chief!.inputs = [
      {
        id: 'input',
        homeConversationId: 'home',
        messageId: 'pending',
        requestId: 'request',
        fingerprint: '',
        artifactIds: [],
        taskIds: [],
        status: 'clarification',
        question: '要修改哪份报告？',
        candidateContextIds: ['a'],
        createdAt: time,
      },
    ];
    const render = () =>
      renderToStaticMarkup(
        createElement(ChiefInputCards, {
          data,
          mutate: async () => undefined as never,
        }),
      );
    expect(render()).toContain('要修改哪份报告');
    expect(render()).toContain('事项 a');
    expect(render()).not.toContain('事项 b');
    data.chief!.inputs[0] = {
      ...data.chief!.inputs[0],
      status: 'failed',
      question: undefined,
      error: '连接中断',
    };
    expect(render()).toContain('重试');
    expect(render()).toContain('连接中断');
  });

  it('groups deliverables by stable work item across execution parts', () => {
    const data = snapshot();
    data.workspaces = [{ id: 'project', name: '报告项目', path: '/reports', writable: true }];
    data.artifacts = ['a1', 'a2', 'b1'].map((conversationId, i) => ({
      id: `file-${i}`,
      conversationId,
      name: `file-${i}.txt`,
      mimeType: 'text/plain',
      path: `/artifacts/${i}`,
      size: 1,
      sha256: `${i}`,
      purpose: 'deliverable',
      createdAt: time,
    }));
    const groups = artifactGroups(data);
    expect(groups.map((group) => [group.id, group.artifacts.length])).toEqual([
      ['work:a', 2],
      ['work:b', 1],
    ]);
    expect(groups[0].project).toBe('报告项目');
    expect(artifactGroups(data, '报告项目')).toHaveLength(2);
  });

  it('orders a unified timeline by display sequence through reload and streaming updates', async () => {
    let version = 0;
    const a = message('a', 'a1', 90, 1);
    const b = message('b', 'b1', 1, 2);
    const requests: { method: string; params?: Record<string, unknown> }[] = [];
    const store = new TeamSnapshotStore(
      async <T>(method: string, params?: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === 'state.view')
          return {
            snapshot: { ...snapshot(), messages: [b, a] },
            cursor: { epoch: 'same', version: ++version },
            history: { conversationId: 'home' },
          } as T;
        return {
          chief: { ...snapshot().chief!, focusContextId: 'a' },
          cursor: { epoch: 'same', version: ++version },
          messages: [{ ...a, content: 'updated' }],
          tasks: [],
          runs: [],
          processes: [],
        } as T;
      },
      () => undefined,
    );
    await store.refresh(true);
    expect(store.current().data!.messages.map((item) => item.id)).toEqual(['a', 'b']);
    await store.refresh();
    expect(store.current().data!.messages[0].content).toBe('updated');
    expect(store.current().data!.chief?.focusContextId).toBe('a');
    await store.refresh(true);
    expect(requests.at(-1)?.params?.from).toBe(1);
  });
});
