import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Artifact } from '../domain/types.js';
import { attachmentSizeLimit, detectImageMimeType, imageMimeTypes } from './images.js';

export const MODEL_IMAGE_ENCODING_VERSION = 1;
type EncodedImage = { mimeType: string; data: string };
const pending = new Map<string, Promise<EncodedImage>>();
const decodeOptions = { failOn: 'error' as const, limitInputPixels: 64 * 1024 * 1024 };

export async function resolveModelArtifactImage(artifact: Artifact): Promise<EncodedImage> {
  if (!imageMimeTypes.has(artifact.mimeType)) throw new Error('成果不是支持的图片');
  const source = resolve(artifact.path);
  const file = await stat(source, { bigint: true });
  if (!file.isFile() || file.size <= 0 || file.size > BigInt(attachmentSizeLimit)) {
    throw new Error('图片需为不超过 25 MiB 的普通文件');
  }
  const identity = [MODEL_IMAGE_ENCODING_VERSION, source, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
  const key = createHash('sha256').update(identity).digest('hex');
  const format = artifact.mimeType === 'image/jpeg' ? 'jpeg' : artifact.mimeType === 'image/webp' ? 'webp' : 'png';
  const cache = join(dirname(source), `${artifact.id}-preview`, '.image', `input-v${MODEL_IMAGE_ENCODING_VERSION}-${key}.${format}`);
  const existing = pending.get(cache);
  if (existing) return existing;
  const work = loadOrEncode(source, cache, artifact.mimeType, format);
  pending.set(cache, work);
  try { return await work; }
  finally { pending.delete(cache); }
}

async function loadOrEncode(source: string, cache: string, mimeType: string, format: 'jpeg' | 'webp' | 'png'): Promise<EncodedImage> {
  try {
    return { mimeType: `image/${format}`, data: (await readFile(cache)).toString('base64') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const original = await readFile(source);
  if (detectImageMimeType(original) !== mimeType) throw new Error('图片内容与文件类型不一致');
  const encoded = await encode(original, format);
  await mkdir(dirname(cache), { recursive: true, mode: 0o700 });
  const temporary = `${cache}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' });
    await rename(temporary, cache);
  } finally { await rm(temporary, { force: true }); }
  return { mimeType: `image/${format}`, data: encoded.toString('base64') };
}

async function encode(original: Buffer, format: 'jpeg' | 'webp' | 'png'): Promise<Buffer> {
  try {
    const metadata = await sharp(original, decodeOptions).metadata();
    if (!metadata.width || !metadata.height) throw new Error('图片尺寸无效');
    if ((metadata.pages ?? 1) > 1) throw new Error('暂不支持动画图片，请上传静态图片');
    let pipeline = sharp(original, decodeOptions).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: 84 }) : format === 'webp' ? pipeline.webp({ quality: 84 })
      : pipeline.png({ compressionLevel: 9 });
    return await pipeline.toBuffer();
  } catch (error) {
    if (error instanceof Error && error.message === '暂不支持动画图片，请上传静态图片') throw error;
    throw new Error('图片无法完整解码，请重新选择有效图片', { cause: error });
  }
}
