import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { TcpNetConnectOpts } from 'node:net';
import type { ToolExecutionContext } from '../domain/tools.js';
import { isPublicAddress } from './web-address.js';
import { extractWebContent } from './web-content.js';

export async function publicUrl(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许不含凭据的 HTTP/HTTPS 地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('禁止访问本机、内网与云元数据地址');
  return { url, addresses };
}

export async function publicRequest(input: string, signal: AbortSignal, headers: Record<string, string> = {}, body?: string, redirects = 0): Promise<{ url: string; text: string; contentType: string }> {
  const { url, addresses } = await publicUrl(input);
  const options: http.RequestOptions & Pick<TcpNetConnectOpts, 'autoSelectFamily'> = { headers, signal, autoSelectFamily: true,
    lookup: ((_host: string, options: { all?: boolean }, callback: Function) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }) as never };
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const receive = (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (body !== undefined) return reject(new Error('搜索接口发生重定向，请填写最终接口地址'));
        if (redirects >= 3) return reject(new Error('网页重定向超过限制'));
        const next = new URL(response.headers.location, url);
        const nextHeaders = next.origin === url.origin ? headers : {};
        publicRequest(next.href, signal, nextHeaders, undefined, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); reject(new Error(`网页请求失败 HTTP ${status}`)); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) request.destroy(new Error('网页响应超过 2 MiB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ url: url.href, text: Buffer.concat(chunks).toString('utf8'), contentType: String(response.headers['content-type'] ?? '') }));
    };
    const request = body === undefined ? client.get(url, options, receive)
      : client.request(url, { ...options, method: 'POST' }, receive);
    request.setTimeout(20_000, () => request.destroy(new Error('网页请求超时')));
    request.on('error', reject);
    if (body !== undefined) request.end(body);
  });
}

export async function fetchWeb(url: string, context: ToolExecutionContext): Promise<unknown> {
  const result = await publicRequest(url, context.signal, { Accept: 'text/html,application/json,text/plain', 'Accept-Encoding': 'identity' });
  if (!/text\/|json|xml/.test(result.contentType)) throw new Error('此地址未返回可读文本');
  return { url: result.url, fetchedAt: new Date().toISOString(), ...extractWebContent(result.text, result.contentType, result.url) };
}
