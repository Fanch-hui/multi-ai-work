import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { filePath, readFileBytes } from '../tools/file-policy.js';
import { detectImageMimeType, normalizeImageBytes } from '../tools/images.js';
import { workspacePath } from '../tools/paths.js';
import { id } from './state.js';

export async function qoderImageResult(
  result: unknown,
  context: ToolExecutionContext,
  dataDirectory: string,
) {
  const output = result as { filePath?: unknown; requestId?: unknown };
  if (!output || typeof output.filePath !== 'string') throw new Error('Qoder 未返回生成图片的文件');
  const target = await filePath(output.filePath, context);
  const directory = await workspacePath('vibe_images', context);
  if (relative(directory, dirname(target)) !== '')
    throw new Error('Qoder 图片不在本任务的生成目录');
  const bytes = await readFileBytes(target),
    mimeType = detectImageMimeType(bytes);
  if (!mimeType) throw new Error('Qoder 返回的文件不是有效图片');
  const staging = join(dataDirectory, 'qoder-media', id());
  await mkdir(staging, { recursive: true });
  try {
    await normalizeImageBytes(bytes, staging, mimeType);
    context.signal.throwIfAborted();
    const artifact = context.registerArtifact({
      name: basename(target),
      path: target,
      workingPath: target,
      mimeType,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      conversationId: context.conversation.id,
      source: 'qoder-image',
      purpose: 'deliverable',
    });
    return {
      artifactId: artifact.id,
      name: artifact.name,
      mimeType,
      filePath: target,
      ...(typeof output.requestId === 'string' ? { requestId: output.requestId } : {}),
      instruction: '图片已保存为本任务成果，交付时使用 artifactId，可用 read_artifact 查看图片。',
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function qoderPublicResult(result: unknown, limit = 64000) {
  const content = JSON.stringify(result, (key, value) => {
    if (
      [
        'blob',
        'base64',
        'authorization',
        'accessToken',
        'refreshToken',
        'apiKey',
        'cookie',
      ].includes(key)
    )
      return undefined;
    return value;
  });
  if (!content) return { content: '' };
  return content.length <= limit
    ? JSON.parse(content)
    : { content: content.slice(0, 24000), truncated: true };
}
