import { describe, expect, it } from 'vitest';
import { professions } from '../src/domain/market.js';
import { chiefInstructions } from '../src/core/chief.js';
import type { CoreService } from '../src/core/service.js';
import { eventually, setup } from './core-harness.js';

async function completeTurn(core: CoreService, conversationId: string) {
  const sent = core.tasks.send({ conversationId, content: '请处理当前工作' });
  await eventually(() => core.state.snapshot().tasks.find(task => task.id === sent.taskIds[0])?.status === 'completed');
}

describe('主管职业系统指令', () => {
  it('在已有主对话下一轮应用职业变化，多选合并，跳过或空选择恢复基础指令', async () => {
    const instructions: string[] = [];
    const { core, connection } = await setup(async context => {
      if (!context.binding.purpose) instructions.push(context.instructions);
      return { text: '完成' };
    });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
    const conversationId = core.state.settings().mainConversationId!;
    await completeTurn(core, conversationId);
    const baseline = instructions.at(-1)!;
    expect(baseline).toContain(chiefInstructions);

    await core.request('career.save', { professionIds: ['legal'], status: 'completed' });
    await completeTurn(core, conversationId);
    const legal = instructions.at(-1)!;
    expect(legal).toContain(chiefInstructions);
    expect(legal).toContain('律师／法务');
    expect(legal).toMatch(/法域|法律|合同/);

    await core.request('career.save', { professionIds: ['student', 'research'], status: 'completed' });
    await completeTurn(core, conversationId);
    const academic = instructions.at(-1)!;
    expect(academic).toContain(chiefInstructions);
    expect(academic).toContain('大学生');
    expect(academic).toContain('科研／学术研究');
    expect(academic).toMatch(/课程|自学|学习/);
    expect(academic).toMatch(/文献|研究|引用/);
    expect(academic).not.toContain('律师／法务');

    await core.request('career.save', { professionIds: ['legal'], status: 'skipped' });
    await completeTurn(core, conversationId);
    expect(instructions.at(-1)).toBe(baseline);

    await core.request('career.save', { professionIds: [], status: 'completed' });
    await completeTurn(core, conversationId);
    expect(instructions.at(-1)).toBe(baseline);
    expect(instructions).toHaveLength(5);
  });

  it('只对内置主管注入用户职业，普通成员保留自己的工作指令', async () => {
    const instructions = new Map<string, string>();
    const { core, connection, bot } = await setup(async context => {
      if (!context.binding.purpose) instructions.set(context.bot.id, context.instructions);
      return { text: '完成' };
    });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
    const member = core.entities.saveBot({ ...bot('普通成员'), instructions: '根据材料完成成员自己的工作' });
    const room = core.entities.createConversation({ name: '成员私聊', kind: 'private', memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id });
    await core.request('career.save', { professionIds: ['legal'], status: 'completed' });
    await completeTurn(core, room.id);
    expect(instructions.get(member.id)).toContain(member.instructions);
    expect(instructions.get(member.id)).not.toContain('律师／法务');
    await completeTurn(core, core.state.settings().mainConversationId!);
    expect(instructions.get(core.state.settings().mainBotId!)).toContain('律师／法务');
  });

  it('支持当前全部职业分类，合并到主管系统指令并保留内置身份', async () => {
    let instructions = '';
    const { core, connection } = await setup(async context => {
      if (!context.binding.purpose) instructions = context.instructions;
      return { text: '完成' };
    });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
    await core.request('career.save', { professionIds: professions.map(item => item.id), status: 'completed' });
    await completeTurn(core, core.state.settings().mainConversationId!);
    expect(instructions).toContain(chiefInstructions);
    for (const profession of professions) expect(instructions).toContain(profession.name);
    expect(instructions).not.toContain('undefined');
  });
});
