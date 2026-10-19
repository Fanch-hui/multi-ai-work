import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact, Bot, Conversation, Task } from '../src/domain/types.js';
import { artifactGroups, artifactProducer } from '../apps/ui/src/artifact-groups.js';
import { ArtifactGroups, ArtifactItem } from '../apps/ui/src/Artifacts.js';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  conversationId: 'room',
  botId: 'chief',
  dependencyIds: [],
  goal: `任务 ${id}`,
  expectedOutput: '',
  status: 'completed',
  runIds: [],
  artifactIds: [],
  requestId: id,
  depth: 0,
  createdAt: '2026-10-12T10:00:00Z',
  updatedAt: '2026-10-12T10:00:00Z',
  ...extra,
});
const artifact = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  name: `${id}.txt`,
  path: `/artifacts/${id}.txt`,
  mimeType: 'text/plain',
  sha256: id,
  size: 10,
  conversationId: 'room',
  createdAt: '2026-10-12T11:00:00Z',
  ...extra,
});
const room: Conversation = {
  id: 'room',
  name: '团队项目',
  kind: 'group',
  memberIds: ['chief'],
  workspaceId: 'workspace',
  createdAt: '2026-10-12T10:00:00Z',
};
const main: Conversation = {
  ...room,
  id: 'main',
  name: '主对话',
  kind: 'private',
  purpose: 'chief',
};
const group = (id: string, sourceTaskId: string, sourceConversationId = 'main'): Conversation => ({
  ...room,
  id,
  name: `任务群 ${id}`,
  purpose: 'task',
  sourceTaskId,
  sourceConversationId,
});
const bot = (id: string): Bot => ({
  id,
  name: `智能体 ${id}`,
  role: '',
  instructions: '',
  connectionId: 'connection',
  model: 'model',
  color: 'blue',
  avatar: 'panda',
  toolNames: [],
  skillIds: [],
  memoryMode: 'off',
  revision: 1,
  archived: false,
});

describe('artifact library conversation groups', () => {
  it('keeps final JSON and image deliverables while excluding process artifacts and user material', () => {
    const artifacts = [
      artifact('data', {
        name: '数据.json',
        mimeType: 'application/json',
        purpose: 'deliverable',
        source: 'register_artifact',
      }),
      artifact('image', { name: '配图.png', mimeType: 'image/png', purpose: 'deliverable' }),
      artifact('draft', { purpose: 'intermediate' }),
      artifact('preview', { source: 'render_document', name: 'page-0001.png' }),
      artifact('raw', { source: 'search_web', name: 'search_web完整结果.json' }),
      artifact('attachment', { source: 'user-attachment', purpose: 'deliverable' }),
      artifact('export', { source: 'render_document', name: '报告.pdf', purpose: 'deliverable' }),
      artifact('legacy-json', {
        source: 'register_artifact',
        name: '计划.json',
        mimeType: 'application/json',
      }),
    ];
    expect(
      artifactGroups({ artifacts, tasks: [], conversations: [room] })[0].artifacts.map(
        (item) => item.id,
      ),
    ).toEqual(['data', 'image', 'export', 'legacy-json']);
    expect(artifacts).toHaveLength(8);
  });

  it('combines the task tree without changing producer ownership or hiding identical working paths', () => {
    const child = task('child', { parentId: 'parent', goal: '生成  \n 成员报告' });
    const first = artifact('parent-file', { taskId: 'parent', workingPath: '/work/report.txt' });
    const second = artifact('child-file', { taskId: 'child', workingPath: '/work/report.txt' });
    const groups = artifactGroups({
      artifacts: [first, second],
      tasks: [task('parent', { artifactIds: [second.id] }), child],
      conversations: [room],
    });
    expect(groups.map((group) => [group.id, group.artifacts.map((item) => item.id)])).toEqual([
      ['conversation:room', [first.id, second.id]],
    ]);
    expect(groups[0]).toMatchObject({ title: '团队项目' });
    expect(groups[0].artifacts).toEqual([first, second]);
    expect(second.taskId).toBe('child');
  });

  it('follows parent and explicit source links across groups and includes later group rounds', () => {
    const tasks = [
      task('root', { conversationId: 'main', goal: '制作项目报告' }),
      task('member', { conversationId: 'first', parentId: 'root', botId: 'member' }),
      task('nested', { conversationId: 'second', parentId: 'member', botId: 'other' }),
      task('later', { conversationId: 'first', botId: 'member' }),
      task('later-nested', { conversationId: 'second', botId: 'other' }),
    ];
    const artifacts = tasks.map((item) =>
      artifact(item.id, {
        taskId: item.id,
        botId: item.botId,
        conversationId: item.conversationId,
      }),
    );
    const groups = artifactGroups({
      tasks,
      artifacts,
      conversations: [main, group('first', 'root'), group('second', 'member', 'first')],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'conversation:main', title: '主对话' });
    expect(groups[0].artifacts).toEqual(artifacts);
  });

  it('combines independent requests and multiple task groups in the same main conversation', () => {
    const tasks = ['one', 'two'].map((id) =>
      task(id, { conversationId: 'main', goal: '同一个标题' }),
    );
    const artifacts = ['one', 'two'].map((id) =>
      artifact(id, { taskId: `child-${id}`, workingPath: '/work/report.txt' }),
    );
    tasks.push(
      ...['one', 'two'].map((id) => task(`child-${id}`, { conversationId: id, parentId: id })),
    );
    const groups = artifactGroups({
      tasks,
      artifacts,
      conversations: [main, group('one', 'one'), group('two', 'two')],
    });
    expect(groups.map((item) => [item.id, item.artifacts.map((file) => file.id)])).toEqual([
      ['conversation:main', ['one', 'two']],
    ]);
  });

  it('selects each producing task newest version without hiding other task outputs in the same conversation', () => {
    const older = artifact('old', { taskId: 'first', workingPath: '/work/report.txt' });
    const newer = artifact('new', {
      taskId: 'first',
      workingPath: '/work/report.txt',
      createdAt: '2026-10-12T13:00:00Z',
    });
    const other = artifact('other', { taskId: 'second', createdAt: '2026-10-12T12:00:00Z' });
    const groups = artifactGroups({
      artifacts: [newer, other, older],
      tasks: [task('first'), task('second')],
      conversations: [room],
    });
    expect(groups.map((group) => [group.id, group.artifacts.map((item) => item.id)])).toEqual([
      ['conversation:room', ['new', 'other']],
    ]);
  });

  it('shows the preceding version after a single ID deletion and preserves other producers and tasks', () => {
    const artifacts = [
      artifact('old', { taskId: 'first', botId: 'chief', workingPath: '/work/report.txt' }),
      artifact('new', {
        taskId: 'first',
        botId: 'chief',
        workingPath: '/work/report.txt',
        createdAt: '2026-10-12T13:00:00Z',
      }),
      artifact('other-author', {
        taskId: 'first',
        botId: 'member',
        workingPath: '/work/report.txt',
      }),
      artifact('other-task', { taskId: 'second', botId: 'chief', workingPath: '/work/report.txt' }),
    ];
    const groups = artifactGroups({
      artifacts: artifacts.filter((item) => item.id !== 'new'),
      tasks: [task('first'), task('second')],
      conversations: [room],
    });
    expect(groups[0].artifacts.map((item) => item.id)).toEqual([
      'old',
      'other-author',
      'other-task',
    ]);
  });

  it('provides deletion in the library and leaves message attachment actions unchanged', () => {
    const file = artifact('report');
    const mutate = async () => undefined as never;
    const library = renderToStaticMarkup(
      createElement(ArtifactGroups, {
        groups: [{ id: 'room', title: room.name, updatedAt: file.createdAt, artifacts: [file] }],
        data: { tasks: [], bots: [] },
        mutate,
      }),
    );
    expect(library).toContain('aria-label="删除report.txt"');
    expect(library).toContain('aria-label="预览report.txt"');
    const attachment = renderToStaticMarkup(
      createElement(ArtifactItem, { artifact: file, mutate }),
    );
    expect(attachment).not.toContain('aria-label="删除report.txt"');
  });

  it('preserves old unlinked files and missing task files while excluding user attachments', () => {
    const groups = artifactGroups({
      artifacts: [
        artifact('legacy'),
        artifact('deleted-task', { taskId: 'gone' }),
        artifact('attachment', { source: 'user-attachment' }),
      ],
      tasks: [],
      conversations: [room],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'conversation:room', title: '团队项目' });
    expect(groups[0].artifacts.map((item) => item.id)).toEqual(['legacy', 'deleted-task']);
  });

  it('uses the surviving group when its source task is missing and retains orphaned child outputs', () => {
    const tasks = [
      task('child', { conversationId: 'team', parentId: 'gone' }),
      task('later', { conversationId: 'team' }),
    ];
    const artifacts = [
      artifact('first', { taskId: 'child', conversationId: 'team' }),
      artifact('later', { taskId: 'later', conversationId: 'team' }),
      artifact('missing', { taskId: 'also-gone', conversationId: 'team' }),
    ];
    const groups = artifactGroups({ tasks, artifacts, conversations: [group('team', 'gone')] });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'conversation:main', title: '任务群 team', artifacts });
  });

  it('keeps different producers visible while replacing only their own output version', () => {
    const tasks = [task('root'), task('child', { parentId: 'root', botId: 'member' })];
    const artifacts = [
      artifact('old', { taskId: 'child', botId: 'member', workingPath: '/work/report.txt' }),
      artifact('other', { taskId: 'child', botId: 'other', workingPath: '/work/report.txt' }),
      artifact('new', {
        taskId: 'child',
        botId: 'member',
        workingPath: '/work/report.txt',
        createdAt: '2026-10-12T13:00:00Z',
      }),
    ];
    const groups = artifactGroups({ tasks, artifacts, conversations: [room] });
    expect(groups).toHaveLength(1);
    expect(groups[0].artifacts.map((item) => item.id)).toEqual(['new', 'other']);
  });

  it('uses the current conversation name and filters by filename without leaving empty groups', () => {
    const data = {
      artifacts: [artifact('report', { taskId: 'first' }), artifact('notes', { taskId: 'second' })],
      tasks: [task('first', { goal: ' ' }), task('second')],
      conversations: [room],
    };
    expect(artifactGroups(data, 'REPORT')).toMatchObject([
      { id: 'conversation:room', title: '团队项目', artifacts: [{ id: 'report' }] },
    ]);
    expect(artifactGroups(data, 'missing')).toEqual([]);
  });
  it('keeps different main conversations separate even when their names match', () => {
    const other = { ...main, id: 'other' };
    const tasks = [
      task('first', { conversationId: 'main' }),
      task('second', { conversationId: 'other' }),
    ];
    const artifacts = tasks.map((item) =>
      artifact(item.id, { taskId: item.id, conversationId: item.conversationId }),
    );
    expect(
      artifactGroups({ tasks, artifacts, conversations: [main, other] }).map((item) => item.id),
    ).toEqual(['conversation:main', 'conversation:other']);
  });

  it('follows a renamed main conversation instead of using its continuation task goal', () => {
    const data = {
      tasks: [task('continue', { conversationId: 'main', goal: '请你继续' })],
      artifacts: [artifact('file', { taskId: 'continue', conversationId: 'main' })],
      conversations: [main],
    };
    expect(artifactGroups(data)[0].title).toBe('主对话');
    expect(
      artifactGroups({ ...data, conversations: [{ ...main, name: '测试功能' }] })[0].title,
    ).toBe('测试功能');
  });

  it('uses the explicit source conversation even when the original source task is missing', () => {
    const data = {
      tasks: [task('later', { conversationId: 'team' })],
      artifacts: [artifact('file', { taskId: 'later', conversationId: 'team' })],
      conversations: [main, group('team', 'gone')],
    };
    expect(artifactGroups(data)[0]).toMatchObject({ id: 'conversation:main', title: '主对话' });
  });

  it('keeps deleted conversations distinct and preserves their historical task title', () => {
    const tasks = [
      task('first', { conversationId: 'gone-one', goal: '历史项目一' }),
      task('second', { conversationId: 'gone-two', goal: '历史项目二' }),
    ];
    const artifacts = tasks.map((item) =>
      artifact(item.id, { taskId: item.id, conversationId: item.conversationId }),
    );
    expect(
      artifactGroups({ tasks, artifacts, conversations: [] }).map((item) => [item.id, item.title]),
    ).toEqual([
      ['conversation:gone-one', '历史项目一'],
      ['conversation:gone-two', '历史项目二'],
    ]);
  });

  it('keeps unrelated legacy files with the same working path in their own conversations', () => {
    const artifacts = ['gone-one', 'gone-two'].map((id) =>
      artifact(id, { conversationId: id, workingPath: '/work/report.txt' }),
    );
    expect(
      artifactGroups({ artifacts, tasks: [], conversations: [] }).map(
        (item) => item.artifacts[0].id,
      ),
    ).toEqual(['gone-one', 'gone-two']);
  });

  it('does not follow a task group source that conflicts with its recorded source task', () => {
    const tasks = [
      task('source', { conversationId: 'other' }),
      task('member', { conversationId: 'team' }),
    ];
    const data = {
      tasks,
      artifacts: [artifact('file', { taskId: 'member', conversationId: 'team' })],
      conversations: [main, { ...main, id: 'other' }, group('team', 'source')],
    };
    expect(artifactGroups(data)[0]).toMatchObject({
      id: 'conversation:team',
      title: '任务群 team',
    });
  });
});

describe('artifact producer identity', () => {
  const tasks = new Map([['child', task('child', { botId: 'member' })]]);
  const bots = new Map([
    ['chief', bot('chief')],
    ['member', bot('member')],
  ]);

  it('prefers the recorded artifact author and falls back to the actual producing task', () => {
    expect(
      artifactProducer(artifact('explicit', { taskId: 'child', botId: 'chief' }), tasks, bots),
    ).toEqual(bot('chief'));
    expect(artifactProducer(artifact('legacy', { taskId: 'child' }), tasks, bots)).toEqual(
      bot('member'),
    );
  });

  it('leaves deleted or unrecorded authors unknown instead of attributing them to another agent', () => {
    expect(
      artifactProducer(artifact('deleted', { taskId: 'child', botId: 'gone' }), tasks, bots),
    ).toBeUndefined();
    expect(artifactProducer(artifact('unknown'), tasks, bots)).toBeUndefined();
  });
});
