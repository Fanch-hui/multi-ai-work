import { describe, expect, it } from 'vitest';
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
  it.each(['antigravity', 'qoder', 'chatgpt', 'custom'] as const)('%s keeps the actual posted reply and archives the provider receipt', async provider => {
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
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: postedId, content: '收到！', status: 'committed' });
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
      .toEqual(['收到！', '第一条实际发言', '第二条实际发言']);
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
      .toEqual(['收到请回复', '补充要求', '收到补充要求', '补充回复']);
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
