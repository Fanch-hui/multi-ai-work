import { describe, expect, it } from 'vitest';
import type { ContextCheckpoint, Message, SessionBinding } from '../src/domain/types.js';
import { ContextManager, type CompactionRecord } from '../src/runtime/context.js';
import { estimateTokens, modelMessageHistory, type ModelHistoryEntry } from '../src/runtime/model-history.js';

const binding: SessionBinding = { id: 'binding', botId: 'a', conversationId: 'room', connectionId: 'c', generation: 1, configRevision: 1, connectionRevision: 1, workspaceId: 'w', lastDeliveredSequence: 0 };

function message(sequence: number, content: string, authorType: Message['authorType'] = 'user'): Message {
  return { id: `m${sequence}`, conversationId: 'room', sequence, authorType, authorBotId: authorType === 'bot' ? 'a' : undefined, content, artifactIds: [], status: 'committed', createdAt: '2026-10-11T00:00:00Z' };
}

function setup() {
  let saved: ContextCheckpoint | undefined;
  const records: CompactionRecord[] = [];
  return {
    manager: new ContextManager({ getCheckpoint: () => saved, saveCheckpoint: checkpoint => { saved = checkpoint; }, recordCompaction: record => records.push(record) }),
    checkpoint: () => saved,
    records,
  };
}

const baseInput = { binding, instructions: '使用中文', tools: [], contextWindow: 3000, force: true, signal: new AbortController().signal };

describe('ContextManager', () => {
  it('使用指定触发比例，提前压缩并保留最新请求', async () => {
    const messages = [message(1, '旧资料'.repeat(150)), message(2, '新请求')];
    const later = setup(), earlier = setup();
    const input = { ...baseInput, force: false, messages, contextWindow: 3000, summarize: async () => '已整理旧资料' };
    const original = await later.manager.prepare({ ...input, triggerTokens: 2700 });
    expect(later.records).toEqual([]);
    const compacted = await earlier.manager.prepare({ ...input, triggerTokens: 600 });
    expect(earlier.records.at(-1)?.status).toBe('completed');
    expect(compacted.estimatedTokens).toBeLessThan(original.estimatedTokens);
    expect(compacted.messages.at(-1)?.content).toBe('新请求');
  });
  it('压缩完整旧轮次并保留最新请求和真实工具配对', async () => {
    const { manager, checkpoint } = setup();
    const messages = [message(1, '旧资料'.repeat(300)), message(2, '继续调查', 'bot'), message(3, '最新请求：交付文档')];
    const history: ModelHistoryEntry[] = [
      { sequence: 1, messageId: 'm1', message: { role: 'user', content: messages[0].content } },
      { sequence: 2, messageId: 'm2', message: { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', arguments: '{}' }] } },
      { sequence: 2, messageId: 'm2', message: { role: 'tool', callId: 'call', content: '原始结果'.repeat(200), providerItems: [{ type: 'function_call_output', call_id: 'call', output: 'original' }] } },
      { sequence: 3, messageId: 'm3', message: { role: 'user', content: messages[2].content } },
    ];
    let summaryPrompt = '';
    const prepared = await manager.prepare({ ...baseInput, messages, history, summarize: async prompt => { summaryPrompt = prompt; return '调查已完成，需交付文档。'; } });
    expect(prepared.messages.at(-1)?.content).toBe('最新请求：交付文档');
    expect(prepared.messages).toHaveLength(2);
    expect(summaryPrompt).toContain('function_call_output');
    expect(checkpoint()?.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(checkpoint()?.throughSequence).toBe(2);
    expect(messages).toHaveLength(3);
  });

  it('摘要失败或源资料过期时保留原上下文', async () => {
    const { manager, checkpoint } = setup();
    const messages = [message(1, '旧内容'.repeat(500)), message(2, '最新目标')];
    const failed = await manager.prepare({ ...baseInput, messages, summarize: async () => { throw new Error('network'); } });
    expect(failed.messages).toEqual(modelMessageHistory(messages, 'a').map(entry => entry.message));
    const stale = await manager.prepare({ ...baseInput, messages, summarize: async () => '短摘要', isSourceCurrent: () => false });
    expect(stale.messages).toEqual(failed.messages);
    expect(checkpoint()).toBeUndefined();
  });

  it('记忆指令变化后旧检查点失效，旧资料可重新整理', async () => {
    const { manager } = setup();
    const messages = [message(1, '旧内容'.repeat(500)), message(2, '最新目标')];
    await manager.prepare({ ...baseInput, messages, summarize: async () => '含旧记忆的摘要' });
    const reused = await manager.prepare({ ...baseInput, force: false, messages, summarize: async () => { throw new Error('不应再次整理'); } });
    expect(reused.messages[0].content).toContain('含旧记忆的摘要');
    let prompt = '';
    const updated = await manager.prepare({ ...baseInput, messages, instructions: '新记忆', summarize: async text => { prompt = text; return '新摘要'; } });
    expect(prompt).not.toContain('含旧记忆的摘要');
    expect(updated.messages[0].content).toContain('新摘要');
  });

  it('不压缩未配对的工具调用，也不丢弃最新轮次', async () => {
    const { manager, checkpoint } = setup();
    const messages = [message(1, '旧内容'.repeat(500)), message(2, '新内容')];
    const history = modelMessageHistory(messages);
    history.splice(1, 0, { sequence: 1, messageId: 'm1', message: { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'write_file', arguments: '{}' }] } });
    let summarized = false;
    const prepared = await manager.prepare({ ...baseInput, messages, history, summarize: async () => { summarized = true; return '摘要'; } });
    expect(summarized).toBe(false);
    expect(prepared.messages).toHaveLength(3);
    expect(checkpoint()).toBeUndefined();
  });

  it('多轮资料分批摘要，每次输入均在小窗口预算内', async () => {
    const { manager, checkpoint, records } = setup();
    const messages = [message(1, '第一轮'.repeat(150)), message(2, '第二轮'.repeat(150)), message(3, '第三轮'.repeat(150)), message(4, '最新目标')];
    const prompts: string[] = [];
    const prepared = await manager.prepare({ ...baseInput, contextWindow: 1200, messages,
      summarize: async prompt => { prompts.push(prompt); return `已整理 ${prompts.length} 批`; } });
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every(prompt => estimateTokens(prompt) <= 1200 * 0.75 - 256)).toBe(true);
    expect(prepared.messages.at(-1)?.content).toBe('最新目标');
    expect(checkpoint()?.throughSequence).toBeGreaterThanOrEqual(2);
    expect(records.map(record => record.status)).toEqual(['started', 'completed']);
    expect(records[1].sourceHash).toBe(records[0].sourceHash);
  });

  it('分批失败保留旧检查点，记录失败与源版本；超大轮次不调用摘要', async () => {
    const { manager, checkpoint, records } = setup();
    const first = [message(1, '旧内容'.repeat(100)), message(2, '目标')];
    await manager.prepare({ ...baseInput, messages: first, summarize: async () => '旧摘要' });
    const old = checkpoint();
    const next = [...first, message(3, '后续资料'.repeat(500)), message(4, '交付')];
    let calls = 0;
    const prepared = await manager.prepare({ ...baseInput, messages: next,
      summarize: async () => { calls++; throw new Error('network'); } });
    expect(checkpoint()).toBe(old);
    expect(prepared.messages[0].content).toContain('旧摘要');
    expect(calls).toBe(0);
    expect(records.at(-1)).toMatchObject({ status: 'failed', reason: 'needs_split', generation: 1 });
    const failing = [...first, message(3, '后续资料'.repeat(100)), message(4, '补充资料'.repeat(100)), message(5, '其他资料'.repeat(100)), message(6, '交付')];
    let batches = 0;
    await manager.prepare({ ...baseInput, contextWindow: 1200, messages: failing,
      summarize: async () => { if (++batches === 2) throw new Error('network'); return '第一批摘要'; } });
    expect(batches).toBe(2);
    expect(checkpoint()).toBe(old);
    expect(records.at(-1)).toMatchObject({ status: 'failed', reason: 'summary_failed' });
  });
});
