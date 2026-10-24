import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { filePath } from './file-policy.js';

export function createArtifactTools() {
  return {
    list_artifacts: {
      description: '列出当前会话及已明确回传的获准成果，可按名称筛选，返回成果 ID 供分段读取。',
      schema: z.object({
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: (
        args: { query?: string; offset: number; limit: number },
        context: ToolExecutionContext,
      ) => {
        const all = context
          .listArtifacts()
          .filter(
            (item) =>
              !args.query || item.name.toLocaleLowerCase().includes(args.query.toLocaleLowerCase()),
          );
        return {
          items: all
            .slice(args.offset, args.offset + args.limit)
            .map(
              ({
                id,
                name,
                path,
                mimeType,
                size,
                sha256,
                taskId,
                purpose,
                requirementVersion,
                superseded,
                seriesId,
                previousArtifactId,
              }) => ({
                id,
                name,
                path,
                mimeType,
                size,
                sha256,
                taskId,
                purpose,
                requirementVersion,
                superseded,
                seriesId,
                previousArtifactId,
              }),
            ),
          total: all.length,
          nextOffset: args.offset + args.limit < all.length ? args.offset + args.limit : null,
        };
      },
    },
    register_artifact: {
      description:
        '将授权工作目录中最终交付用户的文件登记为不可变成果快照，返回成果 ID。修改已有成果时提供 previousArtifactId 关联明确输入的上一版本；过程资料确需登记时将 purpose 设为 intermediate；默认 deliverable 进入成果库。',
      schema: z.object({
        workspaceId: z.string().optional(),
        path: z.string().min(1).max(8000),
        purpose: z.enum(['deliverable', 'intermediate']).default('deliverable'),
        previousArtifactId: z.string().min(1).optional(),
      }),
      execute: async (
        args: {
          path: string;
          purpose: 'deliverable' | 'intermediate';
          previousArtifactId?: string;
        },
        context: ToolExecutionContext,
      ) => {
        const target = await filePath(args.path, context);
        const info = await stat(target);
        if (!info.isFile() || info.size > 25 * 1024 * 1024)
          throw new Error('成果必须为不超过 25 MiB 的普通文件');
        const bytes = await readFile(target);
        const types: Record<string, string> = {
          '.md': 'text/markdown',
          '.txt': 'text/plain',
          '.json': 'application/json',
          '.csv': 'text/csv',
          '.pdf': 'application/pdf',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.zip': 'application/zip',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        context.signal.throwIfAborted();
        return context.registerArtifact({
          name: path.basename(target),
          path: target,
          workingPath: target,
          mimeType: types[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          taskId: context.task.id,
          botId: context.botId,
          conversationId: context.conversation.id,
          source: 'register_artifact',
          purpose: args.purpose,
          previousArtifactId: args.previousArtifactId,
        });
      },
    },
  };
}
