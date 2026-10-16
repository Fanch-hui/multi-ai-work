import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_UPDATE_REPOSITORY, type AppUpdateAsset } from '../domain/app-update.js';

export type UpdateFetch = typeof fetch;

function validateResponseUrl(value: string) {
  const url = new URL(value);
  const github = url.hostname === 'github.com' && url.pathname.startsWith(`/${APP_UPDATE_REPOSITORY}/releases/`);
  const cdn = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !github && !cdn)
    throw new Error('更新下载服务地址无效');
}

async function response(url: string, fetcher: UpdateFetch, signal: AbortSignal) {
  validateResponseUrl(url);
  const result = await fetcher(url, { redirect: 'follow', credentials: 'omit', cache: 'no-store', signal });
  try {
    validateResponseUrl(result.url || url);
    if (!result.ok) throw new Error(result.status === 404 ? '更新源尚未发布，请稍后再试' : `更新服务暂不可用（HTTP ${result.status}）`);
    if (!result.body) throw new Error('更新下载内容为空');
    return result;
  } catch (error) { await result.body?.cancel(); throw error; }
}

export async function readUpdateManifest(url: string, fetcher: UpdateFetch, signal: AbortSignal): Promise<unknown> {
  const result = await response(url, fetcher, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  const reader = result.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) throw new Error('更新清单过大');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('更新清单格式无效'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function verifyUpdateFile(path: string, asset: Pick<AppUpdateAsset, 'size' | 'sha256'>) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) throw new Error('更新安装包大小不一致，请重新下载');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error('更新安装包校验失败，请重新下载');
}

export async function downloadUpdate(asset: AppUpdateAsset, path: string, fetcher: UpdateFetch,
  signal: AbortSignal, progress: (received: number) => void) {
  const idle = new AbortController();
  const combined = AbortSignal.any([signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const active = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('更新下载超时，请重试')), 120_000); };
  let received = 0;
  const hash = createHash('sha256');
  active();
  try {
    const result = await response(asset.url, fetcher, combined);
    const length = result.headers.get('content-length');
    if (length !== null && Number(length) !== asset.size) {
      await result.body!.cancel(); throw new Error('更新安装包大小不一致，请重新下载');
    }
    const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      active(); received += chunk.length;
      if (received > asset.size) { callback(new Error('更新安装包超过清单大小')); return; }
      hash.update(chunk); progress(received); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(result.body! as import('node:stream/web').ReadableStream), count,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: combined });
    if (received !== asset.size) throw new Error('更新安装包未下载完整，请重试');
    if (hash.digest('hex') !== asset.sha256) throw new Error('更新安装包校验失败，请重新下载');
  } catch (error) {
    await rm(path, { force: true });
    if (idle.signal.aborted) throw idle.signal.reason;
    throw error;
  } finally { clearTimeout(timer!); }
}
