import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import { summarizeUnits } from '../src/runtime/context-summary.js';
import { balancedHistoryUnits, estimateModelMessageTokens, estimateTokens, summaryMessageProjection, toolsPaired } from '../src/runtime/model-history.js';

const signal = new AbortController().signal;
const entries = (messages: ModelMessage[]) => messages.map((message, index) => ({ sequence: 1, messageId: `m${index}`, message }));

describe('managed history semantic projection', () => {
  it('retains the source of App context and reminders in summary material', () => {
    const projected = summaryMessageProjection({ role: 'user', content: '工具重复提醒',
      appContext: { source: 'app.repeat-tool-reminder', version: 'v1:call' } });
    expect(projected).toMatchObject({ source: 'app.repeat-tool-reminder', version: 'v1:call', content: '工具重复提醒' });
    expect(summaryMessageProjection({ role: 'user', content: '实际用户要求' })).not.toHaveProperty('source');
  });
  it('estimates the selected protocol once, excluding source metadata and ciphertext length', () => {
    const message: ModelMessage = { role: 'assistant', content: 'readable result'.repeat(100),
      providerItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'actual wire text' }] },
        { type: 'reasoning', encrypted_content: 'encrypted'.repeat(10000) }] };
    const original = structuredClone(message);
    const estimate = estimateModelMessageTokens(message);
    expect(estimateModelMessageTokens({ ...message, content: 'duplicate'.repeat(10000), sourceMessageId: 'metadata'.repeat(1000) })).toBe(estimate);
    expect(estimateModelMessageTokens({ ...message, providerItems: [...message.providerItems!.slice(0, 1), { type: 'reasoning', encrypted_content: 'short' }] })).toBe(estimate);
    expect(estimateModelMessageTokens(message, 'chat-completions')).toBeGreaterThan(estimate);
    expect(estimate).toBeGreaterThan(64);
    expect(message).toEqual(original);
  });

  it('summarizes readable content and tool arguments once, retaining image references', () => {
    const message: ModelMessage = { role: 'assistant', content: 'unique semantic result', toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"path":"report.md"}' }],
      providerItems: [{ type: 'reasoning', encrypted_content: 'secret ciphertext' },
        { type: 'message', content: [{ type: 'output_text', text: 'unique semantic result' }] }],
      images: [{ artifactId: 'authorized-image', mimeType: 'image/png' }] };
    const text = JSON.stringify(summaryMessageProjection(message));
    expect(text.match(/unique semantic result/g)).toHaveLength(1);
    expect(text).toContain('report.md');
    expect(text).toContain('authorized-image');
    expect(text).not.toContain('ciphertext');
    expect(summaryMessageProjection({ role: 'tool', callId: 'c', content: '', providerItems: [{ type: 'function_call_output', output: 'fallback output' }] })).toMatchObject({ content: 'fallback output' });
  });

  it('budgets Chat replay text once and keeps its binding metadata out of the estimate', () => {
    const message: ModelMessage = { role: 'assistant', content: 'answer', chatReplay: { version: 1, bindingId: 'binding', generation: 1,
      reasoningField: 'reasoning_content', reasoningText: 'intermediate reasoning '.repeat(100) } };
    const estimate = estimateModelMessageTokens(message, 'chat-completions');
    expect(estimate).toBeGreaterThan(estimateModelMessageTokens({ ...message, chatReplay: undefined }, 'chat-completions'));
    expect(estimateModelMessageTokens({ ...message, chatReplay: { ...message.chatReplay!, bindingId: 'id'.repeat(500) } }, 'chat-completions')).toBe(estimate);
    expect(estimateModelMessageTokens(message, 'responses')).toBe(estimateModelMessageTokens({ ...message, chatReplay: undefined }, 'responses'));
    const semantic = JSON.stringify(summaryMessageProjection(message));
    expect(semantic).toContain('answer');
    expect(semantic).not.toContain('intermediate reasoning');
  });

  it('budgets structured Chat replay instead of its duplicate text and reserves opaque overhead', () => {
    const message: ModelMessage = { role: 'assistant', content: 'answer', chatReplay: { version: 1, bindingId: 'binding', generation: 1,
      reasoningField: 'reasoning', reasoningText: 'duplicate'.repeat(1000), reasoningDetails: [
        { type: 'reasoning.text', text: 'structured text'.repeat(100), index: 0 },
        { type: 'reasoning.encrypted', data: 'opaque'.repeat(20000), index: 1 },
      ] } };
    const estimate = estimateModelMessageTokens(message, 'chat-completions');
    const next = structuredClone(message);
    next.chatReplay!.reasoningText = 'other duplicate';
    next.chatReplay!.reasoningDetails![1] = { type: 'reasoning.encrypted', data: 'short', index: 1 };
    expect(estimateModelMessageTokens(next, 'chat-completions')).toBe(estimate);
    next.chatReplay!.reasoningDetails![0] = { type: 'reasoning.text', text: 'short', index: 0 };
    expect(estimateModelMessageTokens(next, 'chat-completions')).toBeLessThan(estimate);
    expect(JSON.stringify(summaryMessageProjection(message))).not.toMatch(/structured text|opaque|duplicate/);
  });

  it('splits a long user turn only at completed exchanges', async () => {
    const history = entries([
      { role: 'user', content: 'investigate' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', callId: 'b', content: 'result b' },
      { role: 'tool', callId: 'a', content: 'result a' },
      { role: 'assistant', content: 'finished' },
    ]);
    const units = balancedHistoryUnits(history);
    expect(units.map(unit => unit.length)).toEqual([1, 3, 1]);
    expect(units.every(toolsPaired)).toBe(true);
    const prompts: string[] = [];
    await summarizeUnits(history, '', 3000, async prompt => { prompts.push(prompt); return 'completed investigation'; }, signal);
    expect(prompts.join('\n')).toContain('result b');
    expect(prompts.join('\n')).toContain('result a');
  });

  it('feeds every character of an oversized result through contiguous framed fragments', async () => {
    const content = '开始🙂' + '中间完整资料'.repeat(500) + '最后🙂';
    const history = entries([{ role: 'user', content }]);
    const fragments: string[] = [];
    await summarizeUnits(history, '', 1400, async prompt => {
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(1400 * 0.75 - 256);
      const data = prompt.split('待合并历史：\n')[1];
      expect(data).toContain('连续片段');
      fragments.push(data.slice(data.indexOf('\n') + 1));
      return '资料已合并';
    }, signal);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.join('')).toBe(JSON.stringify(history.map(entry => summaryMessageProjection(entry.message))));
  });

  it('rejects unfinished tools, empty or oversized summaries and cancellation', async () => {
    const history = entries([{ role: 'user', content: 'history' }]);
    await expect(summarizeUnits(history, '', 3000, async () => '', signal)).rejects.toThrow('为空');
    await expect(summarizeUnits(history, '', 3000, async () => '资料'.repeat(500), signal)).rejects.toThrow('超过');
    const pending = entries([{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'write_file', arguments: '{}' }] }]);
    await expect(summarizeUnits(pending, '', 3000, async () => 'summary', signal)).rejects.toThrow('未配对');
    const controller = new AbortController();
    await expect(summarizeUnits(history, '', 3000, async () => { controller.abort(); return 'summary'; }, controller.signal)).rejects.toThrow();
  });
});
