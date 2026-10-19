import { randomUUID } from 'node:crypto';
import type { ProviderSocket } from './network.js';

export type ProviderSocketCommand = { type: 'provider-socket'; id: string } & (
  | { command: 'open'; url: string; headers: Record<string, string> }
  | { command: 'send'; data: string }
  | { command: 'close' }
);
export type ProviderSocketEvent = { type: 'provider-socket'; id: string } & (
  | { event: 'open' | 'close' }
  | { event: 'message'; data: string }
  | { event: 'error'; message: string }
);

class ProxySocket extends EventTarget {
  readyState: 0 | 1 | 2 | 3 = 0;

  constructor(
    readonly id: string,
    private readonly transmit: (message: ProviderSocketCommand) => void,
  ) {
    super();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error('模型 WebSocket 尚未连接');
    if (typeof data !== 'string') throw new Error('模型 WebSocket 仅支持文本帧');
    try {
      this.transmit({ type: 'provider-socket', id: this.id, command: 'send', data });
    } catch {
      throw new Error('模型 WebSocket 消息发送失败');
    }
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try {
      this.transmit({ type: 'provider-socket', id: this.id, command: 'close' });
    } catch {
      this.receive({ type: 'provider-socket', id: this.id, event: 'close' });
    }
  }

  receive(message: ProviderSocketEvent): void {
    if (this.readyState === 3) return;
    if (message.event === 'open') {
      if (this.readyState !== 0) return;
      this.readyState = 1;
    } else if (message.event === 'close') this.readyState = 3;
    else if (message.event === 'message') {
      if (this.readyState === 1)
        this.dispatchEvent(new MessageEvent('message', { data: message.data }));
      return;
    }
    this.dispatchEvent(new Event(message.event));
  }
}

export function createProviderSocketProxy(send: (message: ProviderSocketCommand) => void) {
  const sockets = new Map<string, ProxySocket>();
  let closed = false;
  return {
    create(url: string, headers: Record<string, string>): ProviderSocket {
      if (closed) throw new Error('模型 WebSocket 通道已关闭');
      const socket = new ProxySocket(randomUUID(), send);
      sockets.set(socket.id, socket);
      queueMicrotask(() => {
        if (socket.readyState !== 0) return;
        try {
          send({ type: 'provider-socket', id: socket.id, command: 'open', url, headers });
        } catch {
          socket.receive({
            type: 'provider-socket',
            id: socket.id,
            event: 'error',
            message: '模型 WebSocket 连接失败',
          });
          socket.receive({ type: 'provider-socket', id: socket.id, event: 'close' });
          sockets.delete(socket.id);
        }
      });
      return socket;
    },
    receive(message: unknown): boolean {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'provider-socket'
      )
        return false;
      const value = message as ProviderSocketEvent;
      if (
        typeof value.id !== 'string' ||
        !['open', 'message', 'error', 'close'].includes(value.event)
      )
        return false;
      if (value.event === 'message' && typeof value.data !== 'string') return false;
      sockets.get(value.id)?.receive(value);
      if (value.event === 'close') sockets.delete(value.id);
      return true;
    },
    close(): void {
      closed = true;
      for (const socket of sockets.values()) {
        socket.close();
        socket.receive({ type: 'provider-socket', id: socket.id, event: 'close' });
      }
      sockets.clear();
    },
  };
}
