import type { RunContext } from '../../domain/provider.js';
import { toolResultMessage } from '../images.js';
import { parseToolArguments } from './messages.js';
import type { ManagedRunState } from './progress.js';

export async function completeToolBatch(context: RunContext, state: ManagedRunState, executed: Set<string | undefined>) {
  let assistantIndex = state.messages.length - 1;
  while (assistantIndex >= 0 && state.messages[assistantIndex].role !== 'assistant') assistantIndex--;
  const calls = state.messages[assistantIndex]?.toolCalls ?? [];
  const completed = new Set(state.messages.slice(assistantIndex + 1).filter(message => message.role === 'tool').map(message => message.callId));
  const seen = new Set<string>();
  const pending = calls.flatMap(call => {
    if (seen.has(call.id)) throw new Error('模型重复提交工具调用，需要对账');
    seen.add(call.id);
    if (completed.has(call.id)) return [];
    if (executed.has(call.id)) throw new Error('模型重复提交工具调用，需要对账');
    if (!context.tools.some(tool => tool.name === call.name)) throw new Error(`模型请求未开放的工具：${call.name}`);
    return [{ ...call, args: parseToolArguments(call.arguments) }];
  });
  const parallel = new Set(context.parallelToolNames);
  const order = new Map(calls.map((call, index) => [call.id, index]));
  const saveResult = async (call: typeof pending[number], result: unknown) => {
    const index = state.messages.findIndex((message, index) => index > assistantIndex && message.role === 'tool'
      && (order.get(message.callId!) ?? Infinity) > order.get(call.id)!);
    state.messages.splice(index < 0 ? state.messages.length : index, 0, toolResultMessage(call.id, result));
    executed.add(call.id);
    await state.save('tools');
    context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'completed' } });
  };
  for (let start = 0; start < pending.length;) {
    let end = start + 1;
    if (parallel.has(pending[start].name)) {
      while (end < pending.length && parallel.has(pending[end].name)) end++;
    }
    await executeGroup(context, state, pending.slice(start, end), saveResult);
    start = end;
  }
  state.nextTurn();
  const projection = await context.prepareToolResults?.(state.messages, assistantIndex + 1);
  if (projection) await state.applyProjection(projection, state.currentStart);
  else await state.save('ready');
}

async function executeGroup<T extends { id: string; name: string; args: Record<string, unknown> }>(
  context: RunContext, state: ManagedRunState, calls: T[], saveResult: (call: T, result: unknown) => Promise<void>,
) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  let saving = Promise.resolve();
  const worker = async () => {
    while (!failure && next < calls.length) {
      try {
        context.signal.throwIfAborted();
        const call = calls[next++];
        context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'started' } });
        const result = state.waitingForInput() ? { error: '本轮正在等待用户回答，此调用未执行' }
          : await context.executeTool(call.name, call.args, call.id);
        // Persist every successful in-flight result, even after a sibling fails or is cancelled.
        const save = saving.then(() => saveResult(call, result));
        saving = save.catch(error => { failure ??= { error }; });
        await save;
      } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, calls.length) }, worker));
  if (failure) throw failure.error;
  context.signal.throwIfAborted();
}
