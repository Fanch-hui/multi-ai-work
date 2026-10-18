import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderSocketHost } from '../apps/desktop/provider-sockets.js';
import { createProviderSocketProxy, type ProviderSocketEvent } from '../src/providers/socket-proxy.js';
import type { ProviderSocket } from '../src/providers/network.js';

let server: Server, websocket: WebSocketServer, address: string;
let host: ReturnType<typeof createProviderSocketHost>, proxy: ReturnType<typeof createProviderSocketProxy>;
let events: ProviderSocketEvent[], headers: string[];

function event(socket: ProviderSocket, type: string): Promise<Event> {
  return new Promise(resolve => socket.addEventListener(type, resolve, { once: true }));
}

beforeEach(async () => {
  events = []; headers = [];
  server = createServer(); websocket = new WebSocketServer({ server });
  websocket.on('connection', (socket, request) => {
    headers.push(request.headers['session-id'] as string);
    socket.on('message', raw => socket.send(String(raw)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  address = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  host = createProviderSocketHost((url, requestHeaders) => {
    const socket = new WebSocket(url, { headers: requestHeaders, followRedirects: false });
    socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  }, message => { events.push(message); queueMicrotask(() => proxy.receive(message)); });
  proxy = createProviderSocketProxy(message => { queueMicrotask(() => host.receive(message)); });
});

afterEach(async () => {
  proxy.close(); host.close();
  for (const socket of websocket.clients) socket.terminate();
  await new Promise<void>(resolve => websocket.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('desktop provider socket proxy', () => {
  it('passes text frames and request headers while keeping sockets isolated', async () => {
    const first = proxy.create(address, { 'session-id': 'first' });
    const second = proxy.create(address, { 'session-id': 'second' });
    expect(first.readyState).toBe(0);
    await Promise.all([event(first, 'open'), event(second, 'open')]);
    expect(first.readyState).toBe(1);
    const removed = vi.fn(); first.addEventListener('message', removed); first.removeEventListener('message', removed);
    const firstMessage = event(first, 'message'), secondMessage = event(second, 'message');
    first.send('alpha'); second.send('beta');
    expect((await firstMessage as MessageEvent).data).toBe('alpha');
    expect((await secondMessage as MessageEvent).data).toBe('beta');
    expect(removed).not.toHaveBeenCalled();
    expect(headers.sort()).toEqual(['first', 'second']);
    const closed = event(first, 'close'); first.close();
    expect(first.readyState).toBe(2);
    await closed;
    expect(first.readyState).toBe(3); expect(second.readyState).toBe(1);
    expect(() => first.send('later')).toThrow('尚未连接');
  });

  it('cancels a pending open and closes all sockets when the host stops', async () => {
    const pending = proxy.create(address, {}), canceled = event(pending, 'close');
    pending.close(); await canceled;
    expect(pending.readyState).toBe(3); expect(headers).toEqual([]);
    const active = proxy.create(address, {}); await event(active, 'open');
    const closed = event(active, 'close'); host.close(); await closed;
    expect(active.readyState).toBe(3);
    const refused = proxy.create(address, {}), refusedClose = event(refused, 'close');
    await refusedClose; expect(refused.readyState).toBe(3);
  });

  it('forwards safe error events and releases a failed socket', async () => {
    const failedHost = createProviderSocketHost(() => { throw new Error('fixture-private-value'); }, message => {
      events.push(message); queueMicrotask(() => proxy.receive(message));
    });
    proxy.close();
    proxy = createProviderSocketProxy(message => { queueMicrotask(() => failedHost.receive(message)); });
    const socket = proxy.create(address, {}), failed = event(socket, 'error'), closed = event(socket, 'close');
    await failed; await closed;
    expect(socket.readyState).toBe(3);
    expect(events.filter(value => value.event === 'error')).toEqual([
      expect.objectContaining({ message: '模型 WebSocket 连接失败' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('fixture-private-value');
    expect(host.receive({ type: 'other' })).toBe(false);
    expect(proxy.receive({ type: 'provider-socket', id: 'unknown', command: 'open' })).toBe(false);
    failedHost.close();
  });

  it('closes active proxy sockets and removes their host connections', async () => {
    const socket = proxy.create(address, {}); await event(socket, 'open');
    const peer = [...websocket.clients][0], peerClosed = once(peer, 'close');
    const listener = vi.fn(); socket.addEventListener('close', listener);
    proxy.close(); await peerClosed;
    expect(socket.readyState).toBe(3); expect(listener).toHaveBeenCalledOnce();
    expect(() => proxy.create(address, {})).toThrow('通道已关闭');
  });
});
