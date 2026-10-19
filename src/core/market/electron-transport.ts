import type { Net } from 'electron';

const maximumResponseBytes = 256 * 1024 * 1024;

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values))
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  return headers;
}

export function createElectronMarketFetch(net: Pick<Net, 'request'>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (request.method !== 'GET') throw new Error('市场资源仅支持 GET 请求');
    return new Promise<Response>((resolve, reject) => {
      const client = net.request({
        url: request.url,
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: Object.fromEntries(request.headers.entries()),
      });
      let finished = false;
      let published = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const finish = () => {
        finished = true;
        request.signal.removeEventListener('abort', abort);
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finish();
        if (published) controller?.error(error);
        else reject(error);
      };
      const abort = () => {
        fail(request.signal.reason);
        client.abort();
      };
      request.signal.addEventListener('abort', abort, { once: true });
      client.on('error', fail);
      client.on('redirect', (status, _method, location, values) => {
        if (finished) return;
        const headers = responseHeaders(values);
        headers.set('location', location);
        finish();
        resolve(new Response(null, { status, headers }));
        // Electron requires a synchronous redirect decision. Core validates each next URL separately.
        client.abort();
      });
      client.on('response', (incoming) => {
        if (finished) return;
        const headers = responseHeaders(incoming.headers);
        incoming.on('error', fail);
        if ([204, 205, 304].includes(incoming.statusCode)) {
          finish();
          resolve(new Response(null, { status: incoming.statusCode, headers }));
          client.abort();
          return;
        }
        let received = 0;
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            incoming.on('end', () => {
              if (!finished) {
                finish();
                value.close();
              }
            });
            incoming.on('aborted', () => fail(new DOMException('下载已取消', 'AbortError')));
            incoming.on('data', (chunk) => {
              if (finished) return;
              received += chunk.byteLength;
              if (received > maximumResponseBytes) {
                fail(new Error('下载内容超过大小限制'));
                client.abort();
                return;
              }
              value.enqueue(chunk);
            });
          },
          cancel() {
            finish();
            client.abort();
          },
        });
        published = true;
        resolve(new Response(body, { status: incoming.statusCode, headers }));
      });
      client.end();
    });
  };
}
