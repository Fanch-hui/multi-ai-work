import { describe, expect, it } from 'vitest';
import type { Bot, Conversation } from '../src/domain/types.js';
import { isReasoningSupported, reasoningConfiguration } from '../src/domain/model-reasoning.js';
import { setup } from './core-harness.js';

describe('reasoning configuration', () => {
  it('uses declared levels first and offers editable fallback only for undeclared custom models', () => {
    const declared = { id: 'model', name: '模型', reasoning: ['vendor-fast', 'vendor-deep'] };
    expect(reasoningConfiguration('custom', declared)).toEqual({ options: declared.reasoning, fallback: false });
    expect(isReasoningSupported('custom', declared, 'high')).toBe(false);
    expect(reasoningConfiguration('custom', { ...declared, reasoning: [] })).toEqual({ options: [], fallback: false });
    expect(isReasoningSupported('custom', { ...declared, reasoning: [] }, 'vendor-deep')).toBe(false);
    expect(reasoningConfiguration('custom')).toMatchObject({ fallback: true, options: expect.arrayContaining(['low', 'medium', 'high']) });
    expect(isReasoningSupported('custom', undefined, 'vendor-level')).toBe(true);
    expect(isReasoningSupported('chatgpt', undefined, 'high')).toBe(false);
  });

  it('persists custom fallback input through onboarding and conversation settings while enforcing advertised levels', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const initial = await core.request('onboarding.complete', { input: { name: '管家', connectionId: connection.id,
      model: 'test', reasoning: 'vendor-level', workspaceId: core.state.snapshot().workspaces[0].id } }) as Conversation;
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    expect(chief.reasoning).toBe('vendor-level');
    expect(initial.reasoning).toBe('vendor-level');
    const room = core.team.createChiefConversation();
    expect(room.reasoning).toBe('vendor-level');
    expect(core.team.updateChiefConversation(room.id, { reasoning: ' high ' }).reasoning).toBe('high');

    for (const reasoning of [['vendor-only'], []]) {
      core.state.storage.put('connections', { ...connection, status: 'ready', models: [{ id: 'test', name: '模型', reasoning }] });
      expect(() => core.entities.saveBot({ ...chief, reasoning: 'high' })).toThrow('不支持此推理强度');
      expect(() => core.team.updateChiefConversation(room.id, { reasoning: 'high' })).toThrow('不支持此推理强度');
      expect(core.team.updateChiefConversation(room.id, { reasoning: '' }).reasoning).toBeUndefined();
    }
  });
});
