import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { readDocument } from './documents.js';
import { ensureParent } from './paths.js';
import { approveFileChange, existingVersion, filePath, fileVersion, readFileBytes } from './file-policy.js';
import { findFiles, listDirectory, searchText } from './file-search.js';

const file = z.string().min(1).max(8000);
const directory = file.default('.');
const limit = z.number().int().min(1).max(1000).default(100);
const pageOffset = z.number().int().min(0).default(0);
type ReadInput = { path: string; offset?: number; limit?: number };

export function createFileTools() {
  return {
    list_directory: {
      description: '列出授权目录的直接子项，返回相对路径、类型、大小和分页信息；跳过凭据、依赖和生成目录。',
      schema: z.object({ path: directory, offset: pageOffset, limit }),
      execute: listDirectory
    },
    find_files: {
      description: '按文件名或 glob 查找授权目录的文件，尊重忽略规则，返回相对路径和分页信息。',
      schema: z.object({ path: directory, pattern: z.string().min(1).max(2000), offset: pageOffset, limit }),
      execute: findFiles
    },
    search_text: {
      description: '搜索授权目录文本，默认字面匹配，可选择正则与文件 glob；返回相对路径、行号和上下文。',
      schema: z.object({ path: directory, query: z.string().min(1).max(2000), regex: z.boolean().default(false),
        glob: z.string().min(1).max(2000).optional(), contextLines: z.number().int().min(0).max(5).default(1), offset: pageOffset, limit }),
      execute: searchText
    },
    read_file: {
      description: '读取授权目录的文本、PDF、DOCX 或 XLSX；文本 offset 为从 1 开始的行号，limit 为行数。返回文件版本供修改核对。',
      schema: z.object({ path: file, offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(2000).default(500) }),
      execute: readWorkspaceFile
    },
    write_file: {
      description: '新建或完整更新 UTF-8 文本文件。覆盖已有文件前必须读取当前版本，按成员执行权限确认操作。返回规范路径和新版本。',
      schema: z.object({ path: file, content: z.string().max(2_000_000) }),
      available: (context: ToolExecutionContext) => context.workspace.writable,
      execute: writeWorkspaceFile
    },
    edit_file: {
      description: '精确替换已读取文本，默认旧文本必须唯一匹配，replaceAll 可显式替换全部匹配；按成员执行权限确认操作。',
      schema: z.object({ path: file, oldText: z.string().min(1).max(500_000), newText: z.string().max(500_000), replaceAll: z.boolean().default(false) }),
      available: (context: ToolExecutionContext) => context.workspace.writable,
      execute: editWorkspaceFile
    }
  };
}

async function readWorkspaceFile(input: ReadInput, context: ToolExecutionContext): Promise<unknown> {
  const target = await filePath(input.path, context);
  const bytes = await readFileBytes(target);
  const version = fileVersion(bytes);
  if (['.pdf', '.docx', '.xlsx'].includes(path.extname(target).toLowerCase())) {
    const document = await readDocument(target) as Record<string, unknown>;
    if (fileVersion(await readFileBytes(target)) !== version) throw new Error('文件读取期间已变化，请重新读取');
    context.observeFile?.(target, version);
    return { ...document, path: target, version };
  }
  if (bytes.includes(0)) throw new Error('不支持读取此二进制格式');
  const source = bytes.toString('utf8');
  const lines = source ? source.split(/\r?\n/) : [];
  if (source.endsWith('\n')) lines.pop();
  const offset = input.offset ?? 1;
  const selected = lines.slice(offset - 1, offset - 1 + (input.limit ?? 500));
  let consumed = 0, content = '';
  for (const line of selected) {
    const separator = consumed ? '\n' : '';
    content += separator + line.slice(0, Math.max(0, 120_000 - content.length - separator.length));
    consumed++;
    if (content.length >= 120_000) break;
  }
  const next = offset - 1 + consumed < lines.length ? offset + consumed : null;
  context.observeFile?.(target, version);
  return { format: 'text', path: target, content, text: content, version, offset, endLine: consumed ? offset + consumed - 1 : null,
    nextOffset: next, totalLines: lines.length, truncated: next !== null || selected.slice(0, consumed).join('\n').length > content.length };
}

async function saveText(target: string, content: string, previous: string | undefined, context: ToolExecutionContext): Promise<unknown> {
  context.signal.throwIfAborted();
  if (!context.workspace.writable) throw new Error('工作目录仅允许读取');
  if (await filePath(target, context, true) !== target) throw new Error('目标路径已变化，请重新读取');
  context.markDispatched?.();
  await ensureParent(target);
  await writeFile(target, content, { encoding: 'utf8', flag: previous ? 'w' : 'wx' });
  const version = fileVersion(Buffer.from(content));
  context.observeFile?.(target, version);
  return { path: target, version, previousVersion: previous ?? null, size: Buffer.byteLength(content), created: !previous };
}

async function writeWorkspaceFile(input: { path: string; content: string }, context: ToolExecutionContext): Promise<unknown> {
  const target = await filePath(input.path, context, true);
  const previous = await existingVersion(target, context);
  if (previous) await approveFileChange(target, previous, 'write_file', context);
  return saveText(target, input.content, previous, context);
}

async function editWorkspaceFile(input: { path: string; oldText: string; newText: string; replaceAll?: boolean }, context: ToolExecutionContext): Promise<unknown> {
  const target = await filePath(input.path, context);
  const bytes = await readFileBytes(target);
  if (bytes.includes(0)) throw new Error('不支持编辑二进制文件');
  const version = fileVersion(bytes);
  if (context.getObservedFileVersion?.(target) !== version) throw new Error('请先读取文件；文件版本已变化时须重新读取');
  const source = bytes.toString('utf8');
  const parts = source.split(input.oldText);
  const matches = parts.length - 1;
  if (!matches) throw new Error('旧文本没有匹配');
  if (matches !== 1 && !input.replaceAll) throw new Error('旧文本匹配多处，请提供唯一文本或显式使用 replaceAll');
  await approveFileChange(target, version, 'edit_file', context);
  const result = await saveText(target, parts.join(input.newText), version, context) as Record<string, unknown>;
  return { ...result, replacements: matches };
}
