import { describe, expect, it } from 'vitest';
import type { ManagedProgress, ModelMessage, RunContext } from '../src/domain/provider.js';
import { repeatToolReminders } from '../src/runtime/repeat-tool-reminder.js';
import { completeToolBatch } from '../src/providers/managed/loop-tools.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';

function exchange(id: string, name = 'read_file', args = '{"path":"a.txt"}'): ModelMessage[] {
  return [{ role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] },
    { role: 'tool', callId: id, content: '{"text":"same content"}' }];
}
const ledger = (count: number): ModelMessage[] => Array.from({ length: count }, (_, index) => exchange(String(index + 1))).flat();
const ids = (messages: ModelMessage[]) => messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []);
const notices = (messages: ModelMessage[]) => messages.filter(message => message.appContext?.source === 'app.repeat-tool-reminder');

describe('repeat tool reminders', () => {
  it('emits only at consecutive thresholds 3, 5 and 8 without changing original results', () => {
    const messages = ledger(9);
    const original = structuredClone(messages);
    const reminders = repeatToolReminders(messages, ids(messages));
    expect(reminders.map(message => message.appContext?.version)).toEqual(['v1:3', 'v1:5', 'v1:8']);
    expect(reminders[0].content).toContain('连续 3 次');
    expect(messages).toEqual(original);
  });

  it('canonicalizes nested object keys and preserves array order', () => {
    const messages = [
      ...exchange('1', 'search_text', '{"options":{"b":2,"a":1},"paths":["x","y"]}'),
      ...exchange('2', 'search_text', '{"paths":["x","y"],"options":{"a":1,"b":2}}'),
      ...exchange('3', 'search_text', '{"options":{"a":1,"b":2},"paths":["x","y"]}'),
    ];
    expect(repeatToolReminders(messages, ['3'])).toHaveLength(1);
    messages.push(...exchange('4', 'search_text', '{"options":{"a":1,"b":2},"paths":["y","x"]}'));
    expect(repeatToolReminders(messages, ['4'])).toEqual([]);
  });

  it('treats normal polling as transparent and resets for distinct parameters', () => {
    const messages = [...exchange('1'), ...exchange('poll1', 'get_task'), ...exchange('2'),
      ...exchange('poll2', 'read_process'), ...exchange('3')];
    expect(repeatToolReminders(messages, ['3'])).toHaveLength(1);
    messages.push(...exchange('4', 'read_file', '{"path":"b.txt"}'), ...exchange('5'));
    expect(repeatToolReminders(messages, ['5'])).toEqual([]);
  });

  it('resets for actual new user input while app contexts and reminders preserve the streak', () => {
    const messages = ledger(3);
    messages.push(...repeatToolReminders(messages, ['3']),
      { role: 'user', content: '更新资料', appContext: { source: 'app.runtime', version: '2' } }, ...exchange('4'), ...exchange('5'));
    expect(repeatToolReminders(messages, ['5'])).toHaveLength(1);
    messages.push({ role: 'user', content: '请重新检查这个文件' }, ...exchange('6'));
    expect(repeatToolReminders(messages, ['6'])).toEqual([]);
  });

  it('ignores duplicate restored IDs and never emits historical or unfinished calls', () => {
    const messages = [...ledger(2), ...exchange('2')];
    expect(repeatToolReminders(messages, ['2'])).toEqual([]);
    messages.push(exchange('3')[0]);
    expect(repeatToolReminders(messages, ['3'])).toEqual([]);
    messages.push(exchange('3')[1]);
    expect(repeatToolReminders(messages, ['not-current'])).toEqual([]);
    const reminder = repeatToolReminders(messages, ['3']);
    messages.push(...reminder);
    expect(repeatToolReminders(messages, ['3'])).toEqual([]);
  });

  it('uses assistant call order rather than parallel completion order', () => {
    const calls = [exchange('1')[0], exchange('other', 'list_directory')[0], ...ledger(3).filter(message => message.role === 'assistant')]
      .flatMap(message => message.toolCalls ?? []).map((call, index) => ({ ...call, id: `ordered:${index}` }));
    const messages: ModelMessage[] = [{ role: 'assistant', content: '', toolCalls: calls },
      ...[...calls].reverse().map(call => ({ role: 'tool' as const, callId: call.id, content: '{}' }))];
    expect(repeatToolReminders(messages, calls.map(call => call.id)).map(message => message.appContext?.version))
      .toEqual(['v1:ordered:4']);
  });

  it('detects 2-step alternating loops at 3, 5 and 8 cycles and deduplicates same cycle', () => {
    const alternating = (cycles: number): ModelMessage[] =>
      Array.from({ length: cycles }, (_, index) => [
        ...exchange(`a-${index + 1}`, 'read_file', '{"path":"a.txt"}'),
        ...exchange(`b-${index + 1}`, 'search_text', '{"query":"foo"}'),
      ]).flat();

    const messages = alternating(9);
    const reminders = repeatToolReminders(messages, ids(messages));
    expect(reminders).toHaveLength(3);
    expect(reminders.map(message => message.appContext?.version)).toEqual([
      'v2:cycle:["read_file",{"path":"a.txt"}]->["search_text",{"query":"foo"}]:3',
      'v2:cycle:["read_file",{"path":"a.txt"}]->["search_text",{"query":"foo"}]:5',
      'v2:cycle:["read_file",{"path":"a.txt"}]->["search_text",{"query":"foo"}]:8',
    ]);
    expect(reminders[0].content).toContain('两步工具交替循环调用');
    expect(reminders[0].content).toContain('3 个周期');
    expect(reminders[1].content).toContain('5 个周期');
    expect(reminders[2].content).toContain('8 个周期');

    messages.push(...reminders);
    expect(repeatToolReminders(messages, ids(messages))).toEqual([]);
  });

  it('terminates 2-step alternating count when tool or arguments change', () => {
    const messages = [
      ...exchange('1', 'read_file', '{"path":"a.txt"}'),
      ...exchange('2', 'read_file', '{"path":"b.txt"}'),
      ...exchange('3', 'read_file', '{"path":"a.txt"}'),
      ...exchange('4', 'read_file', '{"path":"b.txt"}'),
      ...exchange('5', 'read_file', '{"path":"c.txt"}'),
      ...exchange('6', 'read_file', '{"path":"d.txt"}'),
    ];
    expect(repeatToolReminders(messages, ids(messages))).toEqual([]);

    messages.push(
      ...exchange('7', 'read_file', '{"path":"c.txt"}'),
      ...exchange('8', 'read_file', '{"path":"d.txt"}'),
      ...exchange('9', 'read_file', '{"path":"c.txt"}'),
      ...exchange('10', 'read_file', '{"path":"d.txt"}'),
    );
    const reminders = repeatToolReminders(messages, ['9', '10']);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].appContext?.version).toBe(
      'v2:cycle:["read_file",{"path":"c.txt"}]->["read_file",{"path":"d.txt"}]:3',
    );
  });
});

describe('managed reminder persistence', () => {
  function fixture() {
    const saved: ManagedProgress[] = [];
    const context: RunContext = {
      runId: 'run', bot: {} as RunContext['bot'], connection: {} as RunContext['connection'],
      binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: '检查文件', messages: ledger(8), instructions: '',
      tools: [{ name: 'read_file', description: '', inputSchema: {} }], parallelToolNames: ['read_file'],
      signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
      executeTool: async () => ({}), getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
      saveProgress: async progress => { saved.push(structuredClone(progress)); },
    };
    return { context, saved };
  }

  it('scopes to this run and saves the advisory with all actual paired results', async () => {
    const { context, saved } = fixture();
    const state = new ManagedRunState(context);
    state.messages.push(...ledger(2), exchange('3')[0]);
    await completeToolBatch(context, state, new Set(['1', '2']));
    expect(notices(state.messages)).toHaveLength(1);
    expect(saved.at(-1)?.phase).toBe('ready');
    expect(notices(saved.at(-1)!.messages)).toHaveLength(1);
    context.progress = saved.at(-1);
    const resumed = new ManagedRunState(context);
    resumed.messages.push(exchange('4')[0]);
    await completeToolBatch(context, resumed, new Set(['1', '2', '3']));
    expect(notices(resumed.archiveMessages().slice(resumed.archiveStart))).toHaveLength(1);
  });

  it('keeps original call accounting and advisory when result projection is saved', async () => {
    const { context, saved } = fixture();
    context.messages = [];
    context.prepareToolResults = async messages => messages.map(message => message.role === 'tool'
      ? { ...message, content: '缩短的结果' } : message);
    const state = new ManagedRunState(context);
    state.messages.push(...ledger(2), exchange('3')[0]);
    await completeToolBatch(context, state, new Set(['1', '2']));
    expect(notices(state.archiveMessages())).toHaveLength(1);
    expect(notices(saved.at(-1)!.messages)).toHaveLength(1);
    expect(state.archiveMessages().find(message => message.callId === '1')?.content).toContain('same content');
    expect(state.messages.find(message => message.callId === '1')?.content).toBe('缩短的结果');
  });

  it('reconstructs a missing reminder after a completed batch checkpoint without rerunning tools', async () => {
    const { context, saved } = fixture();
    context.messages = [];
    context.executeTool = async () => { throw new Error('saved tool must not execute again'); };
    const state = new ManagedRunState(context);
    state.messages.push(...ledger(3));
    await state.save('tools');
    context.progress = saved.at(-1);
    const resumed = new ManagedRunState(context);
    await completeToolBatch(context, resumed, new Set(['1', '2', '3']));
    expect(notices(saved.at(-1)!.messages)).toHaveLength(1);
    context.progress = saved.at(-1);
    const restored = new ManagedRunState(context);
    expect(repeatToolReminders(restored.archiveMessages().slice(restored.archiveStart), ['3'])).toEqual([]);
  });
});
