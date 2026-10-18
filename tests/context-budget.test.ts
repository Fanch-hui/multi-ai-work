import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/core/storage.js';
import { ContextManager, type ContextInput } from '../src/runtime/context.js';
import type { ContextCheckpoint, Message } from '../src/domain/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'context-budget-'));
  const storage = new Storage(join(dir, 'state.db'));
  cleanups.push(() => { storage.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const manager = new ContextManager({
    getCheckpoint: bindingId => storage.byField<ContextCheckpoint>('context_checkpoints', 'bindingId', bindingId).at(-1),
    saveCheckpoint: checkpoint => storage.put('context_checkpoints', checkpoint),
    recordCompaction: record => storage.put('compactions', record),
  });
  const input: ContextInput = {
    binding: { id: 'binding-a', botId: 'a', conversationId: 'room', connectionId: 'c', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'w', lastDeliveredSequence: 0 },
    messages: [], instructions: '中文', tools: [], contextWindow: 2000, triggerTokens: 950,
    force: true, signal: new AbortController().signal, summarize: async () => '完成旧工作。',
  };
  return { storage, manager, input };
}
function message(sequence: number, content: string): Message {
  return { id: `m${sequence}`, conversationId: 'room', sequence, content, authorType: 'user',
    artifactIds: [], status: 'committed', createdAt: '2026-10-16' };
}

describe('完整上下文预算与检查点兼容性', () => {
  it('摘要变短但请求仍超预算时不替换有效检查点', async () => {
    const { manager, storage, input } = fixture();
    input.messages = [message(1, '旧'.repeat(500)), message(2, '最新')];
    await manager.prepare(input);
    const saved = storage.all<ContextCheckpoint>('context_checkpoints');
    input.messages.push(message(3, '大'.repeat(1000)));
    const result = await manager.prepare(input);
    expect(storage.all('context_checkpoints')).toEqual(saved);
    expect(result.messages.at(-1)?.content).toBe('大'.repeat(1000));
    expect(storage.all<{ reason?: string }>('compactions').at(-1)?.reason).toBe('over_budget');
  });

  it('首次摘要预算不足时有限扩展旧历史并保存准确来源', async () => {
    const { manager, storage, input } = fixture();
    input.force = false;
    input.messages = [message(1, '旧'.repeat(500)), message(2, '中'.repeat(250)), message(3, '新'.repeat(150))];
    let calls = 0;
    input.summarize = async () => ++calls === 1 ? '摘'.repeat(300) : '完成前两轮；保留最新要求。';
    const result = await manager.prepare(input);
    expect(calls).toBe(2);
    expect(result.estimatedTokens).toBeLessThan(input.triggerTokens!);
    expect(storage.all<ContextCheckpoint>('context_checkpoints')[0]).toMatchObject({ throughSequence: 2, sourceMessageIds: ['m1', 'm2'] });
    expect(result.messages.at(-1)?.content).toBe('新'.repeat(150));
  });

  it('改名复用检查点，语义指令撤销与绑定变化不复用', async () => {
    const { manager, storage, input } = fixture();
    input.messages = [message(1, '旧'.repeat(500)), message(2, '新')];
    input.contextInstructions = '身份 a；有效记忆';
    await manager.prepare(input);
    input.force = false;
    input.instructions = '新显示名';
    let loads = 0;
    input.loadArchiveHistory = () => { loads++; return undefined; };
    const reused = await manager.prepare(input);
    expect(reused.checkpoint).toBeDefined();
    expect(loads).toBe(0);
    input.contextInstructions = '身份 a';
    const invalid = await manager.prepare(input);
    expect(invalid.checkpoint).toBeUndefined();
    expect(loads).toBe(1);
    input.binding = { ...input.binding, id: 'binding-b', botId: 'b' };
    expect((await manager.prepare(input)).checkpoint).toBeUndefined();
    expect(storage.all('context_checkpoints')).toHaveLength(1);
  });

  it('可见消息检查点不截断同一序号内的协议条目', async () => {
    const { manager, storage, input } = fixture();
    input.messages = [message(1, '旧'.repeat(500))];
    input.history = [
      { messageId: 'm1', sequence: 1, message: { role: 'user', content: '旧'.repeat(500) } },
      { messageId: 'm1', sequence: 1, message: { role: 'user', content: '同序号内尚需保留的协议输入' } },
    ];
    const result = await manager.prepare(input);
    expect(result.messages).toEqual(input.history.map(entry => ({ ...entry.message,
      sourceMessageId: entry.messageId, sourceSequence: entry.sequence })));
    expect(storage.all('context_checkpoints')).toEqual([]);
  });

  it('有效运行投影直接复用，不再叠加它已经包含的旧摘要', async () => {
    const { manager, input } = fixture();
    input.messages = [message(1, '旧'.repeat(500)), message(2, '新')];
    await manager.prepare(input);
    const projection = { role: 'assistant' as const, content: '包含旧检查点的运行摘要', contextSummary: true };
    const current = { role: 'user' as const, content: '后续输入' };
    input.history = [{ messageId: 'm1', sequence: 1, message: projection }, { messageId: 'm2', sequence: 2, message: current }];
    input.historyIsCurrent = true;
    input.force = false;
    input.loadArchiveHistory = () => { throw new Error('有效投影不应重读档案'); };
    const prepared = await manager.prepare(input);
    expect(prepared.messages).toEqual([
      { ...projection, sourceMessageId: 'm1', sourceSequence: 1 },
      { ...current, sourceMessageId: 'm2', sourceSequence: 2 },
    ]);
  });
});
