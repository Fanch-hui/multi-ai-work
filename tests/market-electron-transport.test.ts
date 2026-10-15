import { EventEmitter } from 'node:events';
import type { ClientRequest, ClientRequestConstructorOptions, Net } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import { createElectronMarketFetch } from '../src/core/market/electron-transport.js';
import { configureMarketFetch, fetchMarketBytes } from '../src/core/market/network.js';

class RequestFixture extends EventEmitter {
  aborted = false;
  constructor(readonly start: (request: RequestFixture) => void) { super(); }
  end() { queueMicrotask(() => this.start(this)); }
  abort() { this.aborted = true; this.emit('abort'); this.emit('close'); }
}

function transport(start: (request: RequestFixture, options: ClientRequestConstructorOptions) => void) {
  const requests: RequestFixture[] = [];
  const options: ClientRequestConstructorOptions[] = [];
  const net: Pick<Net, 'request'> = { request(value) {
    const config = value as ClientRequestConstructorOptions;
    const request = new RequestFixture(item => start(item, config));
    requests.push(request); options.push(config);
    return request as unknown as ClientRequest;
  } };
  configureMarketFetch(createElectronMarketFetch(net));
  return { requests, options };
}

function respond(request: RequestFixture, statusCode = 200) {
  const incoming = Object.assign(new EventEmitter(), { statusCode, headers: {} });
  request.emit('response', incoming);
  return incoming;
}
afterEach(() => configureMarketFetch((input, init) => fetch(input, init)));

describe('Electron market transport', () => {
  it('turns manual redirect events into validated independent downloads', async () => {
    const { requests, options } = transport((request, config) => {
      request.emit('close');
      if (config.url === 'https://market.test/catalog.json') {
        request.emit('redirect', 302, 'GET', 'https://assets.test/catalog.json', {});
        request.emit('error', new Error('Redirect was cancelled'));
      } else {
        const incoming = respond(request);
        incoming.emit('data', Buffer.from('first '));
        incoming.emit('data', Buffer.from('second'));
        incoming.emit('end'); request.emit('close');
      }
    });
    expect((await fetchMarketBytes('https://market.test/catalog.json', { maximum: 50 })).toString()).toBe('first second');
    expect(options.map(item => item.url)).toEqual(['https://market.test/catalog.json', 'https://assets.test/catalog.json']);
    expect(options.every(item => item.credentials === 'omit' && item.redirect === 'manual')).toBe(true);
    expect(requests[0].aborted).toBe(true);
  });

  it('does not issue a request to a redirected non-HTTPS target', async () => {
    const { requests } = transport(request => request.emit('redirect', 302, 'GET', 'file:///tmp/secret', {}));
    await expect(fetchMarketBytes('https://market.test/preset.zip', { maximum: 50 })).rejects.toThrow('HTTPS');
    expect(requests).toHaveLength(1);
    expect(requests[0].aborted).toBe(true);
  });

  it('aborts the native request when the streamed size limit is exceeded', async () => {
    const { requests } = transport(request => { respond(request).emit('data', Buffer.alloc(11)); });
    await expect(fetchMarketBytes('https://market.test/preset.zip', { maximum: 10 })).rejects.toThrow('大小限制');
    expect(requests[0].aborted).toBe(true);
  });

  it('propagates cancellation and response stream errors', async () => {
    const cancel = new AbortController();
    const { requests } = transport(request => { respond(request); queueMicrotask(() => cancel.abort()); });
    await expect(fetchMarketBytes('https://market.test/preset.zip', { maximum: 50, signal: cancel.signal })).rejects.toThrow('下载已取消');
    expect(requests[0].aborted).toBe(true);
    transport(request => { const incoming = respond(request); queueMicrotask(() => incoming.emit('error', new Error('connection lost'))); });
    await expect(fetchMarketBytes('https://market.test/preset.zip', { maximum: 50 })).rejects.toThrow('connection lost');
  });

  it('returns valid responses for statuses without a body', async () => {
    const { requests } = transport(request => { respond(request, 204); });
    await expect(fetchMarketBytes('https://market.test/preset.zip', { maximum: 50 })).rejects.toThrow('下载内容为空');
    expect(requests[0].aborted).toBe(true);
  });
});
