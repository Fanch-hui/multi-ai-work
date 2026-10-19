import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact } from '../domain/types.js';
import { loadWorkspaceDependencies } from '../tools/office-runtime.js';
import { MAX_FILE_BYTES } from '../tools/file-policy.js';
import { startCommand } from '../tools/process-runner.js';
import type { State } from './state.js';
import { required } from './errors.js';

interface PreviewFile {
  path: string;
  page?: number;
  sheet?: string;
  width: number;
  height: number;
}
interface PreviewReport {
  files: PreviewFile[];
  pageCount?: number;
  missingFonts: string[];
}
export interface DocumentPreview {
  kind: 'document';
  artifactId: string;
  pageCount: number;
  missingFonts: string[];
  pages: { index: number; label: string; width: number; height: number }[];
}

const formats = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.odt',
  '.ods',
  '.odp',
  '.doc',
  '.xls',
  '.ppt',
]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class ArtifactPreviews {
  private controller = new AbortController();
  private pending = new Map<string, Promise<PreviewReport>>();
  constructor(private state: Pick<State, 'storage' | 'dataDirectory'>) {}

  async describe(artifactId: string): Promise<DocumentPreview> {
    const report = await this.report(artifactId);
    return {
      kind: 'document',
      artifactId,
      pageCount: report.files.length,
      missingFonts: report.missingFonts,
      pages: report.files.map((file, offset) => ({
        index: offset + 1,
        width: file.width,
        height: file.height,
        label: file.sheet ? `${file.sheet} · ${offset + 1}` : `第 ${file.page ?? offset + 1} 页`,
      })),
    };
  }

  async page(artifactId: string, index: number): Promise<{ mimeType: string; data: string }> {
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('预览页码无效');
    const report = await this.report(artifactId);
    const page = report.files[index - 1];
    if (!page) throw new Error('预览页码超出范围');
    const info = await stat(page.path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('预览图片超过 25 MiB 限制');
    return { mimeType: 'image/png', data: (await readFile(page.path)).toString('base64') };
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.pending.values());
  }

  async remove(artifactId: string): Promise<void> {
    await this.pending.get(artifactId)?.catch(() => {});
    const key = this.state.storage.metadata<string>(`artifact-preview:${artifactId}`);
    if (key && /^[a-f0-9]{64}$/.test(key))
      await rm(path.join(this.state.dataDirectory, 'artifact-previews', key), {
        recursive: true,
        force: true,
      });
    this.state.storage.setMetadata(`artifact-preview:${artifactId}`, null);
  }

  private report(artifactId: string): Promise<PreviewReport> {
    this.controller.signal.throwIfAborted();
    const artifact = required(
      this.state.storage.get<Artifact>('artifacts', artifactId),
      '成果不存在',
    );
    if (!formats.has(path.extname(artifact.path).toLowerCase()))
      throw new Error('此成果不支持文档预览');
    const current = this.pending.get(artifactId);
    if (current) return current;
    const pending = this.render(artifact).finally(() => this.pending.delete(artifactId));
    this.pending.set(artifactId, pending);
    return pending;
  }

  private async render(artifact: Artifact): Promise<PreviewReport> {
    const source = await stat(artifact.path);
    if (!source.isFile() || source.size > MAX_FILE_BYTES)
      throw new Error('文档必须为不超过 25 MiB 的普通文件');
    const dependencies = await loadWorkspaceDependencies();
    const bytes = await readFile(artifact.path);
    const key = digest(
      Buffer.concat([Buffer.from(artifact.id), bytes, await readFile(dependencies.renderScript)]),
    );
    const output = path.join(this.state.dataDirectory, 'artifact-previews', key);
    this.state.storage.setMetadata(`artifact-preview:${artifact.id}`, key);
    const reportPath = path.join(output, 'render-report.json');
    this.controller.signal.throwIfAborted();
    try {
      return await this.readReport(reportPath, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(output, { recursive: true, mode: 0o700 });
    const inputPath = path.join(output, `source${path.extname(artifact.path).toLowerCase()}`);
    try {
      await writeFile(inputPath, bytes, { mode: 0o600 });
      let stderr = '';
      const command = startCommand(
        {
          command: dependencies.node,
          args: [
            dependencies.renderScript,
            JSON.stringify({
              inputPath,
              outputDirectory: output,
              reportPath,
              format: 'png',
              dpi: 120,
              maxPages: 10000,
            }),
          ],
          timeoutMs: 180_000,
        },
        output,
        (stream, text) => {
          if (stream === 'stderr') stderr = (stderr + text).slice(-3000);
        },
        this.controller.signal,
      );
      const result = await command.done;
      this.controller.signal.throwIfAborted();
      if (result.status !== 'completed')
        throw new Error(`文档预览生成失败：${stderr || result.error?.message || result.status}`);
      return await this.readReport(reportPath, output);
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(inputPath, { force: true });
    }
  }

  private async readReport(reportPath: string, directory: string): Promise<PreviewReport> {
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as PreviewReport;
    if (!Array.isArray(report.files) || !report.files.length)
      throw new Error('文档未生成可用预览页面');
    const root = await realpath(directory);
    for (const file of report.files) {
      const target = await realpath(file.path);
      const relative = path.relative(root, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('预览页面路径无效');
      file.path = target;
    }
    return report;
  }
}
