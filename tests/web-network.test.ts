import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import type { TcpNetConnectOpts } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicAddress } from '../src/tools/web-address.js';
import { publicRequest, publicUrl } from '../src/tools/web.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('public web address policy', () => {
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '100.64.0.1',
    '100.127.255.255',
    '192.168.0.1',
    '192.0.0.1',
    '192.0.0.170',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '168.63.129.16',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'fe80::1%lo0',
    'ff02::1',
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:0::1',
    '2001:0000:1234::1',
    '2002:0808:0808::1',
    '::ffff:127.0.0.1',
    '::FFFF:7f00:1',
    '0:0:0:0:0:ffff:c0a8:1',
    '::ffff:198.51.100.1',
    'invalid',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '169.1.2.3',
    '169.253.255.255',
    '169.255.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.0.1.1',
    '192.0.3.1',
    '192.0.0.9',
    '192.0.0.10',
    '198.17.255.255',
    '198.20.0.1',
    '203.0.114.1',
    '2001:4860:4860::8888',
    '2001:4860:4860:0000:0000:0000:0000:8888',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::FFFF:808:808',
    '0:0:0:0:0:ffff:0808:0808',
  ])('allows public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('public web requests', () => {
  const addresses = [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ];
  let requests: Array<RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'>>;
  let responses: Array<{ status: number; location?: string }>;

  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue(addresses as never);
    requests = [];
    responses = [];
    const get = (
      _url: unknown,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      requests.push(options);
      const request = new EventEmitter() as ReturnType<typeof http.get>;
      request.setTimeout = vi.fn().mockReturnValue(request);
      request.destroy = vi.fn((error) => {
        if (error) request.emit('error', error);
        return request;
      });
      const abort = () => request.destroy(new Error('request aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      queueMicrotask(() => {
        if (options.signal?.aborted) {
          abort();
          return;
        }
        const next = responses.shift() ?? { status: 200 };
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = next.status;
        response.headers = {
          'content-type': 'text/plain',
          ...(next.location ? { location: next.location } : {}),
        };
        response.resume = vi.fn().mockReturnValue(response);
        callback(response);
        response.emit('data', Buffer.from('body'));
        response.emit('end');
        options.signal?.removeEventListener('abort', abort);
      });
      return request;
    };
    vi.spyOn(http, 'get').mockImplementation(get as typeof http.get);
    vi.spyOn(https, 'get').mockImplementation(get as typeof https.get);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(lookup).mockReset();
  });

  it('keeps all validated DNS addresses available for Node dual-stack fallback without re-resolving', async () => {
    await expect(
      publicRequest('https://example.com', new AbortController().signal),
    ).resolves.toMatchObject({ text: 'body' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('example.com', { all: true });
    expect(requests[0].autoSelectFamily).toBe(true);
    const all = vi.fn();
    requests[0].lookup!('example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, addresses);
    const single = vi.fn();
    requests[0].lookup!('example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, addresses[0].address, 6);
  });

  it('rejects a hostname if any resolved address is private', async () => {
    vi.mocked(lookup).mockResolvedValue([
      ...addresses,
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(publicUrl('https://example.com')).rejects.toThrow('禁止访问');
    expect(requests).toHaveLength(0);
  });

  it('validates each redirect and drops authorization on a different origin', async () => {
    responses.push({ status: 302, location: 'https://other.example/path' });
    await expect(
      publicRequest('http://example.com', new AbortController().signal, {
        Authorization: 'Bearer test',
      }),
    ).resolves.toMatchObject({ url: 'https://other.example/path' });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.headers)).toEqual([
      { Authorization: 'Bearer test' },
      {},
    ]);
  });

  it('does not send a redirected request to a forbidden DNS result', async () => {
    responses.push({ status: 302, location: 'https://private.example/' });
    vi.mocked(lookup)
      .mockResolvedValueOnce(addresses as never)
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    await expect(
      publicRequest('https://example.com', new AbortController().signal),
    ).rejects.toThrow('禁止访问');
    expect(requests).toHaveLength(1);
  });

  it('passes cancellation to the request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(publicRequest('https://example.com', controller.signal)).rejects.toThrow(
      'aborted',
    );
    expect(requests[0].signal).toBe(controller.signal);
  });
});
