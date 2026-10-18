import type { ProviderSocket } from '../../src/providers/network.js';
import type { ProviderSocketCommand, ProviderSocketEvent } from '../../src/providers/socket-proxy.js';

type SocketFactory = (url: string, headers: Record<string, string>) => ProviderSocket;

export function createProviderSocketHost(createSocket: SocketFactory, send: (message: ProviderSocketEvent) => void) {
  const sockets = new Map<string, { socket: ProviderSocket; cleanup: () => void }>();
  let closed = false;

  function emit(message: ProviderSocketEvent): void {
    try { send(message); } catch { shutdown(); }
  }

  function remove(id: string): void {
    const entry = sockets.get(id);
    if (!entry) return;
    sockets.delete(id);
    entry.cleanup();
    try { entry.socket.close(); } catch { /* The owning process may already be exiting. */ }
  }

  function fail(id: string): void {
    remove(id);
    emit({ type: 'provider-socket', id, event: 'error', message: '模型 WebSocket 连接失败' });
    emit({ type: 'provider-socket', id, event: 'close' });
  }

  function open(message: Extract<ProviderSocketCommand, { command: 'open' }>): void {
    if (closed || sockets.has(message.id)) return;
    try {
      const socket = createSocket(message.url, message.headers);
      const onOpen = () => emit({ type: 'provider-socket', id: message.id, event: 'open' });
      const onMessage = (event: Event) => {
        const data: unknown = (event as MessageEvent).data;
        if (typeof data === 'string') emit({ type: 'provider-socket', id: message.id, event: 'message', data });
        else fail(message.id);
      };
      const onError = () => fail(message.id);
      const onClose = () => { remove(message.id); emit({ type: 'provider-socket', id: message.id, event: 'close' }); };
      const listeners = { open: onOpen, message: onMessage, error: onError, close: onClose };
      sockets.set(message.id, { socket, cleanup: () => {
        for (const [event, listener] of Object.entries(listeners)) socket.removeEventListener(event, listener);
      } });
      for (const [event, listener] of Object.entries(listeners)) socket.addEventListener(event, listener);
    } catch { fail(message.id); }
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    for (const id of sockets.keys()) {
      remove(id);
      try { send({ type: 'provider-socket', id, event: 'close' }); } catch { /* IPC may already be closed. */ }
    }
  }

  return {
    receive(message: unknown): boolean {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'provider-socket') return false;
      const value = message as ProviderSocketCommand;
      if (typeof value.id !== 'string' || !['open', 'send', 'close'].includes(value.command)) return false;
      if (value.command === 'open') {
        if (typeof value.url !== 'string' || !value.headers || typeof value.headers !== 'object'
          || !Object.values(value.headers).every(header => typeof header === 'string')) return false;
        if (closed) emit({ type: 'provider-socket', id: value.id, event: 'close' });
        else open(value);
      } else if (value.command === 'close') {
        remove(value.id);
        emit({ type: 'provider-socket', id: value.id, event: 'close' });
      } else if (typeof value.data === 'string') {
        try { sockets.get(value.id)?.socket.send(value.data); } catch { fail(value.id); }
      } else return false;
      return true;
    },
    close: shutdown,
  };
}
