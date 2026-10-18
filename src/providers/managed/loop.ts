import type OpenAI from 'openai';
import type { ProviderResult, RunContext } from '../../domain/provider.js';
import type { Protocol, Usage } from '../../domain/types.js';
import { addUsage } from '../../domain/usage.js';
import { SupplementalInputError } from './request.js';
import { ManagedRunState } from './progress.js';
import { completeToolBatch } from './loop-tools.js';
import { requestManagedTurn } from './loop-request.js';
import { createResponsesTransport } from './responses-transport.js';
import { ResponsesCacheDiagnostics } from './cache-diagnostics.js';

export async function runManaged(client: OpenAI, context: RunContext, protocol: Protocol,
  retryDelays?: readonly number[]): Promise<ProviderResult> {
  const transport = protocol === 'responses' ? createResponsesTransport(client, context) : undefined;
  try {
    const state = new ManagedRunState(context);
    let usage: Usage | undefined;
    let modelDurationMs = 0;
    let requestStep = 0;
    const requestOptions = { transport, retryDelays, recovered: false, cacheDiagnostics: new ResponsesCacheDiagnostics(), nextStep: () => ++requestStep,
      recordDuration: (durationMs: number) => { modelDurationMs += durationMs; } };
    const result = (waiting = false): ProviderResult => ({ text: state.text, usage, messages: state.archiveMessages(), contextMessages: state.messages, modelDurationMs,
      ...(waiting ? { outcome: 'waiting_input' } : {}) });
    const executed = new Set(state.archiveMessages().filter(message => message.role === 'tool').map(message => message.callId));
    if (state.phase === 'tools' || state.phase === 'complete') await state.acknowledgeInput();
    if (state.phase === 'complete') return result();
    if (state.phase === 'tools') await completeToolBatch(context, state, executed);
    while (true) {
      context.signal.throwIfAborted();
      if (state.waitingForInput()) return result(true);
      state.takeUserInput();
      if (state.earlyFailures > 5) throw new Error('模型连接自动恢复次数已耗尽，请继续原任务');
      const turn = await requestManagedTurn(client, context, protocol, state, requestOptions).catch(error => {
        if (!(error instanceof SupplementalInputError)) throw error;
        usage = addUsage(usage, { source: 'unknown' });
        return undefined;
      });
      if (!turn) continue;
      if (!turn.persisted) {
        state.messages.push(turn.message);
        state.text += turn.message.content;
      }
      const calls = turn.message.toolCalls ?? [];
      await state.save(calls.length ? 'tools' : 'complete');
      await state.acknowledgeInput();
      usage = addUsage(usage, turn.usage ?? { source: 'unknown' });
      context.emit({ type: 'usage', data: { ...usage, scope: 'cumulative' } });
      if (calls.length) {
        await completeToolBatch(context, state, executed);
        continue;
      }
      if (state.waitingForInput()) return result(true);
      if (!state.takeUserInput()) return result();
    }
  } finally { transport?.close(); }
}
