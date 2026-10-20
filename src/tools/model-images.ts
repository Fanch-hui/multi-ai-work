import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Artifact } from '../domain/types.js';
import { attachmentSizeLimit, detectImageMimeType, imageMimeTypes } from './images.js';
import { withDerivedCache } from './derived-cache.js';

export const MODEL_IMAGE_ENCODING_VERSION = 1;
type EncodedImage = { mimeType: string; data: string };
const pending = new Map<string, Promise<EncodedImage>>();
const decodeOptions = { failOn: 'error' as const, limitInputPixels: 64 * 1024 * 1024 };

export async function resolveModelArtifactImage(
  artifact: Artifact,
  dataDirectory?: string,
): Promise<EncodedImage> {
  if (!imageMimeTypes.has(artifact.mimeType)) throw new Error('成果不是支持的图片');
  const source = resolve(artifact.path);
  const file = await stat(source, { bigint: true });
  if (!file.isFile() || file.size <= 0 || file.size > BigInt(attachmentSizeLimit)) {
    throw new Error('图片需为不超过 25 MiB 的普通文件');
  }
  const original = await readFile(source);
  if (!original.length || original.length > attachmentSizeLimit)
    throw new Error('图片需为不超过 25 MiB 的普通文件');
  if (detectImageMimeType(original) !== artifact.mimeType)
    throw new Error('图片内容与文件类型不一致');
  const identity = [
    MODEL_IMAGE_ENCODING_VERSION,
    source,
    file.dev,
    file.ino,
    file.size,
    file.mtimeNs,
    file.ctimeNs,
  ].join(':');
  const key = createHash('sha256')
    .update(
      dataDirectory
        ? JSON.stringify([
            'model-image',
            MODEL_IMAGE_ENCODING_VERSION,
            sharp.versions,
            artifact.mimeType,
            2048,
            84,
            9,
          ])
        : identity,
    )
    .update(original)
    .digest('hex');
  let format: 'jpeg' | 'webp' | 'png' = 'png';
  if (artifact.mimeType === 'image/jpeg') format = 'jpeg';
  else if (artifact.mimeType === 'image/webp') format = 'webp';
  const directory = dataDirectory
    ? join(dataDirectory, 'derived-cache', key)
    : join(dirname(source), `${artifact.id}-preview`, '.image');
  const cache = join(directory, `input-v${MODEL_IMAGE_ENCODING_VERSION}-${key}.${format}`);
  const existing = pending.get(cache);
  if (existing) return existing;
  const work = dataDirectory
    ? withDerivedCache(directory, () => loadOrEncode(original, cache, format))
    : loadOrEncode(original, cache, format);
  pending.set(cache, work);
  try {
    return await work;
  } finally {
    pending.delete(cache);
  }
}

async function loadOrEncode(
  original: Buffer,
  cache: string,
  format: 'jpeg' | 'webp' | 'png',
): Promise<EncodedImage> {
  try {
    return { mimeType: `image/${format}`, data: (await readFile(cache)).toString('base64') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const encoded = await encode(original, format);
  await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
  const temporary = `${cache}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' });
    await rename(temporary, cache);
  } finally {
    await rm(temporary, { force: true });
  }
  return { mimeType: `image/${format}`, data: encoded.toString('base64') };
}

async function encode(original: Buffer, format: 'jpeg' | 'webp' | 'png'): Promise<Buffer> {
  try {
    const metadata = await sharp(original, decodeOptions).metadata();
    if (!metadata.width || !metadata.height) throw new Error('图片尺寸无效');
    if ((metadata.pages ?? 1) > 1) throw new Error('暂不支持动画图片，请上传静态图片');
    let pipeline = sharp(original, decodeOptions)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 84 });
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 84 });
    else pipeline = pipeline.png({ compressionLevel: 9 });
    return await pipeline.toBuffer();
  } catch (error) {
    if (error instanceof Error && error.message === '暂不支持动画图片，请上传静态图片') throw error;
    throw new Error('图片无法完整解码，请重新选择有效图片', { cause: error });
  }
}
