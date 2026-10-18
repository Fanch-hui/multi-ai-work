import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CoreService } from './service.js';
import { publicError } from './errors.js';
import { z } from 'zod';
import { imageResolver } from './run-images.js';
import { createWebSession } from './web-session.js';

async function body(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export async function startHttp(core: CoreService, web: boolean, port = web ? 4317 : 0) {
  const webSession = web ? createWebSession() : undefined;
  const subscribers = new Set<ServerResponse>();
  let scheduled = false;
  const unsubscribe = core.state.subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; for (const response of subscribers) response.write('data: {}\n\n'); }, 80);
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => json(response, { error: publicError(error) }, 400));
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!request.headers.host?.match(/^(127\.0\.0\.1|localhost):\d+$/)) return json(response, { error: '无效主机' }, 403);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/native/')) {
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const active = core.executor.nativeContexts.get(token);
      if (!active) return json(response, { error: '运行授权已失效' }, 401);
      if (url.pathname === '/native/tools' && request.method === 'GET') return json(response, await core.tools.currentDefinitions(active.context, active.bot.id));
      if (url.pathname === '/native/yield' && request.method === 'POST') {
        core.tools.yieldInput(active.runId); return json(response, { waiting: true });
      }
      if (url.pathname === '/native/call' && request.method === 'POST') {
        const input = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()), callId: z.string() }).parse(await body(request));
        return json(response, { result: await core.tools.execute(input.name, input.args, input.callId, active.context, active.bot) });
      }
      if (url.pathname === '/native/image' && request.method === 'POST') {
        const input = z.object({ artifactId: z.string() }).parse(await body(request));
        return json(response, await imageResolver(core.state, active.context)({ artifactId: input.artifactId, mimeType: '' }));
      }
      return json(response, { error: '不支持的工具操作' }, 404);
    }
    if (!web || !url.pathname.startsWith('/api/')) return json(response, { error: '不存在' }, 404);
    const origin = request.headers.origin;
    if (origin && !['http://127.0.0.1:5173', 'http://localhost:5173'].includes(origin)) return json(response, { error: '来源未授权' }, 403);
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (!origin || !request.headers['content-type']?.startsWith('application/json')) return json(response, { error: '请求来源或类型未授权' }, 403);
      const input = z.object({ launchCode: z.string() }).parse(await body(request));
      const cookie = webSession!.exchange(input.launchCode);
      if (!cookie) return json(response, { error: '开发会话入口已失效，请重新启动 Core' }, 401);
      response.setHeader('set-cookie', cookie);
      return json(response, { ready: true });
    }
    if (!webSession!.authorized(request.headers.cookie)) return json(response, { error: '开发会话未授权，请使用 Core 打开的开发页面' }, 401);
    if (url.pathname === '/api/snapshot' && request.method === 'GET') return json(response, core.state.snapshot());
    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write('data: {}\n\n'); subscribers.add(response);
      request.on('close', () => subscribers.delete(response)); return;
    }
    if (url.pathname === '/api/rpc' && request.method === 'POST') {
      if (!origin || !request.headers['content-type']?.startsWith('application/json')) return json(response, { error: '请求来源或类型未授权' }, 403);
      const input = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).default({}) }).parse(await body(request));
      return json(response, { result: await core.request(input.method, input.params) });
    }
    if (url.pathname === '/api/attachments' && request.method === 'POST') {
      if (!origin || !request.headers['content-type']?.startsWith('application/json')) return json(response, { error: '请求来源或类型未授权' }, 403);
      return json(response, { result: await core.request('conversations.attachBytes', await body(request, 36 * 1024 * 1024)) });
    }
    return json(response, { error: '不存在' }, 404);
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Core 本地服务无法启动');
  core.executor.coreUrl = `http://127.0.0.1:${address.port}`;
  return { url: core.executor.coreUrl, webLaunchUrl: webSession?.launchUrl, close: async () => {
    unsubscribe(); for (const response of subscribers) response.end();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
