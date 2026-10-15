import type OpenAI from 'openai';
import type { RunContext } from '../../domain/provider.js';
import type { Protocol } from '../../domain/types.js';
import { isContextOverflow, isSmallerProjection } from '../../runtime/context-overflow.js';
import { chatTurn } from './chat.js';
import type { ManagedRunState } from './progress.js';
import { responsesTurn } from './responses.js';
import { requestWithRetry } from './retry.js';
import { SupplementalInputError } from './request.js';

export async function requestManagedTurn(client: OpenAI, context: RunContext, protocol: Protocol, state: ManagedRunState,
  requestOptions: { retryDelays?: readonly number[]; nextStep(): number; recordDuration(durationMs: number): void; recovered: boolean }) {
  const request = () => {
    state.takeUserInput();
    return requestWithRetry(context, async attempt => {
      state.attempt = attempt;
      await state.save('request');
      context.signal.throwIfAborted();
      if (context.userInput?.hasPending() && !state.waitingForInput()) throw new SupplementalInputError();
      return (protocol === 'responses' ? responsesTurn : chatTurn)(client, context, state.messages);
    }, requestOptions.nextStep, requestOptions.recordDuration, requestOptions.retryDelays, async recovery => {
      context.emit({ type: 'text', data: { replace: state.text } });
      state.attempt = recovery.attempt;
      await state.save('ready', recovery);
    }, state.attempt);
  };
  try { return await request(); }
  catch (error) {
    if (!isContextOverflow(error)) throw error;
    if (requestOptions.recovered || !context.recoverContext) throw new Error('模型上下文超过窗口，无法继续本次运行', { cause: error });
    requestOptions.recovered = true;
    const current = state.messages.slice(state.currentStart);
    const projection = await context.recoverContext(state.messages);
    if (!projection || !isSmallerProjection(state.messages, projection) || projection.length < current.length
      || JSON.stringify(projection.slice(-current.length)) !== JSON.stringify(current)) {
      throw new Error('上下文恢复未缩小历史或未保留当前完整轮次，需要分割资料', { cause: error });
    }
    state.currentStart = projection.length - current.length;
    state.messages = projection;
    return request().catch(retryError => {
      if (isContextOverflow(retryError)) throw new Error('压缩恢复后仍超过模型上下文窗口，需要分割资料', { cause: retryError });
      throw retryError;
    });
  }
}
