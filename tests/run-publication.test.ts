import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { runManaged } from '../src/providers/managed/loop.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderAdapter, RunContext } from '../src/domain/provider.js';
import type { ProviderKind, Task } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import type { ProviderArchive } from '../src/core/managed-context.js';
import { toolsPaired } from '../src/runtime/model-history.js';
import { resources, caps, eventually } from './core-harness.js';

async function setupPublication(provider: ProviderKind, run: ProviderAdapter['run']) {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-publication-'));
  const core = new CoreService(root, undefined, undefined, [{ kind: provider,
    probe: async () => ({ models: [], capabilities: caps }), run }]);
  resources.push({ core, root }); await core.start();
  core.state.storage.put('connections', { id: 'connection', name: '测试', provider, status: 'ready', models: [],
    concurrency: 1, revision: 1, createdAt: '', capabilities: caps });
  const member = core.entities.saveBot({ name: '成员', role: '', instructions: '', connectionId: 'connection',
    model: 'test-model', toolNames: ['post_message', 'read_messages'], memoryMode: 'off' });
  const room = core.entities.createConversation({ name: '讨论', kind: 'group', chiefId: member.id,
    memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
  return { core, member, room };
}

const text = (context: RunContext, delta: string) => context.emit({ type: 'text', data: { delta } });

describe('Core reply publication', () => {
  it.each(['antigravity', 'qoder', 'chatgpt', 'custom'] as const)('%s preserves visible progress, posted replies and the final response', async provider => {
    let postedId = '';
    const { core, room } = await setupPublication(provider, async context => {
      text(context, '准备回复。');
      const posted = await context.executeTool('post_message', { content: '收到！' }, 'reply') as { messageId: string };
      postedId = posted.messageId;
      const replay = await context.executeTool('post_message', { content: '收到！' }, 'reply') as { messageId: string };
      expect(replay.messageId).toBe(postedId);
      text(context, '已发布消息，消息 ID 和回执。');
      return { text: '已发布消息，消息 ID 和回执。' };
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '收到请回复' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    const replies = core.state.storage.messages(room.id).filter(message => message.authorType === 'bot');
    expect(replies.map(message => message.content)).toEqual(['准备回复。', '收到！', '已发布消息，消息 ID 和回执。']);
    expect(replies.every(message => message.status === 'committed')).toBe(true);
    expect(replies[1].id).toBe(postedId);
    expect(core.state.storage.all<{ output?: string }>('provider_archive')[0]?.output).toBe('已发布消息，消息 ID 和回执。');
  });

  it('streams and commits a direct reply once, while keeping multiple intentional posts', async () => {
    let round = 0;
    const { core, room } = await setupPublication('custom', async context => {
      if (++round === 1) { text(context, '收到'); text(context, '！'); return { text: '收到！' }; }
      await context.executeTool('post_message', { content: '第一条实际发言' }, 'first');
      await context.executeTool('post_message', { content: '第二条实际发言' }, 'second');
      text(context, '执行记录'); return { text: '执行记录' };
    });
    const first = core.tasks.send({ conversationId: room.id, content: '直接回复' });
    await eventually(() => core.state.storage.get<Task>('tasks', first.taskIds[0])?.status === 'completed');
    const second = core.tasks.send({ conversationId: room.id, content: '分两条发言' });
    await eventually(() => core.state.storage.get<Task>('tasks', second.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot').map(message => message.content))
      .toEqual(['收到！', '第一条实际发言', '第二条实际发言', '执行记录']);
  });

  it('retains a delivered message on a later run failure and removes an empty failed draft', async () => {
    let round = 0;
    const { core, room } = await setupPublication('custom', async context => {
      if (++round === 1) {
        await context.executeTool('post_message', { content: '已经送达的回复' }, 'reply');
        text(context, '内部回执');
      }
      throw new Error('网络中断');
    });
    for (const content of ['先发言再失败', '未产生发言就失败']) {
      const sent = core.tasks.send({ conversationId: room.id, content });
      await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'failed');
    }
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot')).toMatchObject([
      { content: '已经送达的回复', status: 'committed' },
      { content: '内部回执', status: 'interrupted' },
    ]);
  });

  it('publishes after messages received during the run so incremental readers see the reply', async () => {
    let round = 0, followupTaskId = '';
    const { core, room } = await setupPublication('custom', async context => {
      if (++round !== 1) return { text: '补充回复' };
      text(context, '正在回复');
      const followup = core.tasks.send({ conversationId: room.id, content: '补充要求' });
      followupTaskId = followup.taskIds[0];
      const cursor = core.state.storage.getMessage(followup.messageId)!.sequence;
      await context.executeTool('post_message', { content: '收到补充要求' }, 'reply');
      const fresh = await context.executeTool('read_messages', { after: cursor }, 'read') as { content: string }[];
      expect(fresh.map(message => message.content)).toEqual(['收到补充要求']);
      return { text: '发布回执' };
    });
    const first = core.tasks.send({ conversationId: room.id, content: '收到请回复' });
    await eventually(() => core.state.storage.get<Task>('tasks', first.taskIds[0])?.status === 'completed');
    await eventually(() => core.state.storage.get<Task>('tasks', followupTaskId)?.status === 'completed');
    expect(core.state.storage.messages(room.id).map(message => message.content))
      .toEqual(['收到请回复', '正在回复', '补充要求', '收到补充要求', '发布回执', '补充回复']);
  });

  it('keeps each assistant output as one bubble and commits the final output without cumulative duplication', async () => {
    const { core, room } = await setupPublication('custom', async context => {
      context.emit({ type: 'text', data: { delta: '先查看', messageKey: 'first' } });
      context.emit({ type: 'text', data: { delta: '资料。', messageKey: 'first' } });
      context.emit({ type: 'text', data: { delta: '已找到问题。', messageKey: 'second' } });
      context.emit({ type: 'text', data: { delta: '最终答复。', messageKey: 'final' } });
      return { text: '先查看资料。已找到问题。最终答复。' };
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '处理资料' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toMatchObject([{ content: '先查看资料。', status: 'committed' },
        { content: '已找到问题。', status: 'committed' }, { content: '最终答复。', status: 'committed' }]);
  });

  it.each(['responses', 'chat-completions'] as const)('%s separates real model tool turns and final output', async protocol => {
    let requests = 0;
    const create = async () => {
      const first = requests++ === 0, content = first ? '先检查资料。' : '检查完成。';
      return (async function* () {
        if (protocol === 'chat-completions') {
          yield { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
          if (first) yield { choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, id: 'read', type: 'function', function: { name: 'read_messages', arguments: '{}' } },
          ] }, finish_reason: null }] };
          yield { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] };
          return;
        }
        const message = { type: 'message', id: 'visible', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: content, annotations: [] }] };
        const call = { type: 'function_call', id: 'read-item', call_id: 'read', name: 'read_messages', arguments: '{}', status: 'completed' };
        yield { type: 'response.output_text.delta', output_index: 0, item_id: 'visible', content_index: 0, delta: content };
        yield { type: 'response.output_item.done', output_index: 0, item: message };
        if (first) yield { type: 'response.output_item.done', output_index: 1, item: call };
        yield { type: 'response.completed', response: { id: `response-${requests}`, status: 'completed', output: first ? [message, call] : [message] } };
      })();
    };
    const client = { baseURL: 'http://fixture.invalid/v1', responses: { create }, chat: { completions: { create } } } as unknown as OpenAI;
    const { core, room } = await setupPublication('custom', context => runManaged(client, context, protocol, []));
    const sent = core.tasks.send({ conversationId: room.id, content: '请检查' });
    await eventually(() => ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status ?? ''));
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({ status: 'completed' });
    expect(requests).toBe(2);
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toMatchObject([{ content: '先检查资料。', status: 'committed' }, { content: '检查完成。', status: 'committed' }]);
    expect(core.state.storage.all<{ name: string; status: string }>('tool_operations'))
      .toMatchObject([{ name: 'read_messages', status: 'succeeded' }]);
  });

  it('preserves separate message items from one Responses request, including terminal-only output', async () => {
    const output = ['先检查资料。', '检查完成。'].map((content, index) => ({ type: 'message', id: `message-${index}`,
      role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }));
    const client = { baseURL: 'http://fixture.invalid/v1', responses: { create: async () => (async function* () {
      yield { type: 'response.output_text.delta', output_index: 0, item_id: 'message-0', content_index: 0, delta: '先检查资料。' };
      yield { type: 'response.output_item.done', output_index: 0, item: output[0] };
      yield { type: 'response.completed', response: { id: 'response', status: 'completed', output } };
    })() } } as unknown as OpenAI;
    const { core, room } = await setupPublication('custom', context => runManaged(client, context, 'responses', []));
    const sent = core.tasks.send({ conversationId: room.id, content: '检查资料' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toMatchObject([{ content: '先检查资料。', status: 'committed' }, { content: '检查完成。', status: 'committed' }]);
  });

  it('completes the current bubble using the authoritative final response', async () => {
    const { core, room } = await setupPublication('antigravity', async context => {
      context.emit({ type: 'text', data: { delta: '先检查资料。', messageKey: 'progress' } });
      context.emit({ type: 'text', data: { delta: '检查完成', messageKey: 'final' } });
      return { text: '检查完成，发现两处需要调整。' };
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '检查资料' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toMatchObject([{ content: '先检查资料。', status: 'committed' },
        { content: '检查完成，发现两处需要调整。', status: 'committed' }]);
  });

  it('does not repeat committed progress when a supplemental reply starts after post_message', async () => {
    const { core, room } = await setupPublication('custom', async context => {
      text(context, '先检查资料。');
      await context.executeTool('post_message', { content: '已通知成员。' }, 'post');
      context.userInput!.beginReply('先检查资料。');
      text(context, '按补充要求完成。');
      return { text: '按补充要求完成。' };
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '检查资料' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot').map(message => message.content))
      .toEqual(['先检查资料。', '已通知成员。', '按补充要求完成。']);
  });

  it('preserves earlier assistant outputs and interrupted text after a stream failure', async () => {
    const { core, room } = await setupPublication('custom', async context => {
      context.emit({ type: 'text', data: { delta: '已完成第一步。', messageKey: 'first' } });
      context.emit({ type: 'text', data: { delta: '第二步进行中', messageKey: 'second' } });
      throw new Error('stream interrupted');
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '分步执行' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'failed');
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot'))
      .toMatchObject([{ content: '已完成第一步。', status: 'committed' }, { content: '第二步进行中', status: 'interrupted' }]);
  });

  it('keeps tool pairing and opaque provider history tied to the actual published message', async () => {
    const { core, room } = await setupPublication('custom', async context => {
      const posted = await context.executeTool('post_message', { content: '收到！' }, 'reply') as { messageId: string };
      return { text: '', messages: [...context.messages, { role: 'user', content: context.prompt },
        { role: 'assistant', content: '', toolCalls: [{ id: 'reply', name: 'post_message', arguments: '{"content":"收到！"}' }] },
        { role: 'tool', callId: 'reply', content: JSON.stringify(posted) },
        { role: 'assistant', content: '', providerItems: [{ type: 'reasoning', opaque: 'preserve-fixture' }] },
      ] };
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '收到请回复' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.result).toBe('收到！');
    const archive = core.state.storage.all<ProviderArchive>('provider_archive')[0];
    expect(toolsPaired(archive.entries)).toBe(true);
    expect(archive.entries.every(entry => !!core.state.storage.getMessage(entry.messageId))).toBe(true);
    expect(archive.entries.at(-1)?.message.providerItems).toEqual([{ type: 'reasoning', opaque: 'preserve-fixture' }]);
    expect(core.state.storage.messages(room.id).filter(message => message.authorType === 'bot')).toHaveLength(1);
  });
});
