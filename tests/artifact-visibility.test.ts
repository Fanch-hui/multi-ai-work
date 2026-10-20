import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact, Conversation, Snapshot, Task } from '../src/domain/types.js';
import { MessageArtifacts } from '../apps/ui/src/MessageArtifacts.js';
import { ConversationRecords } from '../apps/ui/src/ConversationRecords.js';
import { TaskDetail } from '../apps/ui/src/TaskDetail.js';
import { artifactGroups } from '../apps/ui/src/artifact-groups.js';
import { ArtifactGroups } from '../apps/ui/src/Artifacts.js';

const time = '2026-10-20T10:00:00Z';
const conversation: Conversation = {
  id: 'room',
  name: '项目报告',
  kind: 'private',
  purpose: 'chief',
  memberIds: ['chief'],
  workspaceId: 'workspace',
  createdAt: time,
};
const task: Task = {
  id: 'task',
  conversationId: conversation.id,
  botId: 'chief',
  dependencyIds: [],
  goal: '完成报告',
  expectedOutput: '',
  status: 'completed',
  runIds: [],
  artifactIds: [],
  requestId: 'request',
  depth: 0,
  createdAt: time,
  updatedAt: time,
};
const artifact = (id: string, values: Partial<Artifact> = {}): Artifact => ({
  id,
  name: `${id}.txt`,
  path: `/artifacts/${id}.txt`,
  mimeType: 'text/plain',
  sha256: id,
  size: 10,
  conversationId: conversation.id,
  createdAt: time,
  ...values,
});
const files = [
  artifact('参考资料', { source: 'user-attachment' }),
  artifact('工作草稿', { purpose: 'intermediate' }),
  artifact('预览页面', { source: 'render_document' }),
  artifact('搜索全文', { source: 'search_web', name: 'search_web完整结果.json' }),
  artifact('最终报告', { purpose: 'deliverable' }),
  artifact('旧版交付', { source: 'register_artifact' }),
];
const mutate = async () => undefined as never;

function snapshot(artifacts = files): Snapshot {
  return {
    connections: [],
    bots: [],
    conversations: [conversation],
    workspaces: [],
    messages: [],
    tasks: [{ ...task, artifactIds: [...artifacts.map((item) => item.id), '已删除文件'] }],
    runs: [],
    approvals: [],
    artifacts,
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
      maxActiveRuns: 3,
      maxChildren: 5,
      maxCoordinationRounds: 0,
      trayEnabled: true,
      autoAnswerMemberQuestions: true,
    },
  };
}

describe('user facing file visibility', () => {
  it('keeps the user’s uploaded materials visible in their message', () => {
    const html = renderToStaticMarkup(
      createElement(MessageArtifacts, {
        ids: [files[0].id],
        user: true,
        conversation,
        data: snapshot(),
        mutate,
      }),
    );
    expect(html).toContain('参考资料.txt');
  });

  it.each(['private', 'group'] as const)(
    'shows only deliverables on AI messages in a %s conversation',
    (kind) => {
      const html = renderToStaticMarkup(
        createElement(MessageArtifacts, {
          ids: [...files.map((item) => item.id), '已删除文件'],
          user: false,
          conversation: { ...conversation, kind },
          data: snapshot(),
          mutate,
        }),
      );
      expect(html).toContain('最终报告.txt');
      expect(html).toContain('旧版交付.txt');
      for (const file of files.slice(0, 4)) expect(html).not.toContain(file.name);
      if (kind === 'group') expect(html).toContain('2 个文件');
    },
  );

  it('omits the attachment section when an AI message only refers to process files', () => {
    expect(
      renderToStaticMarkup(
        createElement(MessageArtifacts, {
          ids: files.slice(1, 4).map((item) => item.id),
          user: false,
          conversation,
          data: snapshot(),
          mutate,
        }),
      ),
    ).toBe('');
  });

  it('shows an external tool image after it has explicitly become a deliverable', () => {
    const image = artifact('正式配图', {
      name: '正式配图.png',
      mimeType: 'image/png',
      source: 'mcp-image',
      purpose: 'deliverable',
    });
    const html = renderToStaticMarkup(
      createElement(MessageArtifacts, {
        ids: [image.id],
        user: false,
        conversation,
        data: snapshot([image]),
        mutate,
      }),
    );
    expect(html).toContain('查看图片 正式配图.png');
    expect(artifactGroups(snapshot([image]))[0].artifacts).toEqual([image]);
  });

  it('counts only existing deliverables in work records', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationRecords, { conversation, data: snapshot(), mutate }),
    );
    expect(html).toContain('2 项成果');
    expect(html).not.toContain('7 项成果');
  });

  it('lists each distinct historical content once across repeated registrations', () => {
    const data = snapshot(
      ['old', 'repeated', 'new'].map((id, index) =>
        artifact(id, {
          purpose: 'deliverable',
          botId: 'chief',
          workingPath: '/work/report.txt',
          sha256: (index < 2 ? 'a' : 'b').repeat(64),
          createdAt: `2026-10-20T1${index}:00:00Z`,
        }),
      ),
    );
    const group = artifactGroups(data)[0];
    expect(group.artifacts.map((item) => item.id)).toEqual(['new']);
    expect(group.history?.get('new')?.map((item) => item.id)).toEqual(['repeated']);
    expect(data.artifacts).toHaveLength(3);
  });

  it('lists only deliverables in task details while preserving the internal artifact references', () => {
    const data = snapshot();
    const original = structuredClone(data);
    const html = renderToStaticMarkup(
      createElement(TaskDetail, { task: data.tasks[0], data, mutate }),
    );
    expect(html).toContain('最终报告.txt');
    expect(html).toContain('旧版交付.txt');
    for (const file of files.slice(0, 4)) expect(html).not.toContain(file.name);
    expect(data).toEqual(original);
  });

  it('keeps only the latest deliverable in the library and groups its actual previous versions', () => {
    const data = snapshot([
      artifact('交付旧版', {
        purpose: 'deliverable',
        botId: 'chief',
        workingPath: '/work/report.txt',
      }),
      artifact('交付新版', {
        purpose: 'deliverable',
        botId: 'chief',
        workingPath: '/work/report.txt',
        createdAt: '2026-10-20T11:00:00Z',
      }),
      artifact('下一轮草稿', {
        purpose: 'intermediate',
        botId: 'chief',
        workingPath: '/work/report.txt',
        createdAt: '2026-10-20T12:00:00Z',
      }),
      artifact('其他成员交付', {
        purpose: 'deliverable',
        botId: 'member',
        workingPath: '/work/report.txt',
      }),
      files[0],
    ]);
    const groups = artifactGroups(data);
    expect(groups).toHaveLength(1);
    expect(groups[0].artifacts.map((item) => item.id)).toEqual(['交付新版', '其他成员交付']);
    expect(groups[0].history?.get('交付新版')?.map((item) => item.id)).toEqual(['交付旧版']);
    expect(groups[0].history?.has('其他成员交付')).toBe(false);
    const html = renderToStaticMarkup(createElement(ArtifactGroups, { groups, data, mutate }));
    expect(html).toContain('历史版本 · 1');
    expect(html).toContain('交付旧版.txt');
    expect(html).not.toContain('下一轮草稿.txt');
    expect(html).not.toContain('参考资料.txt');
    expect(html.match(/<details[^>]*>/g)?.every((tag) => !tag.includes('open'))).toBe(true);
    expect(artifactGroups(data, '交付旧版')).toEqual([]);
  });
});
