import { describe, expect, it } from 'vitest';
import type { ManagedProgress, ModelMessage, RunContext } from '../src/domain/provider.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';
import { responsesInput } from '../src/providers/managed/messages.js';
import { runtimeContextMessage, updateProgressRuntimeContext, retainRuntimeContext, withoutRuntimeContext } from '../src/core/run-runtime-context.js';

const current = runtimeContextMessage({ source: 'test', name: '当前资料' });
const old = runtimeContextMessage({ source: 'test', name: '旧资料' });
const user: ModelMessage = { role: 'user', content: '用户最新要求' };
const call: ModelMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'read_file', arguments: '{}' },
  { id: 'two', name: 'list_directory', arguments: '{}' }] };
const first: ModelMessage = { role: 'tool', callId: 'one', content: '已读取' };

describe('运行资料在持久协议中的归属', () => {
  it('首次追加放在当前用户前，历史归档游标包含本轮的新资料', () => {
    const context = { runId: 'run', messages: [], runtimeContext: current, prompt: user.content } as unknown as RunContext;
    const state = new ManagedRunState(context);
    expect(state.messages).toEqual([current, user]);
    expect(state.currentStart).toBe(1);
    expect(state.archiveStart).toBe(0);
    expect(state.archiveMessages()).toEqual([current, user]);
    expect(responsesInput(state.messages)).toEqual([{ role: 'user', content: current.content }, { role: 'user', content: user.content }]);
  });

  it('恢复时资料插入用户前，不拆开待完成的工具配对，也不重复当前版本', () => {
    const progress: ManagedProgress = { messages: [old, user, call, first], currentStart: 1, archiveStart: 0,
      text: '', pendingInputIds: [], turnId: 'original', attempt: 0, phase: 'tools' };
    updateProgressRuntimeContext(progress, current);
    expect(progress.messages).toEqual([old, current, user, call, first]);
    expect(progress.currentStart).toBe(2);
    updateProgressRuntimeContext(progress, current);
    expect(progress.messages).toHaveLength(5);
    const state = new ManagedRunState({ progress } as unknown as RunContext);
    expect(state.archiveMessages()).toEqual(progress.messages);
    expect(state.messages.slice(-2)).toEqual([call, first]);
  });

  it('压缩恢复同时调整工作投影与原始协议游标，后续工具结果只归档一次', () => {
    const summary: ModelMessage = { role: 'assistant', content: '旧历史摘要', contextSummary: true };
    const history: ModelMessage = { role: 'assistant', content: '旧历史' };
    const progress: ManagedProgress = { messages: [summary, old, user, call, first], currentStart: 2, archiveStart: 1,
      compaction: { archived: [history, old, user, call], start: 4 },
      text: '', pendingInputIds: [], turnId: 'original', attempt: 0, phase: 'tools' };
    updateProgressRuntimeContext(progress, current);
    const state = new ManagedRunState({ progress } as unknown as RunContext);
    expect(state.archiveMessages()).toEqual([history, old, current, user, call, first]);
    expect(progress.messages.slice(-2)).toEqual([call, first]);
    expect(progress.compaction?.start).toBe(5);
    expect(progress.archiveStart).toBe(1);
  });

  it('撤销只清理明确的 App 资料，保留内容相同的用户文本', () => {
    const typedLikeText = { role: 'user' as const, content: old.content };
    expect(withoutRuntimeContext([old, typedLikeText, user])).toEqual([typedLikeText, user]);
    const projected = retainRuntimeContext([user, { role: 'assistant', content: '已完成摘要', contextSummary: true }], 0, current);
    expect(projected.messages[0]).toEqual(current);
    expect(projected.messages[1]).toEqual(user);
    expect(projected.currentStart).toBe(1);
  });
});
