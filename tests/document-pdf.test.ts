import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { createFileTools } from '../src/tools/files.js';
import { MAX_FILE_BYTES, MAX_PDF_INPUT_BYTES } from '../src/tools/file-policy.js';
import { authorizedOfficeDocument, createOfficeTools } from '../src/tools/office.js';
import { loadWorkspaceDependencies, workspaceRuntimeRoot } from '../src/tools/office-runtime.js';

async function pdfAboveAttachmentLimit() {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Authorized local evidence');
  pdf.context.register(pdf.context.stream(Buffer.alloc(MAX_FILE_BYTES + 1024, 32)));
  return pdf.save({ useObjectStreams: false });
}

describe('authorized local PDF inputs', () => {
  let directory: string;
  let context: ToolExecutionContext;
  const read = createFileTools().read_file;
  const render = createOfficeTools().render_document;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'document-pdf-')));
    const observed = new Map<string, string>();
    context = {
      workspace: { path: directory, writable: true },
      signal: new AbortController().signal,
      findArtifact: () => undefined,
      observeFile: (target: string, version: string) => observed.set(target, version),
      getObservedFileVersion: (target: string) => observed.get(target),
    } as unknown as ToolExecutionContext;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('extracts bounded page text and observes the full version of a PDF over 25 MiB', async () => {
    const source = await pdfAboveAttachmentLimit();
    expect(source.length).toBeGreaterThan(MAX_FILE_BYTES);
    const target = path.join(directory, 'evidence.pdf');
    await writeFile(target, source);

    const result = (await read.execute(read.schema.parse({ path: target }), context)) as any;
    expect(result).toMatchObject({
      format: 'pdf',
      totalPages: 1,
      truncated: false,
      needsOcr: false,
      path: target,
      version: createHash('sha256').update(source).digest('hex'),
    });
    expect(result.pages).toEqual([{ page: 1, text: 'Authorized local evidence ' }]);
    expect(context.getObservedFileVersion?.(target)).toBe(result.version);
    expect(
      createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
    ).toBe(result.version);
    expect(
      await authorizedOfficeDocument(
        render.schema.parse({ path: target, format: 'png', pages: [1] }),
        context,
      ),
    ).toBe(target);
  });

  it.skipIf(!existsSync(path.join(workspaceRuntimeRoot(), 'runtime.json')))(
    'renders a selected page of a large local PDF with the source rendering adapter',
    async () => {
      const dependencies = await loadWorkspaceDependencies();
      const scripts = path.join(directory, 'runtime', 'office-skills', 'scripts');
      await mkdir(scripts, { recursive: true });
      for (const name of ['node_modules', 'fonts']) {
        await symlink(
          path.join(dependencies.root, name),
          path.join(directory, 'runtime', name),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      const script = path.join(scripts, 'render_document.mjs');
      await cp(path.resolve('resources/office/scripts/render_document.mjs'), script);
      const input = path.join(directory, 'evidence.pdf');
      await writeFile(input, await pdfAboveAttachmentLimit());
      const output = path.join(directory, 'preview');
      const report = path.join(output, 'report.json');
      await promisify(execFile)(
        dependencies.node,
        [
          script,
          JSON.stringify({
            inputPath: input,
            outputDirectory: output,
            reportPath: report,
            format: 'png',
            pages: [1],
            dpi: 24,
          }),
        ],
        { timeout: 120_000 },
      );
      const result = JSON.parse(await readFile(report, 'utf8'));
      expect(result.pageCount).toBe(1);
      expect(result.files).toHaveLength(1);
      expect((await readFile(result.files[0].path)).subarray(1, 4).toString()).toBe('PNG');
    },
    120_000,
  );

  it('retains format-specific input bounds and workspace authorization', async () => {
    for (const [name, size] of [
      ['large.pdf', MAX_PDF_INPUT_BYTES + 1],
      ['large.docx', MAX_FILE_BYTES + 1],
      ['large.txt', MAX_FILE_BYTES + 1],
    ] as const) {
      const file = await open(path.join(directory, name), 'w');
      await file.truncate(size);
      await file.close();
      await expect(read.execute(read.schema.parse({ path: name }), context)).rejects.toThrow(
        name.endsWith('.pdf') ? '64 MiB' : '25 MiB',
      );
      if (!name.endsWith('.txt')) {
        await expect(
          authorizedOfficeDocument(
            render.schema.parse({ path: name, format: 'png', pages: [1] }),
            context,
          ),
        ).rejects.toThrow(name.endsWith('.pdf') ? '64 MiB' : '25 MiB');
      }
    }
    await expect(
      read.execute(read.schema.parse({ path: '../evidence.pdf' }), context),
    ).rejects.toThrow('授权');
  });
});
