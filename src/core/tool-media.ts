import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { attachmentSizeLimit, imageMimeTypes, normalizeImageBytes } from '../tools/images.js';
import { id } from './state.js';

// Remote media is stored once; provider history and operation receipts keep only artifact references.
export async function storeToolMedia(result: unknown, context: ToolExecutionContext, dataDirectory: string): Promise<unknown> {
  if (!result || typeof result !== 'object') return result;
  const value = result as { content?: Record<string, unknown>[]; isError?: boolean };
  if (!Array.isArray(value.content)) return result;
  const hasMedia = value.content.some(item => item.type === 'image' && typeof item.data === 'string'
    || item.type === 'resource' && !!item.resource && typeof (item.resource as Record<string, unknown>).blob === 'string');
  if (!hasMedia) return result;
  const content: unknown[] = [];
  for (const item of value.content) {
    const media = item.type === 'resource' ? item.resource as Record<string, unknown> : item;
    const encoded = media?.data ?? media?.blob;
    if ((item.type === 'image' || item.type === 'resource') && typeof encoded === 'string' && imageMimeTypes.has(String(media.mimeType))) {
      if (encoded.length > Math.ceil(attachmentSizeLimit / 3) * 4) throw new Error('工具图片超过 25 MiB');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('工具图片编码无效');
      const directory = join(dataDirectory, 'tool-media', id()); await mkdir(directory, { recursive: true });
      const path = join(directory, `image.${String(media.mimeType).split('/')[1]}`);
      try {
        await normalizeImageBytes(bytes, directory, String(media.mimeType));
        await writeFile(path, bytes, { mode: 0o600 });
        const artifact = context.registerArtifact({ name: '工具图片.' + String(media.mimeType).split('/')[1], path,
          mimeType: String(media.mimeType), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          conversationId: context.conversation.id, source: 'mcp-image' });
        content.push({ type: 'image', image: { artifactId: artifact.id, mimeType: artifact.mimeType } });
      } finally { await rm(directory, { recursive: true, force: true }); }
    } else if (item.type === 'text') content.push(item);
    else if (item.type === 'resource' && typeof media?.text === 'string') content.push({ type: 'text', text: media.text });
    else content.push({ type: 'text', text: '工具返回了当前模型无法读取的媒体内容。' });
  }
  return { content, ...(value.isError ? { isError: true } : {}) };
}
