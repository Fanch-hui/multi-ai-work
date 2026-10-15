import { describe, expect, it, vi } from 'vitest';
import type { ManagedProgress, RunContext } from '../src/domain/provider.js';
import { completeToolBatch } from '../src/providers/managed/loop-tools.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';

function deferred() {
  let resolve!: (result?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(names: string[]) {
  const controller = new AbortController();
  const saved: ManagedProgress[] = [];
  const context: RunContext = {
    runId: 'run', bot: {} as RunContext['bot'], connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: '', messages: [], instructions: '',
    tools: [...new Set(names)].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
    parallelToolNames: ['read_file'], signal: controller.signal, nativeMcp: { command: '', args: [], env: {} },
    emit: () => {}, executeTool: async () => ({}), getSecret: async () => undefined,
    saveSecret: async () => {}, persistBinding: () => {},
    saveProgress: async progress => { saved.push(structuredClone(progress)); },
  };
  const state = new ManagedRunState(context);
  state.messages.push({ role: 'assistant', content: '', toolCalls: names.map((name, index) => ({
    id: String(index), name, arguments: '{}',
  })) });
  return { context, controller, state, saved, executed: new Set<string | undefined>() };
}

const resultIds = (progress: Pick<ManagedProgress, 'messages'>) =>
  progress.messages.filter(message => message.role === 'tool').map(message => message.callId);

describe('managed parallel tool batches', () => {
  it('bounds concurrency, preserves sequential boundaries and orders out-of-order results', async () => {
    const { context, state, executed, saved } = fixture([...Array(6).fill('read_file'), 'write_file', 'read_file']);
    const gates = Array.from({ length: 8 }, deferred);
    const started: string[] = [];
    let active = 0; let peak = 0;
    context.executeTool = async (_name, _args, id) => {
      started.push(id); peak = Math.max(peak, ++active);
      await gates[Number(id)].promise; active--; return id;
    };
    const done = completeToolBatch(context, state, executed);
    expect(started).toEqual(['0', '1', '2', '3']);
    gates[2].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(resultIds(saved.at(-1)!)).toEqual(['2']);
    gates[0].resolve(); gates[1].resolve(); gates[3].resolve(); gates[4].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(6));
    expect(started).not.toContain('6');
    gates[5].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(7));
    expect(resultIds(saved.at(-1)!)).toEqual(['0', '1', '2', '3', '4', '5']);
    gates[6].resolve();
    await vi.waitFor(() => expect(started).toHaveLength(8));
    gates[7].resolve(); await done;
    expect(peak).toBe(4);
    expect(resultIds(state)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(saved.at(-1)?.phase).toBe('ready');
  });

  it('serializes checkpoint writes while independent tools finish together', async () => {
    const { context, state, executed } = fixture(Array(4).fill('read_file'));
    let saving = 0; let peak = 0;
    const snapshots: string[][] = [];
    context.saveProgress = async progress => {
      peak = Math.max(peak, ++saving);
      const before = resultIds(progress);
      await new Promise(resolve => setImmediate(resolve));
      expect(resultIds(progress)).toEqual(before);
      snapshots.push(before as string[]); saving--;
    };
    await completeToolBatch(context, state, executed);
    expect(peak).toBe(1);
    expect(snapshots.slice(0, 4).map(ids => ids.length)).toEqual([1, 2, 3, 4]);
  });

  it('waits for cancelled in-flight calls and saves their results without dispatching more', async () => {
    const { context, controller, state, executed, saved } = fixture(Array(6).fill('read_file'));
    const gates = Array.from({ length: 4 }, deferred);
    const started: string[] = [];
    context.executeTool = async (_name, _args, id) => { started.push(id); return gates[Number(id)].promise; };
    const done = completeToolBatch(context, state, executed);
    const rejection = expect(done).rejects.toThrow('cancelled');
    let finished = false;
    void done.then(() => { finished = true; }, () => { finished = true; });
    controller.abort(new Error('cancelled'));
    gates[0].resolve('first');
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(finished).toBe(false);
    gates.slice(1).forEach(gate => gate.resolve('remaining'));
    await rejection;
    expect(started).toEqual(['0', '1', '2', '3']);
    expect(resultIds(saved.at(-1)!)).toEqual(['0', '1', '2', '3']);
    expect(saved.at(-1)?.phase).toBe('tools');
  });

  it('preserves sibling results on failure and resumes only the missing calls', async () => {
    const { context, state, executed, saved } = fixture(Array(6).fill('read_file'));
    const gates = Array.from({ length: 4 }, deferred);
    const started: string[] = [];
    context.executeTool = async (_name, _args, id) => { started.push(id); return gates[Number(id)].promise; };
    const done = completeToolBatch(context, state, executed);
    const rejection = expect(done).rejects.toThrow('read failed');
    gates[0].reject(new Error('read failed'));
    await Promise.resolve(); await Promise.resolve();
    gates[2].resolve('two'); gates[1].resolve('one'); gates[3].resolve('three');
    await rejection;
    expect(started).toEqual(['0', '1', '2', '3']);
    expect(resultIds(saved.at(-1)!)).toEqual(['1', '2', '3']);
    context.progress = saved.at(-1)!;
    context.executeTool = async (_name, _args, id) => { started.push(id); return id; };
    const resumed = new ManagedRunState(context);
    await completeToolBatch(context, resumed, new Set(resultIds(resumed)));
    expect(started).toEqual(['0', '1', '2', '3', '0', '4', '5']);
    expect(resultIds(resumed)).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('stops dispatch after a checkpoint failure and waits for remaining successful reads', async () => {
    const { context, state, executed } = fixture(Array(6).fill('read_file'));
    const gates = Array.from({ length: 4 }, deferred);
    const started: string[] = [];
    context.executeTool = async (_name, _args, id) => { started.push(id); return gates[Number(id)].promise; };
    context.saveProgress = async () => { throw new Error('disk failed'); };
    const done = completeToolBatch(context, state, executed);
    const rejection = expect(done).rejects.toThrow('disk failed');
    gates[0].resolve('first');
    await vi.waitFor(() => expect(executed.has('0')).toBe(true));
    gates.slice(1).forEach(gate => gate.resolve('remaining'));
    await rejection;
    expect(started).toEqual(['0', '1', '2', '3']);
    expect(resultIds(state)).toEqual(['0', '1', '2', '3']);
  });
});
