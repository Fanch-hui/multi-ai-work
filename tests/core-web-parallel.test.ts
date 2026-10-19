import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import { progressForRun } from '../src/core/managed-progress.js';
import { completeToolBatch } from '../src/providers/managed/loop-tools.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';
import { fetchWeb } from '../src/tools/web.js';
import { search } from '../src/tools/search.js';
import { setup } from './core-harness.js';

vi.mock('../src/tools/web.js', async (original) => ({
  ...(await original<typeof import('../src/tools/web.js')>()),
  fetchWeb: vi.fn(),
}));
vi.mock('../src/tools/search.js', async (original) => ({
  ...(await original<typeof import('../src/tools/search.js')>()),
  search: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function fixture(calls: NonNullable<ModelMessage['toolCalls']>) {
  let input!: RunContext, state!: ManagedRunState;
  const { core, bot } = await setup(async (context) => {
    input = context;
    state = new ManagedRunState(context);
    state.messages.push({ role: 'assistant', content: '', toolCalls: calls });
    await completeToolBatch(context, state, new Set());
    return { text: '完成', messages: state.archiveMessages() };
  });
  core.scheduler.pause();
  const connection = await core.entities.saveTool({
    name: '搜索',
    kind: 'search',
    enabled: true,
    url: 'https://search.example/query',
  });
  const member = core.entities.saveBot({
    ...bot('检索成员', ['fetch_web', 'search_web', 'post_message']),
    approvalMode: 'auto',
    toolConnectionIds: [connection.id],
  });
  const room = core.entities.createConversation({
    name: '检索',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '查阅资料' });
  const done = core.executor.execute(task, new AbortController().signal);
  return { core, member, room, done, input: () => input, state: () => state };
}

describe('Core 联网只读批次', () => {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  let started: string[];
  beforeEach(() => {
    gates.clear();
    started = [];
    for (let index = 0; index < 6; index++) gates.set(String(index), deferred());
    vi.mocked(fetchWeb).mockImplementation(async (url) => {
      const id = new URL(url).pathname.slice(1);
      started.push(id);
      await gates.get(id)!.promise;
      return { url, content: `网页 ${id}`, links: [], fetchedAt: '', truncated: false };
    });
    vi.mocked(search).mockImplementation(async (query, connectionId) => {
      started.push(query);
      await gates.get(query)!.promise;
      return {
        query,
        connectionId: connectionId!,
        service: '搜索',
        backend: 'http',
        fetchedAt: '',
        results: [],
        sources: [],
        truncated: false,
      };
    });
  });

  it('使用 Core 并行名单，逐项保存结果，发言屏障后才继续下一个网页', async () => {
    const calls = [
      { name: 'fetch_web', arguments: '{"url":"https://a.example/0"}' },
      { name: 'search_web', arguments: '{"query":"1"}' },
      { name: 'fetch_web', arguments: '{"url":"https://b.example/2"}' },
      { name: 'search_web', arguments: '{"query":"3"}' },
      { name: 'post_message', arguments: '{"content":"已完成第一批检索"}' },
      { name: 'fetch_web', arguments: '{"url":"https://c.example/5"}' },
    ].map((call, index) => ({ ...call, id: String(index) }));
    const f = await fixture(calls);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      expect(f.input().parallelToolNames).not.toEqual(expect.arrayContaining(['call_mcp']));
      expect(f.input().parallelToolNames).not.toEqual(expect.arrayContaining(['write_file']));
      gates.get('3')!.resolve();
      await vi.waitFor(() =>
        expect(f.core.state.storage.get('tool_operations', `${f.input().runId}:3`)).toMatchObject({
          status: 'succeeded',
        }),
      );
      await vi.waitFor(() =>
        expect(
          progressForRun(f.core.state.storage, f.input().runId)?.progress.messages,
        ).toContainEqual(expect.objectContaining({ role: 'tool', callId: '3' })),
      );
      expect(
        f.core.state.storage
          .messages(f.room.id)
          .some((message) => message.content === '已完成第一批检索'),
      ).toBe(false);
      for (const id of ['0', '1', '2']) gates.get(id)!.resolve();
      await vi.waitFor(() => expect(started).toHaveLength(5));
      expect(
        f.core.state.storage
          .messages(f.room.id)
          .some((message) => message.content === '已完成第一批检索'),
      ).toBe(true);
      gates.get('5')!.resolve();
      await f.done;
      expect(
        f
          .state()
          .messages.filter((message) => message.role === 'tool')
          .map((message) => message.callId),
      ).toEqual(['0', '1', '2', '3', '4', '5']);
      expect(f.core.state.storage.all('tool_operations')).toHaveLength(6);
      expect(
        f.core.state.storage
          .all<{ status: string }>('tool_operations')
          .every((operation) => operation.status === 'succeeded'),
      ).toBe(true);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      await f.done;
    }
  });

  it('同站点等待期间撤销工具权限，已完成结果保留，排队请求记录失败', async () => {
    const calls = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      name: 'fetch_web',
      arguments: JSON.stringify({ url: `https://same.example/${index}` }),
    }));
    const f = await fixture(calls);
    try {
      await vi.waitFor(() => expect(started).toEqual(['0', '1']));
      await vi.waitFor(() => expect(f.core.state.storage.all('tool_operations')).toHaveLength(4));
      f.core.entities.saveBot({ ...f.member, toolNames: [] });
      gates.get('0')!.resolve();
      gates.get('1')!.resolve();
      await f.done;
      expect(started).toEqual(['0', '1']);
      const operations = f.core.state.storage.all<{ id: string; status: string; error?: string }>(
        'tool_operations',
      );
      expect(operations.filter((operation) => operation.status === 'succeeded')).toHaveLength(2);
      expect(operations.filter((operation) => operation.status === 'failed')).toEqual([
        expect.objectContaining({
          id: `${f.input().runId}:2`,
          error: expect.stringContaining('未授权'),
        }),
        expect.objectContaining({
          id: `${f.input().runId}:3`,
          error: expect.stringContaining('未授权'),
        }),
      ]);
      expect(f.state().messages.filter((message) => message.role === 'tool')).toHaveLength(4);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      await f.done;
    }
  });
});
