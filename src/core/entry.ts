import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreService } from './service.js';
import { startHttp } from './http.js';
import { publicError } from './errors.js';
import { configureProviderFetch, configureProviderWebSocket } from '../providers/network.js';
import { createProviderSocketProxy } from '../providers/socket-proxy.js';
import { configureMarketFetch } from './market/network.js';
import { createElectronMarketFetch } from './market/electron-transport.js';
import { subscribeBatchedChanges } from './state-notifications.js';
import { openWebUi } from './open-web-ui.js';

type ParentPort = { postMessage(value: unknown): void; on(name: 'message', handler: (event: { data: Record<string, unknown> }) => void): void };
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (value: unknown) => port ? port.postMessage(value) : process.send?.(value);
const providerSockets = port ? createProviderSocketProxy(send) : undefined;
function host(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: 'host', id, method, params }); });
}
const web = process.argv.includes('--web');
let core: CoreService | undefined;
async function message(input: Record<string, unknown>) {
  if (providerSockets?.receive(input)) return;
  if (input.type === 'host-result') {
    const handler = pending.get(String(input.id)); pending.delete(String(input.id));
    if (input.error) handler?.reject(new Error(String(input.error))); else handler?.resolve(input.result);
  }
  if (input.type === 'request') {
    try {
      if (!core) throw new Error('Core 尚未就绪');
      send({ type: 'result', id: input.id, result: await core.request(String(input.method), (input.params ?? {}) as Record<string, unknown>) });
    }
    catch (error) { send({ type: 'result', id: input.id, error: publicError(error) }); }
  }
  if (input.type === 'close') { await close(); send({ type: 'closed' }); setTimeout(() => process.exit(0), 10); }
}
port?.on('message', event => { void message(event.data); });
if (!port) process.on('message', input => { void message(input as Record<string, unknown>); });
let http: Awaited<ReturnType<typeof startHttp>>;
let closed = false;
let unsubscribeChanges: (() => void) | undefined;
const webController = new AbortController();
async function close() {
  if (closed) return; closed = true;
  webController.abort(); unsubscribeChanges?.();
  await core?.close(); providerSockets?.close(); await http?.close();
}
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
function reportFatal(error: unknown) {
  send({ type: 'fatal', error: publicError(error) });
  if (process.env.AI_TEAM_SMOKE_DATA_DIR) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}
process.on('uncaughtException', error => { reportFatal(error); void close().finally(() => process.exit(1)); });
try {
  const { CoreService } = await import('./service.js');
  core = new CoreService(process.env.AI_TEAM_DATA_DIR ?? join(process.cwd(), '.data'),
    port || process.send ? { encrypt: async value => String(await host('encrypt', { value })), decrypt: async value => String(await host('decrypt', { value })) } : undefined,
    port || process.send ? (method, params) => host(method, params) : undefined);
  if (port) {
    const { net } = await import('electron');
    configureProviderFetch((input, init) => net.fetch(new Request(input, init)));
    configureProviderWebSocket(providerSockets!.create);
    configureMarketFetch(createElectronMarketFetch(net));
  }
  await core.start(); http = await startHttp(core, web);
  unsubscribeChanges = subscribeBatchedChanges(core.state, () => send({ type: 'changed' }));
  send({ type: 'ready' });
  if (web) process.stdout.write('multi-AI work Core 已启动（127.0.0.1:4317）。开发模式凭据仅存于当前进程。\n');
  if (http.webLaunchUrl) void openWebUi(http.webLaunchUrl, webController.signal)
    .catch(() => { if (!closed) process.stderr.write('开发界面无法打开，请启动界面并检查默认浏览器后重新启动 Core。\n'); });
} catch (error) {
  reportFatal(error);
  if (web) process.stderr.write(`${publicError(error)}\n`);
  process.exitCode = 1;
}
