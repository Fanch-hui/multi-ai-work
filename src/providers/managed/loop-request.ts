import type OpenAI from 'openai';
import type { RunContext } from '../../domain/provider.js';
import type { Protocol } from '../../domain/types.js';
import { isContextOverflow, isSmallerProjection } from '../../runtime/context-overflow.js';
import { chatTurn } from './chat.js';
import type { ManagedRunState } from './progress.js';
import { ConfirmedToolStreamError, EarlyResponseTools } from './early-tools.js';
import { responsesTurn, type Turn } from './responses.js';
import { isRecoverableStreamError } from './request-errors.js';
import { isTransientModelError, requestWithRetry } from './retry.js';
import { SupplementalInputError } from './request.js';
import type { createResponsesTransport } from './responses-transport.js';
import type { ResponsesCacheDiagnostics } from './cache-diagnostics.js';
import type { ChatReplayCompatibility } from './chat-replay-compatibility.js';

export async function requestManagedTurn(client: OpenAI, context: RunContext, protocol: Protocol, state: ManagedRunState,
  requestOptions: { retryDelays?: readonly number[]; nextStep(): number; recordDuration(durationMs: number): void; recovered: boolean;
    cacheDiagnostics?: ResponsesCacheDiagnostics; transport?: ReturnType<typeof createResponsesTransport>; chatReplay?: ChatReplayCompatibility }) {
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
  const requestOnce = () => {
    state.takeUserInput();
    let early: EarlyResponseTools | undefined;
    return requestWithRetry(context, async (_, requestId) => {
      if (protocol !== 'responses') return chatTurn(client, context, state.messages, requestId, requestOptions.chatReplay);
      early = new EarlyResponseTools(context, state);
      try { return await responsesTurn(client, context, state.messages, requestOptions.cacheDiagnostics, requestId,
        (index, item) => early!.accept(index, item), requestOptions.transport); }
      catch (error) {
        early.stop();
        if (early.assistantIndex !== undefined) throw new ConfirmedToolStreamError(error);
        throw error;
      }
    },
    requestOptions.nextStep, requestOptions.recordDuration, requestOptions.retryDelays, async recovery => {
      context.emit({ type: 'text', data: { replace: state.text } });
      state.attempt = recovery.attempt;
      await state.save('ready', recovery);
    }, state.attempt, async attempt => {
      state.attempt = attempt;
      const images = await context.prepareImageInputs?.(state.messages, { currentStart: state.currentStart });
      context.signal.throwIfAborted();
      if (images) await state.applyProjection(images, state.currentStart);
      await compact(false);
      await state.save('request');
      context.signal.throwIfAborted();
      if (context.userInput?.hasPending() && !state.waitingForInput()) throw new SupplementalInputError();
    }).then(async turn => {
      state.earlyFailures = 0;
      turn.persisted = await early?.finish(turn.message);
      return turn;
    }).catch(async error => {
      const recoverable = error instanceof ConfirmedToolStreamError
        && (isTransientModelError(error.streamError) || isRecoverableStreamError(error.streamError));
      if (recoverable) state.earlyFailures++;
      const persisted = await early?.finish();
      if (!(error instanceof ConfirmedToolStreamError) || !persisted) throw error;
      context.emit({ type: 'text', data: { replace: state.text } });
      context.signal.throwIfAborted();
      if (!recoverable || state.earlyFailures > 5) throw error.streamError;
      return { message: state.messages[early!.assistantIndex!], persisted: true } as Turn;
    });
  };
  let replayDowngraded = false;
  const request = async () => {
    try { return await requestOnce(); }
    catch (error) {
      if (protocol === 'responses' || replayDowngraded || !requestOptions.chatReplay?.reject(error, context, state.messages)) throw error;
      replayDowngraded = true;
      return requestOnce();
    }
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
