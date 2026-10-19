import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { providerWebSocket, type ProviderSocket } from '../network.js';
import { InterruptedModelStreamError } from './request-errors.js';

export async function openResponsesSocket(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ProviderSocket> {
  signal.throwIfAborted();
  let socket: ProviderSocket;
  try {
    socket = providerWebSocket(url, headers);
  } catch {
    throw new InterruptedModelStreamError('模型 WebSocket 连接不可用');
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open);
        socket.removeEventListener('error', fail);
        socket.removeEventListener('close', fail);
      };
      const open = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new InterruptedModelStreamError('模型 WebSocket 连接失败'));
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timeout = setTimeout(fail, 10_000);
      socket.addEventListener('open', open);
      socket.addEventListener('error', fail);
      socket.addEventListener('close', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

export async function* socketResponse(
  socket: ProviderSocket,
  body: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<ResponseStreamEvent> {
  const queue: ResponseStreamEvent[] = [];
  let failure: unknown, wake: (() => void) | undefined;
  const fail = () => {
    failure = new InterruptedModelStreamError('模型 WebSocket 流已中断');
    wake?.();
  };
  const abort = () => {
    failure = signal.reason;
    wake?.();
  };
  const message = (event: Event) => {
    try {
      const value = JSON.parse(String((event as MessageEvent).data)) as ResponseStreamEvent;
      if (!value || typeof value.type !== 'string') throw new Error('invalid event');
      queue.push(value);
      wake?.();
    } catch {
      failure = new InterruptedModelStreamError('模型 WebSocket 事件格式无效');
      wake?.();
    }
  };
  socket.addEventListener('message', message);
  socket.addEventListener('error', fail);
  socket.addEventListener('close', fail);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    socket.send(JSON.stringify({ ...body, type: 'response.create' }));
    while (true) {
      while (queue.length) {
        signal.throwIfAborted();
        const event = queue.shift()!;
        if (event.type === 'error') {
          const value = event as unknown as {
            code?: string;
            error?: { code?: string };
            status?: number;
          };
          throw Object.assign(new Error('模型 WebSocket 请求失败'), {
            code: value.error?.code ?? value.code,
            status: value.status,
          });
        }
        yield event;
        if (
          event.type === 'response.completed' ||
          event.type === 'response.failed' ||
          event.type === 'response.incomplete'
        )
          return;
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    socket.removeEventListener('message', message);
    socket.removeEventListener('error', fail);
    socket.removeEventListener('close', fail);
    signal.removeEventListener('abort', abort);
  }
}
