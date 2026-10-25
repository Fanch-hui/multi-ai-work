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
import { ChiefInputFeedback } from '../apps/ui/src/ChiefInputFeedback.js';
import { Workspaces } from '../apps/ui/src/Workspaces.js';
import { ChatHeader } from '../apps/ui/src/ChatHeader.js';
import {
  workCardConversationIds,
  conversationWorkItems,
} from '../apps/ui/src/work-chat/work-card-scope.js';
import { conversationSkillDrafts } from '../apps/ui/src/work-chat/WorkCards.js';
import { MessageFeed } from '../apps/ui/src/MessageFeed.js';
import { OnboardingProfile } from '../apps/ui/src/OnboardingProfile.js';
import { ChiefWorkProgress } from '../apps/ui/src/ChiefWorkProgress.js';
import { workingMembers } from '../apps/ui/src/message-feed.js';
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
    conversations: [home, room('a1'), room('a2'), room('b1'), room('main-part')],
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
      mainContextId: 'main',
      contexts: [
        context('a', ['a1', 'a2']),
        context('b', ['b1']),
        { ...context('main', ['main-part']), kind: 'main' },
      ],
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
    expect(focusedConversation(data, home).id).toBe('main-part');
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

  it('shows the latest real work plan without changing the continuous main context', () => {
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
    expect(currentTaskPlan(data, home)?.id).toBe('plan-a');
    expect(focusedConversation(data, home).id).toBe('main-part');
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

  it('attaches compact retry and clarification feedback to the original message', () => {
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
        createElement(ChiefInputFeedback, {
          data,
          messageId: 'pending',
          mutate: async () => undefined as never,
        }),
      );
    expect(render()).toContain('要修改哪份报告');
    expect(render()).toContain('回复管家');
    expect(render()).not.toContain('事项 a');
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

  it('keeps an actual model failure next to the submitted message', () => {
    const data = snapshot();
    data.tasks = [{ ...task('chat', 'main-part'), status: 'failed', error: '模型连接中断' }];
    data.chief!.inputs = [
      {
        id: 'input',
        homeConversationId: 'home',
        messageId: 'message',
        requestId: 'request',
        fingerprint: '',
        artifactIds: [],
        taskIds: ['chat'],
        status: 'dispatched',
        createdAt: time,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ChiefInputFeedback, {
        data,
        messageId: 'message',
        mutate: async () => undefined as never,
      }),
    );
    expect(html).toContain('模型连接中断');
    expect(html).toContain('重试');
    expect(html).not.toContain('取消');
  });

  it('counts all Chief usage while reading only the main context and keeping worker activity out of chat waiting', () => {
    const data = snapshot();
    data.tasks = [
      task('chat', 'main-part'),
      task('work', 'a2'),
      { ...task('summary', 'router'), kind: 'chief-context-maintenance' },
      { ...task('member', 'group'), botId: 'member' },
    ];
    data.runs = data.tasks.map((item, index) => ({
      id: `r-${item.id}`,
      taskId: item.id,
      botId: item.botId,
      bindingId: item.id,
      status: 'running',
      configRevision: 1,
      createdAt: `${time}-${index}`,
      usage: { source: 'reported', inputTokens: 10, outputTokens: 1 },
      contextUsage: {
        source: 'app-estimated',
        estimatedTokens: item.id === 'chat' ? 5 : 90,
        contextWindow: 100,
      },
    }));
    const stats = conversationStatistics(data, home);
    expect(stats.usage.total).toBe(33);
    expect(stats.context.percent).toBe(5);
    expect(workingMembers(data, home, []).map((item) => item.task.id)).toEqual(['chat']);
    expect(
      conversationStatistics(data, data.conversations.find((item) => item.id === 'main-part')!)
        .usage.total,
    ).toBe(33);
  });

  it('keeps the fixed Chief header focused on chat and advanced controls while member management remains available', () => {
    const props = {
      conversation: home,
      bots: [],
      view: 'chat' as const,
      pending: 0,
      working: 0,
      sidebarCollapsed: false,
      onExpandSidebar: () => {},
      onSelectConversation: () => {},
      onViewChange: () => {},
      onMembers: () => {},
      onBrowser: () => {},
      onComputer: () => {},
      onPending: () => {},
      pendingWork: 0,
    };
    const main = renderToStaticMarkup(createElement(ChatHeader, props));
    expect(main).not.toContain('管理当前会话');
    expect(main).toContain('电脑操作');
    expect(main).toContain('工作浏览器');
    const member = renderToStaticMarkup(
      createElement(ChatHeader, {
        ...props,
        conversation: room('member', { purpose: undefined }),
        onManage: () => {},
      }),
    );
    expect(member).toContain('管理当前会话');
  });

  it('summarizes actual independent work in one progress row', () => {
    const data = snapshot();
    data.chief!.contexts[0].kind = 'work';
    data.chief!.contexts[1].kind = 'work';
    data.tasks = [task('a', 'a2'), task('b', 'b1'), task('chat', 'main-part')];
    const html = renderToStaticMarkup(
      createElement(ChiefWorkProgress, {
        data,
        onRecords: () => {},
        onSelectConversation: () => {},
      }),
    );
    expect(html).toContain('2 项进行中');
    expect(html).toContain('事项 a');
    expect(html).toContain('事项 b');
    expect(html).not.toContain('事项 main');
    expect(html).toContain('查看记录');
  });

  it('configures Chief identity and model during onboarding without selecting a project', () => {
    const data = snapshot();
    data.settings.defaultWorkspaceId = 'default';
    data.workspaces = [
      { id: 'foreign', name: '外部项目', path: '/foreign', writable: true },
      { id: 'default', name: '工作成果', path: '/default', writable: true },
    ];
    const connection = {
      id: 'connection',
      name: 'ChatGPT',
      provider: 'chatgpt' as const,
      status: 'ready' as const,
      concurrency: 2,
      revision: 1,
      createdAt: time,
      models: [{ id: 'model', name: 'Model' }],
    };
    const html = renderToStaticMarkup(
      createElement(OnboardingProfile, {
        data,
        connection,
        mutate: async () => undefined as never,
        busy: false,
        onSubmit: async () => {},
      }),
    );
    expect(html).toContain('管家的名字');
    expect(html).toContain('头像');
    expect(html).toContain('选择一个模型');
    expect(html).not.toContain('工作目录');
    expect(html).not.toContain('外部项目');
  });

  it('shows the actual authorization state for each project directory', () => {
    const data = snapshot();
    data.workspaces = [
      { id: 'default', name: '工作成果', path: '/default', writable: true },
      { id: 'read', name: '资料', path: '/read', writable: false },
      { id: 'revoked', name: '旧项目', path: '/old', writable: true, enabled: false },
    ];
    const html = renderToStaticMarkup(
      createElement(Workspaces, { data, mutate: async () => undefined as never }),
    );
    expect(html).toContain('读写');
    expect(html).toContain('只读');
    expect(html).toContain('已撤销');
    expect(html).toContain('管理目录 资料');
  });

  it('projects review items from associated work and groups while retaining their real sources', () => {
    const data = snapshot();
    data.conversations.push(
      room('group', {
        kind: 'group',
        purpose: 'task',
        sourceConversationId: 'a2',
        sourceTaskId: 'work',
      }),
      room('foreign', { purpose: undefined }),
    );
    data.tasks = [task('work', 'a2'), task('member', 'group', 'work'), task('private', 'foreign')];
    const scope = workCardConversationIds(data, 'home');
    expect(scope.has('main-part')).toBe(true);
    expect(scope.has('a1')).toBe(true);
    expect(scope.has('group')).toBe(true);
    expect(scope.has('foreign')).toBe(false);
    const routine = { id: 'routine', conversationId: 'a2' };
    const unrelated = { id: 'unrelated', conversationId: 'foreign' };
    expect(conversationWorkItems([routine, unrelated], scope)).toEqual([routine]);
    const drafts = [
      { id: 'skill', sourceConversationId: 'group' },
      { id: 'other', sourceConversationId: 'foreign' },
    ] as import('../src/domain/work-skills.js').WorkSkillDraft[];
    expect(conversationSkillDrafts(drafts, scope)).toEqual([drafts[0]]);
    expect(conversationSkillDrafts(drafts, scope)[0]).toBe(drafts[0]);
    expect([...workCardConversationIds(data, 'group')]).toEqual(['group']);
    expect([...workCardConversationIds(data, 'foreign')]).toEqual(['foreign']);
  });

  it('links work-created task groups from the fixed main conversation', () => {
    const data = snapshot();
    const source = message('create-group', 'main-part', 1, 1);
    data.messages = [source, message('next-message', 'main-part', 2, 2)];
    data.conversations.push(
      room('report-group', {
        name: '报告协作群',
        kind: 'group',
        purpose: 'task',
        sourceConversationId: 'a2',
        sourceTaskId: 'work',
        sourceMessageId: source.id,
      }),
      room('private-group', {
        name: '其他私聊群',
        kind: 'group',
        purpose: 'task',
        sourceConversationId: 'foreign',
        sourceMessageId: source.id,
      }),
    );
    const html = renderToStaticMarkup(
      createElement(MessageFeed, {
        data,
        conversation: home,
        mutate: async () => undefined as never,
        onSelectConversation: () => {},
      }),
    );
    expect(html).toContain('报告协作群');
    expect(html).not.toContain('其他私聊群');
    expect(html.indexOf('data-task-group-id="report-group"')).toBeGreaterThan(
      html.indexOf('data-message-id="create-group"'),
    );
    expect(html.indexOf('data-task-group-id="report-group"')).toBeLessThan(
      html.indexOf('data-message-id="next-message"'),
    );
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

  it('labels work deliverables with their actual project sources', () => {
    const data = snapshot();
    data.workspaces = [
      { id: 'project', name: '报告', path: '/reports', writable: true },
      { id: 'other', name: '代码', path: '/code', writable: true },
    ];
    data.artifacts = ['project', 'other'].map((workspaceId, index) => ({
      id: `file-${index}`,
      chiefContextId: 'a',
      conversationId: 'a2',
      workspaceId,
      name: `file-${index}.txt`,
      mimeType: 'text/plain',
      path: `/artifacts/${index}`,
      size: 1,
      sha256: `${index}`,
      purpose: 'deliverable',
      createdAt: time,
    }));
    const groups = artifactGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBe('报告 · 代码');
    expect(artifactGroups(data, '代码')).toHaveLength(1);
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
