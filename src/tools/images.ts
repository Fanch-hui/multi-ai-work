import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { Artifact, ImageMetadata } from '../domain/types.js';

export const attachmentSizeLimit = 25 * 1024 * 1024;
export const imageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const decodeOptions = { failOn: 'error' as const, limitInputPixels: 64 * 1024 * 1024 };

export function detectImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  return undefined;
}

export async function normalizeImageBytes(
  bytes: Buffer,
  directory: string,
  expectedMimeType?: string,
): Promise<ImageMetadata> {
  if (!bytes.length || bytes.length > attachmentSizeLimit)
    throw new Error('图片需为不超过 25 MiB 的普通文件');
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) throw new Error('图片内容无效，请使用 PNG、JPEG、WebP 或静态 GIF');
  if (expectedMimeType && expectedMimeType !== mimeType)
    throw new Error('图片内容与文件类型不一致');
  try {
    const metadata = await sharp(bytes, decodeOptions).metadata();
    if (!metadata.width || !metadata.height) throw new Error('图片尺寸无效');
    if ((metadata.pages ?? 1) > 1) throw new Error('暂不支持动画图片，请上传静态图片');
    let pipeline = sharp(bytes, decodeOptions)
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true });
    let output = 'png';
    if (mimeType === 'image/jpeg') output = 'jpeg';
    else if (mimeType === 'image/webp') output = 'webp';
    if (output === 'jpeg') pipeline = pipeline.jpeg({ quality: 90 });
    else if (output === 'webp') pipeline = pipeline.webp({ quality: 90 });
    else pipeline = pipeline.png();
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const previewDirectory = join(directory, '.image');
    await mkdir(previewDirectory, { recursive: true, mode: 0o700 });
    const path = join(previewDirectory, `model.${output}`);
    await writeFile(path, data, { mode: 0o600 });
    return { mimeType: `image/${output}`, width: info.width, height: info.height, path };
  } catch (error) {
    if (error instanceof Error && error.message === '暂不支持动画图片，请上传静态图片') throw error;
    throw new Error('图片无法完整解码，请重新选择有效图片', { cause: error });
  }
}

export async function normalizeArtifactImage(artifact: Artifact): Promise<ImageMetadata> {
  if (!imageMimeTypes.has(artifact.mimeType)) throw new Error('成果不是支持的图片');
  if (!artifact.image)
    artifact.image = await normalizeImageBytes(
      await readFile(artifact.path),
      join(dirname(artifact.path), `${artifact.id}-preview`),
      artifact.mimeType,
    );
  return artifact.image;
}

export async function readArtifactImagePreview(
  artifact: Artifact,
): Promise<{ mimeType: string; bytes: Buffer }> {
  const image = await normalizeArtifactImage(artifact);
  return { mimeType: image.mimeType, bytes: await readFile(image.path) };
}

export async function resolveArtifactImage(
  artifact: Artifact,
): Promise<{ mimeType: string; data: string }> {
  const { mimeType, bytes } = await readArtifactImagePreview(artifact);
  return { mimeType, data: bytes.toString('base64') };
}
