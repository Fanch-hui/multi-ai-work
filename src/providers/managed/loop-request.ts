import type OpenAI from 'openai';
import type { RunContext } from '../../domain/provider.js';
import type { Protocol } from '../../domain/types.js';
import { isContextOverflow, isSmallerProjection } from '../../runtime/context-overflow.js';
import { chatTurn } from './chat.js';
import type { ManagedRunState } from './progress.js';
import { responsesTurn } from './responses.js';
import { requestWithRetry } from './retry.js';
import { SupplementalInputError } from './request.js';
import type { ResponsesCacheDiagnostics } from './cache-diagnostics.js';

export async function requestManagedTurn(client: OpenAI, context: RunContext, protocol: Protocol, state: ManagedRunState,
  requestOptions: { retryDelays?: readonly number[]; nextStep(): number; recordDuration(durationMs: number): void; recovered: boolean;
    cacheDiagnostics?: ResponsesCacheDiagnostics }) {
  const compact = async (force: boolean) => {
    context.signal.throwIfAborted();
    const projection = await context.compactContext?.(state.messages, { force, currentStart: state.currentStart });
    context.signal.throwIfAborted();
    if (!projection) return false;
    if (!isSmallerProjection(state.messages, projection.messages, state.currentStart, protocol))
      throw new Error('上下文压缩未缩小历史或未保留用户输入与完整工具配对');
    await state.applyProjection(projection.messages, projection.currentStart);
    return true;
  };
  const request = () => {
    state.takeUserInput();
    return requestWithRetry(context, (_, requestId) => protocol === 'responses'
        ? responsesTurn(client, context, state.messages, requestOptions.cacheDiagnostics, requestId)
        : chatTurn(client, context, state.messages),
    requestOptions.nextStep, requestOptions.recordDuration, requestOptions.retryDelays, async recovery => {
      context.emit({ type: 'text', data: { replace: state.text } });
      state.attempt = recovery.attempt;
      await state.save('ready', recovery);
    }, state.attempt, async attempt => {
      state.attempt = attempt;
      await compact(false);
      await state.save('request');
      context.signal.throwIfAborted();
      if (context.userInput?.hasPending() && !state.waitingForInput()) throw new SupplementalInputError();
    });
  };
  try { const turn = await request(); requestOptions.recovered = false; return turn; }
  catch (error) {
    context.signal.throwIfAborted();
    if (!isContextOverflow(error)) throw error;
    if (requestOptions.recovered || !context.compactContext && !context.recoverContext)
      throw new Error('模型上下文超过窗口，无法继续本次运行', { cause: error });
    requestOptions.recovered = true;
    let changed = await compact(true);
    if (!changed && !context.compactContext && context.recoverContext) {
      const current = state.messages.slice(state.currentStart);
      const projection = await context.recoverContext(state.messages);
      if (projection && isSmallerProjection(state.messages, projection, undefined, protocol) && projection.length >= current.length
        && JSON.stringify(projection.slice(-current.length)) === JSON.stringify(current)) {
        await state.applyProjection(projection, projection.length - current.length);
        changed = true;
      }
    }
    if (!changed) throw new Error('上下文恢复未缩小历史或未保留当前完整轮次，需要分割资料', { cause: error });
    return request().then(result => { requestOptions.recovered = false; return result; }).catch(retryError => {
      if (isContextOverflow(retryError)) throw new Error('压缩恢复后仍超过模型上下文窗口，需要分割资料', { cause: retryError });
      throw retryError;
    });
  }
}
