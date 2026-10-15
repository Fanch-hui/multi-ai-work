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
  for (const call of pending) {
    context.signal.throwIfAborted();
    context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'started' } });
    const result = state.waitingForInput() ? { error: '本轮正在等待用户回答，此调用未执行' }
      : await context.executeTool(call.name, call.args, call.id);
    state.messages.push(toolResultMessage(call.id, result));
    executed.add(call.id);
    await state.save('tools');
    context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'completed' } });
  }
  state.nextTurn();
  await state.save('ready');
}
