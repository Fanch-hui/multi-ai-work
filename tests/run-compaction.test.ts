import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';
import { isSmallerProjection } from '../src/runtime/context-overflow.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';
import type { RunContext, ManagedProgress } from '../src/domain/provider.js';

const exchange = (id: string, text = '材料'.repeat(1800)): ModelMessage[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: '{}' }] },
  { role: 'tool', callId: id, content: text },
];
const options = { currentStart: 0, force: false, budget: 9000, trigger: 6500, fixedTokens: 100,
  protocol: 'responses' as const, signal: new AbortController().signal,
  summarize: async () => '已读取早期材料，保留工作结论。' };

describe('compaction inside a long tool conversation', () => {
  it('replaces completed early exchanges while keeping every user requirement and newest tool result', async () => {
    const original: ModelMessage[] = [{ role: 'user', content: '制作报告' }, ...exchange('one'), ...exchange('two'),
      { role: 'user', content: '改为中文版', sourceMessageId: 'correction' }, ...exchange('three')];
    const projected = await compactRunMessages(original, options);
    expect(projected).toBeDefined();
    expect(projected!.messages.filter(message => message.role === 'user')).toEqual(original.filter(message => message.role === 'user'));
    expect(projected!.messages.slice(-2)).toEqual(exchange('three'));
    expect(projected!.messages.some(message => message.callId === 'one')).toBe(false);
    expect(isSmallerProjection(original, projected!.messages, 0)).toBe(true);
    expect(projected!.currentStart).toBe(0);
  });

  it('keeps pending tool calls and the most recent complete exchange byte for byte', async () => {
    const original: ModelMessage[] = [{ role: 'user', content: '继续' }, ...exchange('one'), ...exchange('two'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'write_file', arguments: '{"path":"report"}' }] }];
    const projected = await compactRunMessages(original, { ...options, trigger: 5000 });
    expect(projected).toBeDefined();
    expect(projected!.messages.slice(-3)).toEqual(original.slice(-3));
    expect(original.some(message => message.contextSummary)).toBe(false);
  });

  it('can summarize old tool reminders while preserving the actual user request and runtime context', async () => {
    const runtime: ModelMessage = { role: 'user', content: '当前资料', appContext: { source: 'app.runtime', version: '1' } };
    const reminder: ModelMessage = { role: 'user', content: '工具重复提醒', appContext: { source: 'app.repeat-tool-reminder', version: 'v1:one' } };
    const original: ModelMessage[] = [{ role: 'user', content: '继续完成报告' }, runtime,
      ...exchange('one'), reminder, ...exchange('two'), ...exchange('three')];
    const projected = await compactRunMessages(original, options);
    expect(projected).toBeDefined();
    expect(projected!.messages).toContainEqual(runtime);
    expect(projected!.messages).not.toContainEqual(reminder);
    expect(projected!.messages[0]).toEqual(original[0]);
    expect(isSmallerProjection(original, projected!.messages, 0)).toBe(true);
  });

  it('summarizes a single huge latest result only with an authorized full-output reference', async () => {
    const original: ModelMessage[] = [{ role: 'user', content: '分析完整结果' }, ...exchange('huge', '完整工具正文'.repeat(4000))];
    expect(await compactRunMessages(original, options)).toBeUndefined();
    let preserved = '';
    const projected = await compactRunMessages(original, { ...options, preserveToolOutput: async message => {
      preserved = message.content;
      return { text: 'read_artifact({"artifactId":"full-output"})', artifactIds: ['full-output'] };
    } });
    expect(preserved).toBe(original[2].content);
    expect(projected!.messages[1]).toEqual(original[1]);
    expect(projected!.messages[2]).toMatchObject({ role: 'tool', callId: 'huge', contextArtifactIds: ['full-output'] });
    expect(projected!.messages[2].content).toContain('read_artifact');
    expect(isSmallerProjection(original, projected!.messages, 0)).toBe(true);
  });

  it('declines a summary that still cannot fit instead of publishing a partial replacement', async () => {
    const original: ModelMessage[] = [{ role: 'user', content: '必须保留'.repeat(2000) }, ...exchange('one'), ...exchange('two')];
    expect(await compactRunMessages(original, { ...options, trigger: 100 })).toBeUndefined();
  });

  it('persists the exact raw protocol prefix and resumes the projection with ordered new results', async () => {
    let saved!: ManagedProgress;
    const context = { runId: 'run', messages: [], prompt: '做报告', signal: new AbortController().signal,
      saveProgress: async (progress: ManagedProgress) => { saved = structuredClone(progress); } } as unknown as RunContext;
    const state = new ManagedRunState(context);
    state.messages.push(...exchange('one'));
    const raw = structuredClone(state.messages);
    await state.applyProjection([state.messages[0], { role: 'assistant', content: '早期结论', contextSummary: true }], 0);
    expect(saved.compaction?.archived).toEqual(raw);
    const restored = new ManagedRunState({ ...context, progress: saved });
    const [assistant, result] = exchange('two', 'second');
    restored.messages.push(assistant, result);
    await restored.save('tools');
    expect(restored.archiveMessages()).toEqual([...raw, assistant, result]);
    expect(saved.messages).toHaveLength(4);
    expect(saved.compaction?.start).toBe(2);
  });
});
