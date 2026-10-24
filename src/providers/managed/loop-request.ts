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
import {
  appendReasoningUpdate,
  knownReasoningEffort,
  officialResponsesEndpoint,
  reasoningBaseline,
  selectedReasoningEffort,
} from './reasoning-effort.js';

interface ManagedRequestOptions {
  retryDelays?: readonly number[];
  nextStep(): number;
  recordDuration(durationMs: number): void;
  recovered: boolean;
  cacheDiagnostics?: ResponsesCacheDiagnostics;
  transport?: ReturnType<typeof createResponsesTransport>;
  chatReplay?: ChatReplayCompatibility;
}

export async function requestManagedTurn(
  client: OpenAI,
  context: RunContext,
  protocol: Protocol,
  state: ManagedRunState,
  options: ManagedRequestOptions,
) {
  let replayDowngraded = false;
  const request = async () => {
    try {
      return await requestTurnAttempt(client, context, protocol, state, options);
    } catch (error) {
      if (
        protocol === 'responses' ||
        replayDowngraded ||
        !options.chatReplay?.reject(error, context, state.messages)
      )
        throw error;
      replayDowngraded = true;
      return requestTurnAttempt(client, context, protocol, state, options);
    }
  };
  try {
    const turn = await request();
    options.recovered = false;
    return turn;
  } catch (error) {
    context.signal.throwIfAborted();
    if (!isContextOverflow(error)) throw error;
    if (options.recovered || !context.compactContext) {
      throw new Error('模型上下文超过窗口，无法继续本次运行', { cause: error });
    }
    options.recovered = true;
    const changed = await compactRunContext(context, state, protocol, true);
    if (!changed) {
      throw new Error('上下文恢复未缩小历史或未保留当前完整轮次，需要分割资料', { cause: error });
    }
    try {
      const turn = await request();
      options.recovered = false;
      return turn;
    } catch (retryError) {
      if (isContextOverflow(retryError)) {
        throw new Error('压缩恢复后仍超过模型上下文窗口，需要分割资料', { cause: retryError });
      }
      throw retryError;
    }
  }
}

async function requestTurnAttempt(
  client: OpenAI,
  context: RunContext,
  protocol: Protocol,
  state: ManagedRunState,
  options: ManagedRequestOptions,
): Promise<Turn> {
  state.takeUserInput();
  let early: EarlyResponseTools | undefined;
  let requestContext = context;
  let reasoningUpdates = false;
  try {
    const turn = await requestWithRetry(
      context,
      async (_, requestId) => {
        if (protocol !== 'responses') {
          return chatTurn(client, requestContext, state.messages, requestId, options.chatReplay);
        }
        early = new EarlyResponseTools(context, state);
        try {
          return await responsesTurn(
            client,
            requestContext,
            state.messages,
            options.cacheDiagnostics,
            requestId,
            (index, item) => early!.accept(index, item),
            options.transport,
            reasoningUpdates,
          );
        } catch (error) {
          early.stop();
          if (early.assistantIndex !== undefined) throw new ConfirmedToolStreamError(error);
          throw error;
        }
      },
      options.nextStep,
      options.recordDuration,
      options.retryDelays,
      async (recovery) => {
        context.emit({ type: 'text', data: { replace: state.text } });
        state.setAttempt(recovery.attempt);
        await state.save('ready', recovery);
      },
      state.attempt,
      async (attempt) => {
        const prepared = await prepareRequest(client, context, state, protocol, attempt);
        requestContext = prepared.context;
        reasoningUpdates = prepared.reasoningUpdates;
      },
    );
    state.resetEarlyFailures();
    turn.persisted = await early?.finish(turn.message);
    return turn;
  } catch (error) {
    const recoverable =
      error instanceof ConfirmedToolStreamError &&
      (isTransientModelError(error.streamError) || isRecoverableStreamError(error.streamError));
    if (recoverable) state.recordEarlyFailure();
    const persisted = await early?.finish();
    if (!(error instanceof ConfirmedToolStreamError) || !persisted) throw error;
    context.emit({ type: 'text', data: { replace: state.text } });
    context.signal.throwIfAborted();
    if (!recoverable || state.earlyFailures > 5) throw error.streamError;
    return { message: state.messages[early!.assistantIndex!], persisted: true };
  }
}

async function prepareRequest(
  client: OpenAI,
  context: RunContext,
  state: ManagedRunState,
  protocol: Protocol,
  attempt: number,
): Promise<{ context: RunContext; reasoningUpdates: boolean }> {
  state.setAttempt(attempt);
  const images = await context.prepareImageInputs?.(state.messages, {
    currentStart: state.currentStart,
  });
  context.signal.throwIfAborted();
  if (images) await state.applyProjection(images, state.currentStart);
  await compactRunContext(context, state, protocol, false);
  const bot = { ...context.bot };
  let reasoningUpdates = false;
  if (protocol === 'responses') {
    const model = context.connection.models?.find((item) => item.id === context.bot.model);
    // SIWC rejects configuration items even when the supplemented model catalog supports them.
    const supportsUpdates =
      context.connection.provider !== 'chatgpt' &&
      model?.supportsReasoningEffortUpdates === true &&
      model.reasoning?.length !== 0 &&
      officialResponsesEndpoint(client.baseURL);
    const selected = selectedReasoningEffort(context);
    const knownSelected = knownReasoningEffort(selected);
    const defaultEffort = knownReasoningEffort(model?.defaultReasoningEffort);
    if (supportsUpdates && (knownSelected || (selected === undefined && defaultEffort))) {
      const effort = knownSelected ?? defaultEffort!;
      const baseline = reasoningBaseline(state.messages) ?? knownSelected ?? defaultEffort!;
      appendReasoningUpdate(state.messages, baseline, effort);
      bot.reasoning = baseline;
      reasoningUpdates = true;
    } else {
      bot.reasoning = selected;
    }
  } else {
    bot.reasoning = selectedReasoningEffort(context);
  }
  await state.save('request');
  context.signal.throwIfAborted();
  if (context.userInput?.hasPending() && !state.waitingForInput())
    throw new SupplementalInputError();
  return { context: { ...context, bot }, reasoningUpdates };
}

async function compactRunContext(
  context: RunContext,
  state: ManagedRunState,
  protocol: Protocol,
  force: boolean,
) {
  context.signal.throwIfAborted();
  const projection = await context.compactContext?.(state.messages, {
    force,
    currentStart: state.currentStart,
  });
  context.signal.throwIfAborted();
  if (!projection) return false;
  if (!isSmallerProjection(state.messages, projection.messages, state.currentStart, protocol)) {
    throw new Error('上下文压缩未缩小历史或未保留用户输入与完整工具配对');
  }
  const messages = projection.messages.filter((message) => !message.reasoningUpdate);
  const removedBeforeCurrent = projection.messages
    .slice(0, projection.currentStart)
    .filter((message) => message.reasoningUpdate).length;
  await state.applyProjection(messages, projection.currentStart - removedBeforeCurrent);
  return true;
}
