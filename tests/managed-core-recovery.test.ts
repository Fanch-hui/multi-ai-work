import { createServer, type Server } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { eventually, setup } from './core-harness.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const textDelta = (delta: string) => ({ type: 'response.output_text.delta',
  output_index: 0, content_index: 0, item_id: 'reply', delta });
const completed = (text: string) => ({ type: 'response.completed', response: {
  id: 'response', status: 'completed', output: [{ type: 'message', id: 'reply', status: 'completed',
    role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
} });
const chatChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

describe('managed recovery through Core', () => {
  it('replaces interrupted draft text while keeping one task, run and final reply', async () => {
    const finish = gate();
    const model = await fixture(index => index === 0
      ? { events: [textDelta('中断前的草稿')] }
      : { events: [textDelta('重新生成的完整答复')], wait: finish.promise, tail: [completed('重新生成的完整答复')] });
    const client = createClient(model.url);
    const { core, bot } = await setup(context => runManaged(client, context, 'responses', [1, 1, 1, 1, 1]));
    const member = bot('恢复助手');
    const room = core.entities.createConversation({ name: '断流恢复', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '完成答复' });
    try {
      await eventually(() => model.requests.length === 2
        && core.state.storage.messages(room.id).some(message => message.content.includes('重新生成的完整答复')));
      const drafts = core.state.storage.messages(room.id).filter(message => message.authorType === 'bot');
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ content: '重新生成的完整答复', status: 'draft' });
    } finally { finish.release(); }
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    const task = core.state.storage.get<Task>('tasks', sent.taskIds[0])!;
    expect(task).toMatchObject({ result: '重新生成的完整答复', runIds: [expect.any(String)] });
    expect(core.state.snapshot().tasks.filter(item => item.conversationId === room.id)).toHaveLength(1);
    expect(core.state.snapshot().runs.filter(item => item.taskId === task.id)).toHaveLength(1);
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toEqual([expect.objectContaining({ content: '重新生成的完整答复', status: 'committed', runId: task.runIds[0] })]);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
  });

  it('reuses a completed artifact tool result when the following Chat stream is interrupted', async () => {
    const artifactText = '真实写入且只交付一次';
    const model = await fixture(index => {
      if (index === 0) return { events: [chatChunk({ content: '已生成。', tool_calls: [{ index: 0,
        id: 'write-report', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({
          path: 'report.md', format: 'markdown', content: artifactText,
        }) } }] }, 'tool_calls')] };
      return { events: index === 1 ? [chatChunk({ content: '中断的核验草稿' })]
        : [chatChunk({ content: '核验完成' }, 'stop')] };
    });
    const client = createClient(model.url);
    const { core, root, bot } = await setup(context => runManaged(client, context, 'chat-completions', [1, 1, 1, 1, 1]));
    const member = bot('报告作者', ['write_artifact']);
    const room = core.entities.createConversation({ name: '成果恢复', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '生成报告并核验' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    const task = core.state.storage.get<Task>('tasks', sent.taskIds[0])!;
    expect(task).toMatchObject({ result: '已生成。核验完成', runIds: [expect.any(String)] });
    const artifacts = core.state.snapshot().artifacts.filter(item => item.taskId === task.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ botId: member.id, conversationId: room.id,
      source: 'write_artifact', workingPath: await realpath(join(root, 'workspace', 'report.md')) });
    expect(task.artifactIds).toEqual([artifacts[0].id]);
    expect(await readFile(artifacts[0].path, 'utf8')).toBe(artifactText);
    expect(await readFile(join(root, 'workspace', 'report.md'), 'utf8')).toBe(artifactText);
    expect(core.state.storage.all('tool_operations'))
      .toEqual([expect.objectContaining({ runId: task.runIds[0], status: 'succeeded' })]);
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toEqual([expect.objectContaining({ content: '已生成。核验完成', status: 'committed' })]);
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]).toEqual(model.requests[1]);
    expect(model.requests[2].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'write-report', content: expect.stringContaining(artifacts[0].id) }),
    ]));
  });
});

interface StreamReply { events: unknown[]; wait?: Promise<void>; tail?: unknown[]; }
async function fixture(reply: (index: number) => StreamReply) {
  const requests: Record<string, unknown>[] = [];
  const encode = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const stream = reply(requests.push(JSON.parse(body)) - 1);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(encode(stream.events));
    if (stream.wait) await stream.wait;
    response.end(encode(stream.tail ?? []));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
