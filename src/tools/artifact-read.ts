import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Artifact } from '../domain/types.js';
import { readDocument } from './documents.js';
import { imageMimeTypes, normalizeArtifactImage } from './images.js';

const textBudget = 24000;
const request = z.object({ artifactId: z.string().min(1).max(200),
  offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(textBudget).optional() });
type ReadRequest = z.infer<typeof request>;
type ImageBlock = { type: 'image'; image: { artifactId: string; mimeType: string; width?: number; height?: number } };

function authorizedArtifact(id: string, context: ToolExecutionContext): Artifact {
  context.signal.throwIfAborted();
  context.assertAuthorized?.();
  const artifact = context.findArtifact(id);
  if (!artifact) throw new Error('成果不存在或未授权');
  return artifact;
}

function metadata(artifact: Artifact) {
  return { artifactId: artifact.id, name: artifact.name, path: artifact.path,
    requirementVersion: artifact.requirementVersion, superseded: artifact.superseded };
}

async function readOne(args: ReadRequest, context: ToolExecutionContext, limit = args.limit ?? 12000) {
  const artifact = authorizedArtifact(args.artifactId, context);
  if ((artifact.contentSource ? artifact.size : (await stat(artifact.path)).size) > 25 * 1024 * 1024)
    throw new Error('成果超过 25 MiB 读取限制');
  authorizedArtifact(artifact.id, context);
  if (imageMimeTypes.has(artifact.mimeType)) {
    const image = await normalizeArtifactImage(artifact);
    authorizedArtifact(artifact.id, context);
    return { artifact, image: { type: 'image', image: { artifactId: artifact.id, mimeType: image.mimeType,
      width: image.width, height: image.height } } as ImageBlock };
  }
  if (artifact.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    return { artifact, value: { ...metadata(artifact), format: 'pptx', contentAvailable: false,
      instruction: '通过 Office 技能与随包 python-pptx 读取、修改此文件；源成果按只读资料处理，修改另存到工作目录并登记。' } };
  const bytes = ['text/markdown', 'text/plain', 'application/json'].includes(artifact.mimeType)
    ? context.readArtifact ? Buffer.from(await context.readArtifact(artifact.id)) : await readFile(artifact.path) : undefined;
  if (bytes && bytes.length > 25 * 1024 * 1024) throw new Error('成果超过 25 MiB 读取限制');
  const document = bytes ? bytes.toString('utf8') : JSON.stringify(await readDocument(artifact.path));
  authorizedArtifact(artifact.id, context);
  const offset = args.offset ?? 0;
  return { artifact, value: { ...metadata(artifact), content: document.slice(offset, offset + limit), offset,
    nextOffset: offset + limit < document.length ? offset + limit : null, totalLength: document.length } };
}

async function readBatch(reads: ReadRequest[], context: ToolExecutionContext) {
  const results: Record<string, unknown>[] = [], images: ImageBlock[] = [];
  let remaining = textBudget;
  for (const [index, args] of reads.entries()) {
    context.signal.throwIfAborted();
    try {
      const limit = Math.min(args.limit ?? 12000, Math.floor(remaining / (reads.length - index)));
      const result = await readOne(args, context, limit);
      if (result.image) {
        results.push({ ...metadata(result.artifact), imageIndex: images.length });
        images.push(result.image);
      } else {
        results.push(result.value!);
        if ('content' in result.value!) remaining -= result.value!.content!.length;
      }
    } catch (error) {
      context.signal.throwIfAborted();
      results.push({ artifactId: args.artifactId, offset: args.offset ?? 0,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ reads: results }) }, ...images] };
}

export function createArtifactReadTool() {
  return {
    description: '按成果 ID 读取获准资料。单份使用 artifactId，文档用 offset / limit 字符分页；多份独立资料或预览页使用 reads 一次读取 1–4 项，与单份参数互斥。批量共用 24000 字符额度，各项保留分页位置；图片返回可查看的图像，imageIndex 从 0 对应图像顺序。',
    schema: request.partial().extend({ reads: z.array(request).min(1).max(4).optional() }),
    execute: async (args: Partial<ReadRequest> & { reads?: ReadRequest[] }, context: ToolExecutionContext) => {
      if (args.reads) {
        if (args.artifactId !== undefined || args.offset !== undefined || args.limit !== undefined)
          throw new Error('reads 与单份读取参数不能同时使用');
        return readBatch(args.reads, context);
      }
      if (!args.artifactId) throw new Error('请提供 artifactId 或 reads');
      const result = await readOne({ ...args, artifactId: args.artifactId }, context);
      return result.image ? { content: [{ type: 'text', text: `图片 ${result.artifact.name} (${result.artifact.id})` }, result.image] } : result.value;
    },
  };
}
