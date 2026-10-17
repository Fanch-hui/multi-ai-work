import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { filePath, MAX_FILE_BYTES } from './file-policy.js';
import { loadWorkspaceDependencies } from './office-runtime.js';

const inputSchema = z.object({
  artifactId: z.string().min(1).max(200).optional(), path: z.string().min(1).max(8000).optional(),
  format: z.enum(['pdf', 'png']).default('pdf'), pages: z.array(z.number().int().positive()).min(1).max(40).optional(),
  sheet: z.string().min(1).max(200).optional(), range: z.string().min(1).max(100).optional(),
  dpi: z.number().int().min(24).max(300).default(144),
  outputDirectory: z.string().min(1).max(8000).optional(),
  purpose: z.enum(['deliverable', 'intermediate']).default('intermediate'),
}).refine(input => !!input.artifactId !== !!input.path, '请提供 artifactId 或 path 其中一个');
export type RenderDocumentInput = z.infer<typeof inputSchema>;
interface RenderReport { backend: string; missingFonts: string[]; pageCount?: number; files: { path: string; page?: number; sheet?: string; width?: number; height?: number }[]; }

export async function authorizedOfficeDocument(input: RenderDocumentInput, context: ToolExecutionContext) {
  const artifact = input.artifactId ? context.findArtifact(input.artifactId) : undefined;
  if (input.artifactId && !artifact) throw new Error('成果不存在或未授权');
  const target = artifact ? artifact.path : await filePath(input.path!, context);
  if (!['.docx', '.pptx', '.xlsx', '.pdf', '.odt', '.ods', '.odp', '.doc', '.xls', '.ppt'].includes(path.extname(target).toLowerCase())) {
    throw new Error('只支持 Office 文档或 PDF 预览');
  }
  const info = await stat(target);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('文档必须为不超过 25 MiB 的普通文件');
  if (input.format === 'pdf' && (input.pages || input.sheet || input.range)) throw new Error('页面和工作表选择仅用于 PNG 预览');
  if (input.format === 'pdf' && path.extname(target).toLowerCase() === '.pdf') throw new Error('PDF 输入请使用 PNG 预览');
  if (input.range && !input.sheet) throw new Error('单元格范围需要同时指定工作表名称');
  return target;
}

export async function renderDocument(input: RenderDocumentInput, context: ToolExecutionContext) {
  if (!context.workspace.writable || !context.processes) throw new Error('文档导出需要可写工作目录和命令权限');
  const dependencies = await loadWorkspaceDependencies();
  const target = await authorizedOfficeDocument(input, context);
  const sourceArtifact = input.artifactId ? context.findArtifact(input.artifactId)
    : context.listArtifacts().filter(artifact => artifact.workingPath === target).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const directory = await officeOutputDirectory(input, target, context);
  if (!await context.requestApproval('render_document', `导出文档：${path.basename(target)} → ${input.format.toUpperCase()}`, { ...input })) {
    throw new Error('文档导出未获批准');
  }
  context.signal.throwIfAborted();
  context.assertAuthorized?.();
  const output = await filePath(path.join(directory, '.office-previews', randomUUID()), context, true);
  await mkdir(output, { recursive: true });
  const reportPath = path.join(output, 'render-report.json');
  try {
    const command = await context.processes.run({ command: dependencies.node,
      args: [dependencies.renderScript, JSON.stringify({ inputPath: target, outputDirectory: output, reportPath,
        format: input.format, pages: input.pages, sheet: input.sheet, range: input.range, dpi: input.dpi })],
      workdir: context.workspace.path, timeoutMs: 180_000 }, { approved: true }) as { code?: number | null; status?: string; timedOut?: boolean; stderr?: string };
    context.signal.throwIfAborted();
    if (command.code !== 0 || command.timedOut || command.status && command.status !== 'completed') {
      throw new Error(`文档导出失败：${command.stderr?.slice(-3000) || command.status || '命令未正常退出'}`);
    }
    const report: RenderReport = JSON.parse(await readFile(reportPath, 'utf8'));
    const artifacts = [];
    for (const file of report.files) {
      const rendered = await filePath(file.path, context);
      const relative = path.relative(output, rendered);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('导出结果不在本次输出目录');
      const bytes = await readFile(rendered);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('单个导出文件超过 25 MiB 成果限制');
      const artifact = context.registerArtifact({ name: path.basename(rendered), path: rendered, workingPath: rendered,
        mimeType: input.format === 'pdf' ? 'application/pdf' : 'image/png', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), taskId: context.task.id, botId: context.botId,
        conversationId: context.conversation.id, source: 'render_document', purpose: input.purpose,
        requirementVersion: sourceArtifact?.requirementVersion });
      artifacts.push({ ...file, artifactId: artifact.id, purpose: artifact.purpose, requirementVersion: artifact.requirementVersion });
    }
    return { backend: report.backend, missingFonts: report.missingFonts, pageCount: report.pageCount,
      artifacts, structuralCheck: 'not_run', visualCheck: 'not_run' };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function officeOutputDirectory(input: RenderDocumentInput, target: string, context: ToolExecutionContext) {
  const artifact = input.artifactId ? context.findArtifact(input.artifactId) : undefined;
  const source = artifact ? artifact.workingPath : target;
  if (!input.outputDirectory && !source) throw new Error('此成果没有工作目录来源，请指定工作区内的 outputDirectory');
  return filePath(input.outputDirectory ?? path.dirname(source!), context, true);
}

export function createOfficeTools() {
  return {
    load_workspace_dependencies: {
      description: '查看 App 随包的 Python、Node、Office 库、转换引擎和技能完整路径及版本，制作文档前先调用。',
      schema: z.object({}), execute: () => loadWorkspaceDependencies(),
    },
    render_document: {
      description: '把获准 Office 成果或工作目录文档导出为 PDF，或生成页面、幻灯片、工作表区域的 PNG 预览。预览默认为 intermediate；仅将最终交付用户的导出文件设为 deliverable 进入成果库。outputDirectory 指定工作区内的输出目录，默认在原工作文件所在目录保存。返回登记成果 ID；此操作不代表已完成内容或视觉检查。',
      schema: inputSchema, available: (context: ToolExecutionContext) => context.workspace.writable && !!context.processes,
      execute: renderDocument,
    },
  };
}
