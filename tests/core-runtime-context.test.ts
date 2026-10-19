import { expect, it } from 'vitest';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Task } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { eventually, setup } from './core-harness.js';

async function fixture(beforeRun?: (context: RunContext) => void, toolRound = false) {
  const requests: {
    instructions: string;
    input: { role?: string; content?: string; type?: string; call_id?: string }[];
  }[] = [];
  const client = createClient('http://127.0.0.1:7777/v1', undefined, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const output =
      toolRound && requests.length === 1
        ? ['one', 'two'].map((id) => ({
            type: 'function_call',
            id: `item-${id}`,
            call_id: id,
            name: 'read_file',
            arguments: '{}',
            status: 'completed',
          }))
        : [
            {
              type: 'message',
              id: `answer-${requests.length}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '完成', annotations: [] }],
            },
          ];
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: `r${requests.length}`, status: 'completed', output } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const { core, bot, connection } = await setup((context) => {
    beforeRun?.(context);
    return runManaged(client, context, 'responses');
  });
  core.state.storage.put('connections', { ...connection, protocol: 'responses', status: 'ready' });
  const member = core.entities.saveBot({
    ...bot('原名', toolRound ? ['read_file'] : []),
    memoryMode: 'manual',
  });
  const room = core.entities.createConversation({
    name: '原会话',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const turn = async () => {
    const id = core.tasks.send({ conversationId: room.id, content: '请继续工作' }).taskIds[0];
    await eventually(() =>
      ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', id)?.status ?? ''),
    );
    return id;
  };
  return { core, member, room, requests, turn };
}

it('名称变化追加当前资料一次，系统前缀稳定且原始协议归属正确', async () => {
  const { core, member, room, requests, turn } = await fixture();
  await turn();
  core.entities.saveBot({ ...member, name: '新名' });
  core.state.storage.put('conversations', { ...room, name: '新会话' });
  await turn();
  await turn();
  expect(new Set(requests.map((request) => request.instructions)).size).toBe(1);
  const data = requests.map((request) =>
    request.input.filter(
      (message) =>
        typeof message.content === 'string' && message.content.startsWith('App 当前运行资料'),
    ),
  );
  expect(data.map((items) => items.length)).toEqual([1, 2, 2]);
  expect(data[1].at(-1)?.content).toContain('新名');
  expect(requests[2].input.slice(0, requests[1].input.length)).toEqual(requests[1].input);
  const archives = core.state.storage.all<{ entries: ModelHistoryEntry[] }>('provider_archive');
  const initialUser = archives[0].entries.find(
    (entry) => entry.message.role === 'user' && !entry.message.appContext,
  )!;
  expect(initialUser.messageId).toBe(core.state.storage.messages(room.id)[0].id);
  expect(initialUser.sequence).toBe(1);
});

it('撤销记忆重建工作投影，去除旧资料与旧摘要，原始档案完整保留', async () => {
  const { core, member, room, requests, turn } = await fixture();
  const memory = core.memories.save({
    scope: 'bot',
    ownerId: member.id,
    content: '过时喜好',
    allowedConversationIds: [room.id],
  });
  await turn();
  const binding = core.state.snapshot().bindings[0];
  const history = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${binding.id}`)!;
  const summary: ModelMessage = {
    role: 'assistant',
    content: '过时喜好摘要',
    contextSummary: true,
  };
  core.state.storage.setMetadata(`history:${binding.id}`, [
    ...history,
    { ...history.at(-1)!, message: summary },
  ]);
  core.memories.revoke(memory.id);
  await turn();
  expect(requests[1].instructions).toBe(requests[0].instructions);
  expect(JSON.stringify(requests[1].input)).not.toContain('过时喜好');
  expect(
    requests[1].input.filter(
      (message) =>
        typeof message.content === 'string' && message.content.startsWith('App 当前运行资料'),
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(core.state.storage.all('provider_archive'))).toContain('过时喜好');
});

it.each(['改名', '撤销记忆'])(
  '%s 后恢复部分完成的工具批次，保留配对并跳过已保存结果',
  async (change) => {
    let interrupt = true;
    const executed: string[] = [];
    const { core, member, room, requests, turn } = await fixture((context) => {
      context.parallelToolNames = [];
      context.executeTool = async (_name, _args, callId) => {
        executed.push(callId);
        return { result: callId };
      };
      const save = context.saveProgress!;
      context.saveProgress = async (progress) => {
        await save(progress);
        if (
          interrupt &&
          progress.phase === 'tools' &&
          progress.messages.some((message) => message.role === 'tool')
        ) {
          interrupt = false;
          throw new Error('模拟中断');
        }
      };
    }, true);
    const memory = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      content: '旧约定',
      allowedConversationIds: [room.id],
    });
    const task = await turn();
    expect(core.state.storage.get<Task>('tasks', task)?.status).toBe('failed');
    expect(executed).toEqual(['one']);
    if (change === '改名') core.entities.saveBot({ ...member, name: '恢复新名' });
    else core.memories.revoke(memory.id);
    await core.request('tasks.retry', { id: task });
    await eventually(() => core.state.storage.get<Task>('tasks', task)?.status === 'completed');
    expect(executed).toEqual(['one', 'two']);
    expect(requests).toHaveLength(2);
    expect(
      requests[1].input
        .filter((message) => message.type === 'function_call_output')
        .map((message) => message.call_id),
    ).toEqual(['one', 'two']);
    expect(requests[1].instructions).toBe(requests[0].instructions);
    if (change === '改名') expect(JSON.stringify(requests[1].input)).toContain('恢复新名');
    else expect(JSON.stringify(requests[1].input)).not.toContain('旧约定');
  },
);
