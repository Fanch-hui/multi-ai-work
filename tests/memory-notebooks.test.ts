import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Memory } from '../apps/ui/src/Memory.js';
import { MemoryNotebook } from '../apps/ui/src/MemoryNotebook.js';
import { memoryNotebooks } from '../apps/ui/src/memory-notebooks.js';
import { setup } from './core-harness.js';

async function fixture() {
  const result = await setup(async () => ({ text: '完成' }));
  const chief = result.bot('Chief'), member = result.bot('写作助手');
  const workspaceId = result.core.state.snapshot().workspaces[0].id;
  const room = result.core.entities.createConversation({ name: '写作资料', kind: 'private', memberIds: [chief.id], workspaceId });
  const save = (content: string) => result.core.memories.save({ content, scope: 'bot', ownerId: chief.id,
    sourceIds: ['source'], allowedConversationIds: [room.id] });
  return { ...result, chief, member, room, workspaceId, save };
}

describe('member memory notebooks', () => {
  it('shows one entry per member while preserving all individual memory records', async () => {
    const { core, chief, member, save } = await fixture();
    const first = save('采用中文标题'), second = save('每周检查进度');
    const data = core.state.snapshot(), groups = memoryNotebooks(data);
    expect(groups.map(group => group.id)).toEqual([chief.id, member.id, 'public']);
    expect(groups.find(group => group.id === chief.id)?.entries.map(entry => entry.id).sort()).toEqual([first.id, second.id].sort());
    const html = renderToStaticMarkup(createElement(Memory, { data, mutate: async () => undefined as never }));
    expect(html.match(/打开Chief的记忆/g)).toHaveLength(1);
    expect(html.match(/<article/g)).toHaveLength(3);
    expect(core.state.storage.all('memory_entries')).toEqual([first, second]);
  });

  it('keeps team and shared scopes together in the public notebook without changing authorization', async () => {
    const { core, chief, member, workspaceId } = await fixture();
    const group = core.entities.createConversation({ name: '协作组', kind: 'group', chiefId: chief.id,
      memberIds: [chief.id, member.id], workspaceId });
    const team = core.memories.save({ content: '组内成果使用 Markdown', scope: 'team', ownerId: group.id, sourceIds: ['source'] });
    const shared = core.memories.save({ content: '公司术语表', scope: 'shared', ownerId: 'shared', allowedConversationIds: [group.id] });
    const data = core.state.snapshot(), publicNotebook = memoryNotebooks(data).find(item => item.id === 'public')!;
    expect(publicNotebook.entries.map(entry => entry.id).sort()).toEqual([team.id, shared.id].sort());
    expect(memoryNotebooks(data).find(item => item.id === chief.id)?.entries).toEqual([]);
    const html = renderToStaticMarkup(createElement(MemoryNotebook, { notebook: publicNotebook, data,
      mutate: async () => undefined as never, edit: () => undefined, add: () => undefined }));
    expect(html).toContain('团队会话 · 协作组');
    expect(html).toContain('共享资料');
    expect(html).not.toContain('<article');
    expect(core.state.storage.get('memory_entries', team.id)).toEqual(team);
    expect(core.state.storage.get('memory_entries', shared.id)).toEqual(shared);
  });

  it('searches member names or memory content without trimming the member notebook', async () => {
    const { core, chief, save } = await fixture();
    const first = save('预算使用人民币'), second = save('周五汇报');
    const selected = memoryNotebooks(core.state.snapshot(), '预算');
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(chief.id);
    expect(selected[0].entries.map(entry => entry.id).sort()).toEqual([first.id, second.id].sort());
    expect(memoryNotebooks(core.state.snapshot(), '写作助手')[0].entries).toEqual([]);
  });

  it('separates members with the same name and keeps archived members with saved memory available', async () => {
    const { core, chief, member, save } = await fixture();
    const memory = save('保存的工作约定');
    core.entities.saveBot({ ...member, name: 'Chief' });
    core.state.storage.put('bots', { ...chief, archived: true });
    let notebooks = memoryNotebooks(core.state.snapshot());
    expect(notebooks.filter(item => item.name === 'Chief').map(item => item.id)).toEqual([chief.id, member.id]);
    core.memories.revoke(memory.id);
    notebooks = memoryNotebooks(core.state.snapshot());
    expect(notebooks.some(item => item.id === chief.id)).toBe(false);
    expect(notebooks.find(item => item.id === member.id)?.entries).toEqual([]);
  });

  it('groups entries by topic, displays usage stats, and warns when pinned entries exceed budget', async () => {
    const { core, chief, room } = await fixture();
    const shortPinned = core.memories.save({
      content: '优先使用中文回复',
      topic: '语言偏好',
      tags: ['中文', '格式'],
      pinned: true,
      scope: 'bot',
      ownerId: chief.id,
      allowedConversationIds: [room.id],
    });
    const hugePinned = core.memories.save({
      content: `超长置顶记忆内容 ${'核心架构约束说明 '.repeat(260)}`,
      topic: '架构约束',
      pinned: true,
      scope: 'bot',
      ownerId: chief.id,
      allowedConversationIds: [room.id],
    });

    core.memory.selectContext({ botId: chief.id, conversationId: room.id }, {
      query: '中文',
      recordAutoInject: true,
      scopeKey: 'run-ui-1',
    });

    const data = core.state.snapshot();
    const chiefNotebook = memoryNotebooks(data, '中文')[0]!;
    expect(chiefNotebook.id).toBe(chief.id);
    expect(chiefNotebook.overflowIds).toContain(hugePinned.id);
    expect(chiefNotebook.overflowIds).not.toContain(shortPinned.id);

    const html = renderToStaticMarkup(createElement(MemoryNotebook, {
      notebook: chiefNotebook,
      data,
      mutate: async () => undefined as never,
      edit: () => undefined,
      add: () => undefined,
    }));
    expect(html).toContain('语言偏好');
    expect(html).toContain('架构约束');
    expect(html).toContain('#中文');
    expect(html).toContain('已置顶');
    expect(html).toContain('未纳入全文');
    expect(html).toContain('超出自动注入预算上限');
    expect(html).toContain('自动注入 1 次 · 主动读取 0 次');
    expect(html).toContain('整理记忆');
  });

  it('isolates consolidation status between chief personal notebook and public notebook', async () => {
    const { core, chief, room, workspaceId, save } = await fixture();
    save('管家个人工作偏好');
    const group = core.entities.createConversation({
      name: '公共项目群',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id],
      workspaceId,
    });
    core.memories.save({ content: '团队公共交付规范', scope: 'team', ownerId: group.id, sourceIds: ['source'] });

    core.state.storage.put('tasks', {
      id: 'task-public-review',
      conversationId: group.id,
      botId: chief.id,
      requestId: 'memory:public:batch-1',
      depth: 0,
      kind: 'memory-review',
      goal: '整理长期记忆',
      expectedOutput: '完成',
      status: 'running',
      dependencyIds: [],
      artifactIds: [],
      runIds: [],
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    });

    const data = core.state.snapshot();
    const notebooks = memoryNotebooks(data);
    const chiefNotebook = notebooks.find(item => item.id === chief.id)!;
    const publicNotebook = notebooks.find(item => item.id === 'public')!;

    const chiefHtml = renderToStaticMarkup(createElement(MemoryNotebook, {
      notebook: chiefNotebook,
      data,
      mutate: async () => undefined as never,
      edit: () => undefined,
      add: () => undefined,
    }));
    const publicHtml = renderToStaticMarkup(createElement(MemoryNotebook, {
      notebook: publicNotebook,
      data,
      mutate: async () => undefined as never,
      edit: () => undefined,
      add: () => undefined,
    }));

    expect(publicHtml).toContain('整理中…');
    expect(publicHtml).toContain('正在后台整理记忆');
    expect(chiefHtml).toContain('整理记忆');
    expect(chiefHtml).not.toContain('整理中…');
    expect(chiefHtml).not.toContain('正在后台整理记忆');
    expect(room.id).toBeTruthy();
  });
});
