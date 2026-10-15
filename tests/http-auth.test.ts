import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttp } from '../src/core/http.js';
import { createWebSession } from '../src/core/web-session.js';
import type { CoreService } from '../src/core/service.js';
import { get as httpGet } from 'node:http';

const origin = 'http://127.0.0.1:5173';
const headers = { origin, 'content-type': 'application/json' };
const channels: Awaited<ReturnType<typeof startHttp>>[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  await Promise.all(channels.splice(0).map(channel => channel.close()));
});

async function setup(web = true) {
  const request = vi.fn(async (_method: string, params: unknown) => params);
  const core = {
    state: { subscribe: () => () => {}, snapshot: () => ({ conversations: [] }) },
    executor: { coreUrl: '', nativeContexts: new Map() },
    tools: { definitions: () => [] }, request,
  } as unknown as CoreService;
  const channel = await startHttp(core, web, 0);
  channels.push(channel);
  return { core, channel, request };
}
function launchCode(channel: Awaited<ReturnType<typeof startHttp>>): string {
  return new URLSearchParams(new URL(channel.webLaunchUrl!).hash.slice(1)).get('web-launch')!;
}
async function authorize(channel: Awaited<ReturnType<typeof startHttp>>) {
  const response = await fetch(`${channel.url}/api/session`, { method: 'POST', headers,
    body: JSON.stringify({ launchCode: launchCode(channel) }) });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie.includes('HttpOnly')).toBe(true);
  expect(setCookie.includes('SameSite=Strict')).toBe(true);
  expect(setCookie.includes('Path=/api')).toBe(true);
  expect(/expires=|max-age=/i.test(setCookie)).toBe(false);
  return setCookie.split(';')[0];
}

describe('开发 Web 会话授权', () => {
  it('snapshot、SSE、RPC 和附件入口均拒绝匿名本机请求', async () => {
    const { channel, request } = await setup();
    for (const [path, method] of [['snapshot', 'GET'], ['events', 'GET'], ['rpc', 'POST'], ['attachments', 'POST']]) {
      const response = await fetch(`${channel.url}/api/${path}`, { method, headers,
        ...(method === 'POST' ? { body: JSON.stringify({ method: 'state.snapshot' }) } : {}) });
      expect(response.status).toBe(401);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('入口需要合法来源和一次性启动码，伪造与重放均失败', async () => {
    const { channel } = await setup();
    const body = JSON.stringify({ launchCode: launchCode(channel) });
    const absentOrigin = await fetch(`${channel.url}/api/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body });
    expect(absentOrigin.status).toBe(403);
    const forbiddenOrigin = await fetch(`${channel.url}/api/session`, { method: 'POST',
      headers: { ...headers, origin: 'https://example.com' }, body });
    expect(forbiddenOrigin.status).toBe(403);
    const forged = await fetch(`${channel.url}/api/session`, { method: 'POST', headers,
      body: JSON.stringify({ launchCode: 'invalid-test-code' }) });
    expect(forged.status).toBe(401);
    await authorize(channel);
    const replay = await fetch(`${channel.url}/api/session`, { method: 'POST', headers, body });
    expect(replay.status).toBe(401);
  });

  it('授权 cookie 支持后续读取、刷新、RPC、附件和 SSE 重连', async () => {
    const { channel, request } = await setup(), cookie = await authorize(channel);
    for (let read = 0; read < 2; read++) {
      const response = await fetch(`${channel.url}/api/snapshot`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ conversations: [] });
    }
    const rpc = await fetch(`${channel.url}/api/rpc`, { method: 'POST', headers: { ...headers, cookie },
      body: JSON.stringify({ method: 'test.action', params: { value: 1 } }) });
    expect(rpc.status).toBe(200);
    expect(request).toHaveBeenLastCalledWith('test.action', { value: 1 });
    const attachment = await fetch(`${channel.url}/api/attachments`, { method: 'POST', headers: { ...headers, cookie },
      body: JSON.stringify({ name: 'test.txt' }) });
    expect(attachment.status).toBe(200);
    expect(request).toHaveBeenLastCalledWith('conversations.attachBytes', { name: 'test.txt' });
    for (let connection = 0; connection < 2; connection++) {
      const controller = new AbortController();
      const events = await fetch(`${channel.url}/api/events`, { headers: { cookie }, signal: controller.signal });
      expect(events.status).toBe(200);
      expect(events.headers.get('content-type')).toBe('text/event-stream');
      expect(new TextDecoder().decode((await events.body!.getReader().read()).value)).toBe('data: {}\n\n');
      controller.abort();
    }
  });

  it('无效 cookie 不能授权，合法会话仍受主机与来源限制', async () => {
    const { channel } = await setup(), cookie = await authorize(channel);
    expect((await fetch(`${channel.url}/api/snapshot`, { headers: { cookie: 'ma_work_web_session=invalid' } })).status).toBe(401);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(`${channel.url}/api/snapshot`, { headers: { cookie, host: 'example.com' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${channel.url}/api/snapshot`, { headers: { cookie, origin: 'https://example.com' } })).status).toBe(403);
  });

  it('启动码过期，已签发会话只对本次 Core 进程有效', async () => {
    vi.useFakeTimers();
    const session = createWebSession();
    const code = new URLSearchParams(new URL(session.launchUrl).hash.slice(1)).get('web-launch')!;
    vi.advanceTimersByTime(5 * 60_000);
    expect(session.exchange(code) === undefined).toBe(true);
    vi.useRealTimers();
    const { channel } = await setup(), cookie = await authorize(channel);
    const next = await setup();
    expect((await fetch(`${next.channel.url}/api/snapshot`, { headers: { cookie } })).status).toBe(401);
  });

  it('桌面 API 保持关闭，原生工具仍只接受当前运行授权', async () => {
    const { core, channel } = await setup(false);
    expect(channel.webLaunchUrl === undefined).toBe(true);
    expect((await fetch(`${channel.url}/api/snapshot`)).status).toBe(404);
    expect((await fetch(`${channel.url}/native/tools`)).status).toBe(401);
    core.executor.nativeContexts.set('native-test-authorization', { context: {}, bot: {}, runId: 'test-run' } as never);
    expect((await fetch(`${channel.url}/native/tools`, { headers: { authorization: 'Bearer native-test-authorization' } })).status).toBe(200);
  });

  it('API 模块先清除启动片段并完成授权，再请求数据与订阅事件', async () => {
    vi.resetModules();
    const replaceState = vi.fn();
    vi.stubGlobal('window', { location: { hash: '#web-launch=fixture-launch', pathname: '/', search: '' },
      history: { state: null, replaceState } });
    let authorize!: () => void;
    const ready = new Promise<void>(resolve => { authorize = resolve; });
    const fetchRequest = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') {
        expect(replaceState).toHaveBeenCalledWith(null, '', '/');
        await ready;
      }
      expect(init?.credentials).toBe('same-origin');
      return new Response(JSON.stringify(path === '/api/snapshot' ? { conversations: [] } : { result: 'ready' }));
    });
    vi.stubGlobal('fetch', fetchRequest);
    const close = vi.fn(), events = vi.fn(function () { return { close }; });
    vi.stubGlobal('EventSource', events);
    const api = await import('../apps/ui/src/api.js');
    const snapshot = api.snapshot(), request = api.request('test.action'), unsubscribe = api.subscribe(() => {});
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    authorize();
    expect(await snapshot).toEqual({ conversations: [] });
    expect(await request).toBe('ready');
    expect(events).toHaveBeenCalledWith('/api/events');
    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
  });
});
