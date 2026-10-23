import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { HostDevices } from './host-access-devices.js';
import type { HostAccessApi } from './host-access-api.js';
import type { HostAccessStatus } from '../domain/host-access.js';
import { publicError } from './errors.js';

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
};
async function body(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new Error('请使用 JSON 请求');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error('请求过大');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function startHostAccessHttp(
  devices: HostDevices,
  api: HostAccessApi,
  status: () => HostAccessStatus,
) {
  let authority = '';
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) =>
      json(response, 400, { error: publicError(error) }),
    );
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (
      request.headers.host !== authority ||
      request.headers.origin ||
      request.headers['sec-fetch-site']
    )
      return json(response, 403, { error: '请求来源未授权' });
    const url = new URL(request.url ?? '/', `http://${authority}`);
    const prefix = '/host/v1';
    if (!url.pathname.startsWith(`${prefix}/`)) return json(response, 404, { error: '接口不存在' });
    const path = url.pathname.slice(prefix.length);
    if (request.method === 'POST' && path === '/pair')
      return json(response, 200, { apiVersion: '1', ...devices.exchange(await body(request)) });
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const device = devices.authenticate(token);
    if (!device) return json(response, 401, { error: '设备授权已失效' });
    if (request.method === 'GET' && path === '/status') return json(response, 200, status());
    const input =
      request.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(request);
    const currentDevice = devices.authenticate(token);
    if (!currentDevice) return json(response, 401, { error: '设备授权已失效' });
    return json(response, 200, {
      apiVersion: '1',
      result: await api.request(currentDevice, request.method ?? '', path, input),
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('宿主接口启动失败');
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}/host/v1`,
    close: async () => {
      devices.clearPairing();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
