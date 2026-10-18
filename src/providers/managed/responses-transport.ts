import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { RunContext } from '../../domain/provider.js';
import { authorizeOAuth } from './oauth-client.js';
import { openResponsesSocket, socketResponse } from './responses-socket.js';
import { InterruptedModelStreamError } from './request-errors.js';
import { resetResponsesSession, type ResponsesSession, type ResponsesSessionPool } from './responses-session-pool.js';

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
const fingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function fullBody(body: ResponseCreateParamsStreaming): Record<string, unknown> {
  const { stream: _stream, background: _background, previous_response_id: _previous, ...rest } = body;
  return { ...rest, store: false };
}
function modelOutput(event: ResponseStreamEvent): boolean {
  return !['response.created', 'response.in_progress', 'response.queued'].includes(event.type);
}
function settingsFingerprint(body: Record<string, unknown>): string {
  const { input: _input, prompt_cache_options: cacheOptions, ...settings } = body;
  const { comparison_response_id: _comparison, ...cache } = (cacheOptions ?? {}) as Record<string, unknown>;
  return fingerprint({ ...settings, ...(Object.keys(cache).length ? { prompt_cache_options: cache } : {}) });
}

export function createResponsesTransport(client: OpenAI, context: RunContext, pool?: ResponsesSessionPool) {
  const endpoint = new URL(`${client.baseURL.replace(/\/$/, '')}/responses`);
  const eligible = endpoint.origin === 'https://api.openai.com' && endpoint.pathname === '/v1/responses';
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = fingerprint([endpoint.toString(), context.connection.id, context.connection.revision,
    context.binding.id, context.binding.generation, context.binding.accountScope]);
  const session: ResponsesSession = pool?.acquire(key) ?? {};
  let disabled = !eligible, busy = false, closed = false;
  let pending: { id: string; settings: string; items: string[] } | undefined;
  const reset = () => { pending = undefined; resetResponsesSession(session); };
  const confirm = (output: unknown[]) => {
    if (pending && !closed && !session.closed && !context.signal.aborted) {
      session.previous = { ...pending, items: [...pending.items, ...output.map(fingerprint)] };
      pending = undefined;
    }
  };

  async function connect(signal: AbortSignal) {
    const token = context.connection.provider === 'chatgpt' ? await authorizeOAuth(context, undefined, signal) : client.apiKey;
    signal.throwIfAborted();
    if (closed || session.closed) throw new Error('模型传输已关闭');
    const current = fingerprint([context.connection.id, context.binding.id, context.binding.generation, context.binding.accountScope, token]);
    if (session.identity !== current || session.socket?.readyState !== 1) reset();
    if (!session.socket) {
      session.socket = await openResponsesSocket(endpoint.toString(), { authorization: `Bearer ${token}`, 'session-id': context.binding.id }, signal);
      if (closed || session.closed) { reset(); throw new Error('模型传输已关闭'); }
      session.identity = current;
    }
    return session.socket;
  }

  async function* streamBody(body: ResponseCreateParamsStreaming, signal: AbortSignal): AsyncGenerator<ResponseStreamEvent> {
    if (closed || session.closed) throw new Error('模型传输已关闭');
    if (busy) throw new Error('同一模型传输不能同时发送多个请求');
    if (pending) reset();
    busy = true;
    let completed = false, observed = false;
    try {
      if (!disabled) {
        try {
          const active = await connect(signal), full = fullBody(body);
          const signature = settingsFingerprint(full), items = Array.isArray(full.input) ? full.input : undefined;
          const hashes = items?.map(fingerprint);
          const previous = session.previous;
          const continuation = hashes && previous?.settings === signature && hashes.length >= previous.items.length
            && previous.items.every((item, index) => item === hashes[index]);
          let request = continuation ? { ...full, previous_response_id: previous!.id, input: items!.slice(previous!.items.length) } : full;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const initialEvents: ResponseStreamEvent[] = [];
              for await (const event of socketResponse(active, request, signal)) {
                if (modelOutput(event)) observed = true;
                if (!observed) { initialEvents.push(event); continue; }
                for (const initial of initialEvents.splice(0)) yield initial;
                if (event.type === 'response.completed' && event.response.status === 'completed') {
                  completed = true;
                  pending = hashes ? { id: event.response.id, settings: signature, items: hashes } : undefined;
                }
                yield event;
              }
              return;
            } catch (error) {
              if (!observed && attempt === 0 && 'previous_response_id' in request && (error as { code?: string }).code === 'previous_response_not_found') {
                session.previous = undefined; request = full; continue;
              }
              throw error;
            }
          }
        } catch (error) {
          reset();
          if (signal.aborted || observed || closed || !(error instanceof InterruptedModelStreamError)) throw error;
          disabled = true;
        }
      }
      const { previous_response_id: _previous, ...httpBody } = body;
      const http = await client.responses.create({ ...httpBody, stream: true, store: false }, { signal });
      for await (const event of http) yield event;
      completed = true;
    } finally { if (!completed) reset(); busy = false; }
  }
  return { stream: async (body: ResponseCreateParamsStreaming, signal: AbortSignal): Promise<AsyncIterable<ResponseStreamEvent>> => streamBody(body, signal),
    reset, confirm, close: () => {
      if (closed) return;
      closed = true;
      if (!pool || pending || busy || context.signal.aborted) reset();
      pool?.release(key, session);
    } };
}
