import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, RunContext } from '../src/domain/provider.js';
import type { Bot, Connection, MemoryEntry, ProviderKind, Task } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { caps, eventually, resources } from './core-harness.js';

async function setupSession(provider: ProviderKind, run: ProviderAdapter['run']) {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-session-'));
  const native = provider === 'antigravity' || provider === 'qoder';
  const capabilities = native
    ? { ...caps, runtimeKind: 'native-agent' as const, contextOwner: 'native' as const }
    : caps;
  const core = new CoreService(root, undefined, undefined, [
    { kind: provider, probe: async () => ({ models: [], capabilities }), run },
  ]);
  resources.push({ core, root });
  await core.start();
  const connection: Connection = {
    id: 'connection',
    name: '测试',
    provider,
    status: 'ready',
    models: [
      { id: 'test', name: '测试', reasoning: ['low', 'high'] },
      { id: 'other', name: '另一个', reasoning: ['high'] },
    ],
    concurrency: 1,
    revision: 1,
    createdAt: '',
    capabilities,
  };
  core.state.storage.put('connections', connection);
  const bot = core.entities.saveBot({
    name: '成员',
    role: '研究员',
    instructions: '根据资料回答',
    connectionId: connection.id,
    model: 'test',
  });
  const room = core.entities.createConversation({
    name: '私聊',
    kind: 'private',
    memberIds: [bot.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const turn = async (content: string, status: Task['status'] = 'completed') => {
    const sent = core.tasks.send({ conversationId: room.id, content });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === status,
    );
  };
  return { core, bot, room, turn, connection, root, native };
}

interface Input {
  prompt: string;
  instructions: string;
  bindingId: string;
  resumed?: string;
  runtimeContext?: RunContext['runtimeContext'];
}
function receive(context: RunContext, inputs: Input[]) {
  inputs.push({
    prompt: context.prompt,
    instructions: context.instructions,
    bindingId: context.binding.id,
    resumed: context.binding.nativeSessionId,
    runtimeContext: context.runtimeContext,
  });
  context.persistBinding(context.binding.nativeSessionId ?? `native:${context.binding.id}`);
}

function runtimeMemories(input: Input) {
  expect(input.runtimeContext).toMatchObject({
    role: 'user',
    appContext: { source: 'app.runtime', version: expect.any(String) },
  });
  return JSON.parse(input.runtimeContext!.content.split('\n').at(-1)!).memories;
}

describe('会话续接与当前记忆', () => {
  it.each(['antigravity', 'qoder', 'chatgpt', 'custom'] as const)(
    '%s 保存、修订、撤销记忆及外观修改保持会话',
    async (provider) => {
      const inputs: Input[] = [];
      let memoryId = '';
      const { core, bot, room, turn, native } = await setupSession(provider, async (context) => {
        receive(context, inputs);
        if (inputs.length === 1) {
          const sourceIds = [context.prompt.match(/\[([\w-]+)\] 用户：/)![1]];
          const entry = (await context.executeTool(
            'manage_memory',
            { action: 'save', content: '标题采用中文', sourceIds },
            'remember',
          )) as MemoryEntry;
          expect(entry.id).toBeTruthy();
          memoryId = entry.id;
        }
        return { text: '已处理' };
      });
      await turn('第一轮保存约定');
      const binding = core.state.snapshot().bindings[0];
      await turn('第二轮继续');
      if (native) {
        expect(inputs[1].prompt).toContain(`[${memoryId}@1] 标题采用中文`);
        expect(inputs[1].runtimeContext).toBeUndefined();
        expect(inputs[1].prompt).not.toContain('第一轮保存约定');
        expect(inputs[1].instructions).not.toContain('标题采用中文');
        expect(inputs[1].resumed).toBe(`native:${binding.id}`);
      } else
        expect(runtimeMemories(inputs[1])).toEqual([
          { source: 'memory_entries', id: memoryId, revision: 1, content: '标题采用中文' },
        ]);
      const updatedBot = core.entities.saveBot({
        ...bot,
        name: '新名称',
        avatar: 'fox',
        color: 'blue',
        contextWindow: 500000,
      });
      await turn('第三轮继续');
      if (native) {
        expect(inputs[2].prompt).not.toContain('标题采用中文');
        expect(inputs[2].prompt).toContain(`新名称 (${bot.id})`);
      } else {
        expect(inputs[2].runtimeContext?.content).toContain('新名称');
        expect(runtimeMemories(inputs[2])).toEqual(runtimeMemories(inputs[1]));
      }
      const entry = core.state.storage.get<MemoryEntry>('memory_entries', memoryId)!;
      core.memories.save({ ...entry, content: '标题采用简洁中文' });
      await turn('第四轮继续');
      if (native) expect(inputs[3].prompt).toContain(`[${memoryId}@2] 标题采用简洁中文`);
      else
        expect(runtimeMemories(inputs[3])).toEqual([
          { source: 'memory_entries', id: memoryId, revision: 2, content: '标题采用简洁中文' },
        ]);
      core.memories.revoke(memoryId);
      await turn('第五轮继续');
      if (native) {
        expect(inputs[4].prompt).toContain(`失效的记忆引用：[${memoryId}]`);
        expect(inputs[4].prompt).not.toContain('标题采用');
      } else expect(runtimeMemories(inputs[4])).toEqual([]);
      await turn('第六轮继续');
      if (native) expect(inputs[5].prompt).not.toContain(memoryId);
      else {
        expect(runtimeMemories(inputs[5])).toEqual([]);
        expect(inputs.every((input) => input.instructions === inputs[0].instructions)).toBe(true);
        expect(inputs[0].instructions).not.toContain('标题采用');
      }
      expect(core.state.snapshot().bindings).toHaveLength(1);
      expect(inputs.every((input) => input.bindingId === binding.id)).toBe(true);
      expect(core.state.snapshot().bindings[0].configRevision).toBe(updatedBot.revision);
      expect(core.state.storage.messages(room.id)).toHaveLength(12);
    },
  );

  it.each(['antigravity', 'qoder'] as const)(
    '%s 退出授权和关闭记忆只传失效引用，保持身份隔离',
    async (provider) => {
      const inputs: Input[] = [];
      const { core, bot, room, turn } = await setupSession(provider, async (context) => {
        receive(context, inputs);
        return { text: '完成' };
      });
      const other = core.entities.saveBot({ ...bot, id: undefined, name: '另一成员' });
      const otherRoom = core.entities.createConversation({
        name: '其他私聊',
        kind: 'private',
        memberIds: [other.id],
        workspaceId: room.workspaceId,
      });
      core.memories.save({
        scope: 'bot',
        ownerId: other.id,
        content: '其他私聊资料',
        allowedConversationIds: [otherRoom.id],
      });
      const entry = core.memories.save({
        scope: 'bot',
        ownerId: bot.id,
        content: '当前约定',
        allowedConversationIds: [room.id],
      });
      await turn('首轮');
      expect(inputs[0].prompt).toContain('当前约定');
      expect(inputs[0].prompt).not.toContain('其他私聊资料');
      core.memories.save({ ...entry, allowedConversationIds: [] });
      await turn('退出授权');
      expect(inputs[1].prompt).toContain(`失效的记忆引用：[${entry.id}]`);
      expect(inputs[1].prompt).not.toContain('当前约定');
      core.memories.save({ ...entry, allowedConversationIds: [room.id] });
      await turn('恢复授权');
      expect(inputs[2].prompt).toContain('当前约定');
      core.entities.saveBot({ ...bot, memoryMode: 'off' });
      await turn('关闭记忆');
      expect(inputs[3].prompt).toContain(`失效的记忆引用：[${entry.id}]`);
      expect(core.state.snapshot().bindings).toHaveLength(1);
    },
  );

  it('模型、推理、角色、基础指令、目录、连接和账号变化建立新的 generation', async () => {
    const inputs: Input[] = [];
    const { core, bot, room, turn, connection, root } = await setupSession(
      'antigravity',
      async (context) => {
        receive(context, inputs);
        return { text: '完成' };
      },
    );
    await turn('初始配置');
    const changeBot = (fields: Partial<Bot>) =>
      core.entities.saveBot({ ...core.state.storage.get<Bot>('bots', bot.id)!, ...fields });
    const changeConnection = (fields: Partial<Connection>) =>
      core.state.storage.put('connections', {
        ...core.state.storage.get<Connection>('connections', connection.id)!,
        ...fields,
      });
    const changes = [
      () => changeBot({ model: 'other' }),
      () => changeBot({ reasoning: 'high' }),
      () => changeBot({ role: '写作者' }),
      () => changeBot({ instructions: '按新的身份要求处理' }),
      () =>
        core.state.storage.put('workspaces', {
          ...core.state.snapshot().workspaces[0],
          path: join(root, 'other'),
        }),
      () => changeConnection({ revision: 2 }),
      () => changeConnection({ accountScope: 'other-account' }),
      () => {
        core.state.storage.put('connections', { ...connection, id: 'other-connection' });
        changeBot({ connectionId: 'other-connection' });
      },
    ];
    for (const [index, change] of changes.entries()) {
      change();
      await turn(`配置变更 ${index}`);
      expect(inputs[index + 1].bindingId).not.toBe(inputs[index].bindingId);
      expect(inputs[index + 1].resumed).toBeUndefined();
    }
    expect(core.state.snapshot().bindings.map((binding) => binding.generation)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(core.state.storage.messages(room.id)).toHaveLength(18);
  });

  it.each(['antigravity', 'qoder'] as const)(
    '%s 失败不确认记忆送达，下一轮在同一 session 重传',
    async (provider) => {
      const inputs: Input[] = [];
      const { core, bot, room, turn } = await setupSession(provider, async (context) => {
        receive(context, inputs);
        if (inputs.length === 2) throw new Error('本轮失败');
        return { text: '完成' };
      });
      const entry = core.memories.save({
        scope: 'bot',
        ownerId: bot.id,
        content: '原约定',
        allowedConversationIds: [room.id],
      });
      await turn('首轮');
      core.memories.save({ ...entry, content: '修订约定' });
      await turn('失败轮', 'failed');
      expect(core.state.snapshot().bindings[0].memoryVersions?.[entry.id]).toBe(1);
      await turn('继续');
      expect(inputs[1].prompt).toContain(`[${entry.id}@2] 修订约定`);
      expect(inputs[2].prompt).toContain(`[${entry.id}@2] 修订约定`);
      expect(core.state.snapshot().bindings[0].memoryVersions?.[entry.id]).toBe(2);
      expect(core.state.snapshot().bindings).toHaveLength(1);
    },
  );
});
