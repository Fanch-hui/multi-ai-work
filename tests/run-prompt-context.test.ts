import { describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { MemoryService } from '../src/runtime/memory.js';
import { runPrompt } from '../src/core/run-prompt.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
  const bot = createBot('原成员');
  const peer = createBot('原同事');
  const room = core.entities.createConversation({ name: '原会话', kind: 'group', chiefId: peer.id, memberIds: [bot.id, peer.id],
    workspaceId: core.state.snapshot().workspaces[0].id });
  const task: Task = { id: 'prompt-test', conversationId: room.id, botId: bot.id, dependencyIds: [], goal: '整理资料',
    expectedOutput: '', status: 'running', runIds: [], artifactIds: [], requestId: 'request-test', depth: 0,
    createdAt: '2026-10-16', updatedAt: '2026-10-16' };
  const storage = core.state.storage;
  const memory = new MemoryService({ list: () => storage.all('memory_entries'), save: entry => storage.put('memory_entries', entry) });
  const tools = { skills: [] } as unknown as ToolExecutionContext;
  const render = (managed = false) => runPrompt(core.state, memory, task, bot, room, tools, [], undefined, managed);
  return { core, storage, bot, peer, room, task, tools, memory, render };
}

describe('上下文指令兼容内容', () => {
  it('托管请求固定前缀，带版本的当前资料承载名称、成员和记忆', async () => {
    const { storage, bot, peer, room, memory, render } = await fixture();
    bot.memoryMode = 'manual';
    const before = render(true);
    bot.name = '新成员'; room.name = '新会话';
    storage.put('bots', { ...peer, name: '新同事' });
    const entry = memory.propose({ botId: bot.id, conversationId: room.id, scope: 'bot', content: '始终使用中文', sourceIds: [] });
    memory.resolve(entry.id, true);
    const after = render(true);
    expect(after.instructions).toBe(before.instructions);
    expect(after.instructions).not.toContain('始终使用中文');
    expect(after.instructions).not.toContain('新同事');
    expect(after.runtimeContext?.content).toContain('新同事');
    expect(after.runtimeContext?.content).toContain('新会话');
    expect(after.runtimeContext?.content).toContain('始终使用中文');
    expect(after.runtimeContext?.appContext?.version).not.toBe(before.runtimeContext?.appContext?.version);
    expect(render(true).runtimeContext).toEqual(after.runtimeContext);
    expect(after.contextInstructions).not.toBe(before.contextInstructions);
    memory.revoke(entry.id);
    const revoked = render(true);
    expect(revoked.instructions).toBe(before.instructions);
    expect(revoked.runtimeContext?.content).not.toContain('始终使用中文');
    expect(render().instructions).toContain('你是 新成员');
    expect(render().runtimeContext).toBeUndefined();
  });

  it('改名和成员顺序只更新实际身份资料，兼容内容使用稳定 ID', async () => {
    const { storage, bot, peer, room, render } = await fixture();
    bot.instructions = '成员：保留这条用户工作指令。当前会话：这是任务数据。';
    const before = render();
    bot.name = '新成员'; room.name = '新会话'; room.memberIds.reverse();
    storage.put('bots', { ...peer, name: '新同事' });
    const after = render();
    expect(after.instructions).toContain('你是 新成员');
    expect(after.instructions).toContain('当前会话：新会话');
    expect(after.instructions).toContain(`新同事 (${peer.id})`);
    expect(after.instructions).not.toBe(before.instructions);
    expect(after.contextInstructions).toBe(before.contextInstructions);
    expect(after.contextInstructions).toContain(bot.instructions);
    expect(after.contextInstructions).toContain(bot.id);
    expect(after.contextInstructions).toContain(peer.id);
  });

  it('策略、职责与技能变化会改变兼容内容', async () => {
    const { bot, tools, render } = await fixture();
    const before = render().contextInstructions;
    bot.approvalMode = 'auto';
    const policy = render().contextInstructions;
    expect(policy).not.toBe(before);
    bot.role = '审阅员';
    const role = render().contextInstructions;
    expect(role).not.toBe(policy);
    tools.skills = [{ id: 'research', name: '研究', description: '核查原始资料' }] as ToolExecutionContext['skills'];
    expect(render().contextInstructions).not.toBe(role);
  });

  it('当前授权记忆的修改及撤销会改变兼容内容', async () => {
    const { storage, bot, room, memory, render } = await fixture();
    bot.memoryMode = 'manual';
    const empty = render().contextInstructions;
    const entry = memory.propose({ botId: bot.id, conversationId: room.id, scope: 'bot', content: '始终使用中文', sourceIds: [] });
    const approved = memory.resolve(entry.id, true);
    const first = render().contextInstructions;
    expect(first).toContain('始终使用中文');
    expect(first).not.toBe(empty);
    storage.put('memory_entries', { ...approved, content: '优先提供原始出处', revision: approved.revision + 1 });
    expect(render().contextInstructions).not.toBe(first);
    memory.revoke(entry.id);
    expect(render().contextInstructions).toBe(empty);
  });
});
