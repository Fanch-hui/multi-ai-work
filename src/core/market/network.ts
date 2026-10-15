let transport: typeof fetch = (input, init) => fetch(input, init);

export function configureMarketFetch(fetcher: typeof fetch) { transport = fetcher; }

export function marketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('市场下载地址须为不含凭据的 HTTPS 地址');
  return url.href;
}

export async function fetchMarketBytes(url: string, options: {
  signal?: AbortSignal; maximum: number; progress?: (received: number, total?: number) => void;
}): Promise<Buffer> {
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  let location = marketUrl(url), response: Response | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await transport(location, { credentials: 'omit', redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next || redirects === 5) throw new Error('下载地址重定向过多或无效');
      location = marketUrl(new URL(next, location).href);
    }
    if (!response?.ok) throw new Error(`下载服务返回 HTTP ${response?.status}`);
    const total = Number(response.headers.get('content-length')) || undefined;
    if (total && total > options.maximum) { await response.body?.cancel(); throw new Error('下载内容超过大小限制'); }
    if (!response.body) throw new Error('下载内容为空');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let received = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        signal.throwIfAborted(); received += result.value.byteLength;
        if (received > options.maximum) throw new Error('下载内容超过大小限制');
        chunks.push(Buffer.from(result.value)); options.progress?.(received, total);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks);
  } catch (error) {
    if (options.signal?.aborted) throw new Error('下载已取消');
    if (signal.aborted) throw new Error('市场下载超时，请重试');
    throw new Error(`市场下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
