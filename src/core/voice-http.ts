import { providerFetch } from '../providers/network.js';

export function voiceBaseUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('语音服务地址须使用 HTTPS；本机服务可使用 HTTP，地址中请勿包含凭据');
  }
  return url.toString().replace(/\/$/, '');
}

export async function voiceHttp(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await providerFetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`语音服务请求失败（HTTP ${response.status}）`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('语音服务返回了空响应');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error('语音响应超过 16 MiB');
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), mimeType: response.headers.get('content-type') ?? '' };
}
