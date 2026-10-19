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
import type {
  CoreRequest,
  CoreHostResult,
  CoreToDesktopMessage,
  DesktopToCoreMessage,
} from '../domain/core-ipc.js';
import type { ProviderSocketCommand, ProviderSocketEvent } from '../providers/socket-proxy.js';

type ParentPort = {
  postMessage(value: unknown): void;
  on(
    name: 'message',
    handler: (event: { data: DesktopToCoreMessage | ProviderSocketEvent }) => void,
  ): void;
};
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const send = (value: CoreToDesktopMessage | ProviderSocketCommand) =>
  port ? port.postMessage(value) : process.send?.(value);
const providerSockets = port ? createProviderSocketProxy(send) : undefined;
function host(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'host', id, method, params });
  });
}
const web = process.argv.includes('--web');
let core: CoreService | undefined;
function settleHostRequest(input: CoreHostResult) {
  const handler = pending.get(String(input.id));
  pending.delete(String(input.id));
  if (input.error) handler?.reject(new Error(String(input.error)));
  else handler?.resolve(input.result);
}
async function respondToRequest(input: CoreRequest) {
  try {
    if (!core) throw new Error('Core 尚未就绪');
    const result = await core.request(String(input.method), input.params ?? {});
    send({ type: 'result', id: input.id, result });
  } catch (error) {
    send({ type: 'result', id: input.id, error: publicError(error) });
  }
}
async function message(input: DesktopToCoreMessage | ProviderSocketEvent) {
  if (providerSockets?.receive(input)) return;
  switch (input.type) {
    case 'host-result':
      settleHostRequest(input);
      return;
    case 'request':
      await respondToRequest(input);
      return;
    case 'close':
      await close();
      send({ type: 'closed' });
      setTimeout(() => process.exit(0), 10);
  }
}
port?.on('message', (event) => {
  void message(event.data);
});
if (!port)
  process.on('message', (input) => {
    void message(input as DesktopToCoreMessage);
  });
let http: Awaited<ReturnType<typeof startHttp>>;
let closed = false;
let unsubscribeChanges: (() => void) | undefined;
const webController = new AbortController();
async function close() {
  if (closed) return;
  closed = true;
  webController.abort();
  unsubscribeChanges?.();
  await core?.close();
  providerSockets?.close();
  await http?.close();
}
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  void close().then(() => process.exit(0));
});
function reportFatal(error: unknown) {
  send({ type: 'fatal', error: publicError(error) });
  if (process.env.AI_TEAM_SMOKE_DATA_DIR)
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
}
process.on('uncaughtException', (error) => {
  reportFatal(error);
  void close().finally(() => process.exit(1));
});
async function startCore() {
  const { CoreService } = await import('./service.js');
  core = new CoreService(
    process.env.AI_TEAM_DATA_DIR ?? join(process.cwd(), '.data'),
    port || process.send
      ? {
          encrypt: async (value) => String(await host('encrypt', { value })),
          decrypt: async (value) => String(await host('decrypt', { value })),
        }
      : undefined,
    port || process.send ? (method, params) => host(method, params) : undefined,
  );
  await configureDesktopNetworking();
  await core.start();
  http = await startHttp(core, web);
  unsubscribeChanges = subscribeBatchedChanges(core.state, () => send({ type: 'changed' }));
  send({ type: 'ready' });
  if (web)
    process.stdout.write(
      'multi-AI work Core 已启动（127.0.0.1:4317）。开发模式凭据仅存于当前进程。\n',
    );
  if (http.webLaunchUrl)
    void openWebUi(http.webLaunchUrl, webController.signal).catch(() => {
      if (!closed)
        process.stderr.write('开发界面无法打开，请启动界面并检查默认浏览器后重新启动 Core。\n');
    });
}
async function configureDesktopNetworking() {
  if (!port) return;
  const { net } = await import('electron');
  configureProviderFetch((input, init) => net.fetch(new Request(input, init)));
  configureProviderWebSocket(providerSockets!.create);
  configureMarketFetch(createElectronMarketFetch(net));
}
try {
  await startCore();
} catch (error) {
  reportFatal(error);
  if (web) process.stderr.write(`${publicError(error)}\n`);
  process.exitCode = 1;
}
