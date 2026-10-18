import NodeWebSocket from 'ws';

export type ProviderSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>;
type SocketFactory = (url: string, headers: Record<string, string>) => ProviderSocket;
let socketFactory: SocketFactory = (url, headers) => {
  const socket = new NodeWebSocket(url, { headers, followRedirects: false });
  socket.on('error', () => {});
  return socket as unknown as ProviderSocket;
};
export function configureProviderWebSocket(factory: SocketFactory): void { socketFactory = factory; }
export function providerWebSocket(url: string, headers: Record<string, string>): ProviderSocket { return socketFactory(url, headers); }

let transport: typeof fetch = (input, init) => fetch(input, init);

export function configureProviderFetch(fetcher: typeof fetch): void {
  transport = fetcher;
}

export function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) return value.code;
  const chromium = typeof value.message === 'string' ? /\bnet::(ERR_[A-Z_]+)\b/.exec(value.message)?.[1] : undefined;
  return chromium ?? (value.cause && value.cause !== error ? networkErrorCode(value.cause) : undefined);
}

export function providerNetworkError(error: unknown): Error {
  const code = networkErrorCode(error);
  return new Error(`模型服务网络连接失败${code ? `（${code}）` : ''}，请检查网络后重试`, { cause: error });
}

export async function providerFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  try {
    return await transport(input, { ...init, credentials: 'omit' });
  } catch (error) {
    if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) throw error;
    throw providerNetworkError(error);
  }
}
