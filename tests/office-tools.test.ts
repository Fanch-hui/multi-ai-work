import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import {
  authorizedOfficeDocument,
  createOfficeTools,
  officeOutputDirectory,
} from '../src/tools/office.js';
import { loadWorkspaceDependencies, workspaceRuntimeRoot } from '../src/tools/office-runtime.js';
import { startCommand } from '../src/tools/process-runner.js';

describe('Office input authorization', () => {
  let directory: string;
  let context: ToolExecutionContext;
  const tool = createOfficeTools().render_document;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'team-office-'));
    context = {
      workspace: { path: directory, writable: true },
      signal: new AbortController().signal,
      findArtifact: () => undefined,
      listArtifacts: () => [],
      requestApproval: async () => false,
    } as unknown as ToolExecutionContext;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('requires a single input and bounded page selection', () => {
    expect(() => tool.schema.parse({})).toThrow();
    expect(() => tool.schema.parse({ path: 'a.docx', artifactId: 'a' })).toThrow();
    expect(() => tool.schema.parse({ path: 'a.docx', pages: [0] })).toThrow();
    expect(tool.schema.parse({ path: 'a.docx' })).toMatchObject({
      format: 'pdf',
      dpi: 144,
      purpose: 'intermediate',
    });
    expect(tool.schema.parse({ path: 'a.docx', purpose: 'deliverable' }).purpose).toBe(
      'deliverable',
    );
  });

  it('rejects another conversation artifact and workspace escapes', async () => {
    await expect(
      authorizedOfficeDocument(tool.schema.parse({ artifactId: 'other' }), context),
    ).rejects.toThrow('未授权');
    await expect(
      authorizedOfficeDocument(tool.schema.parse({ path: '../outside.docx' }), context),
    ).rejects.toThrow('授权');
    expect(await readdir(directory)).toEqual([]);
  });

  it('uses Core-authorized immutable artifact paths', async () => {
    const target = path.join(directory, 'input.docx');
    await writeFile(target, 'fixture');
    context.findArtifact = (id) => (id === 'allowed' ? ({ path: target } as any) : undefined);
    expect(
      await authorizedOfficeDocument(tool.schema.parse({ artifactId: 'allowed' }), context),
    ).toBe(target);
  });

  it('keeps default exports next to the working source and validates an explicit output directory', async () => {
    directory = await realpath(directory);
    const target = path.join(directory, 'acceptance', 'input.docx');
    expect(
      await officeOutputDirectory(
        tool.schema.parse({ path: 'acceptance/input.docx' }),
        target,
        context,
      ),
    ).toBe(path.join(directory, 'acceptance'));
    context.findArtifact = () => ({ path: '/app-data/snapshot.docx', workingPath: target }) as any;
    expect(
      await officeOutputDirectory(
        tool.schema.parse({ artifactId: 'result' }),
        '/app-data/snapshot.docx',
        context,
      ),
    ).toBe(path.join(directory, 'acceptance'));
    expect(
      await officeOutputDirectory(
        tool.schema.parse({ artifactId: 'result', outputDirectory: 'acceptance/previews' }),
        target,
        context,
      ),
    ).toBe(path.join(directory, 'acceptance', 'previews'));
    await expect(
      officeOutputDirectory(
        tool.schema.parse({ path: 'input.docx', outputDirectory: '../outside' }),
        target,
        context,
      ),
    ).rejects.toThrow('授权');
  });

  it('validates preview selection before writing output', async () => {
    await writeFile(path.join(directory, 'input.xlsx'), 'fixture');
    await writeFile(path.join(directory, 'input.pdf'), '%PDF-');
    await expect(
      authorizedOfficeDocument(
        tool.schema.parse({ path: 'input.xlsx', range: 'A1:D3', format: 'png' }),
        context,
      ),
    ).rejects.toThrow('工作表');
    await expect(
      authorizedOfficeDocument(tool.schema.parse({ path: 'input.xlsx', pages: [1] }), context),
    ).rejects.toThrow('PNG');
    await expect(
      authorizedOfficeDocument(tool.schema.parse({ path: 'input.pdf' }), context),
    ).rejects.toThrow('PNG');
    expect(await readdir(directory)).toEqual(['input.pdf', 'input.xlsx']);
  });

  it('reports missing bundled runtime explicitly', async () => {
    await expect(loadWorkspaceDependencies(directory)).rejects.toThrow('运行环境');
  });
});

describe.skipIf(!existsSync(path.join(workspaceRuntimeRoot(), 'runtime.json')))(
  'bundled Office rendering',
  () => {
    let directory: string;
    let context: ToolExecutionContext;
    const tool = createOfficeTools().render_document;
    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'team-office-render-'));
      context = {
        workspace: { path: directory, writable: true },
        signal: new AbortController().signal,
        botId: 'bot',
        task: { id: 'task' },
        conversation: { id: 'conversation' },
        requestApproval: async () => false,
        findArtifact: () => undefined,
        listArtifacts: () => [],
        registerArtifact: (input: any) => ({
          ...input,
          id: 'result',
          createdAt: new Date().toISOString(),
        }),
        processes: {
          run: async () => {
            throw new Error('Unexpected process execution');
          },
        },
      } as unknown as ToolExecutionContext;
      const deps = await loadWorkspaceDependencies();
      execFileSync(
        deps.python,
        [
          '-I',
          '-B',
          '-c',
          'import sys; from docx import Document; d=Document(); d.add_paragraph("中文验收正文"); d.save(sys.argv[1])',
          path.join(directory, 'input.docx'),
        ],
        { timeout: 30_000 },
      );
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('rejects approval before creating any output', async () => {
      await expect(
        tool.execute(tool.schema.parse({ path: 'input.docx' }), context),
      ).rejects.toThrow('批准');
      expect(await readdir(directory)).toEqual(['input.docx']);
    });

    it('runs the pinned renderer and registers the actual PDF', async () => {
      context.requestApproval = async () => true;
      const inputPath = await realpath(path.join(directory, 'input.docx'));
      context.listArtifacts = () => [{ workingPath: inputPath, requirementVersion: 2 }] as any;
      context.processes!.run = async (input, options) => {
        expect(options).toEqual({ approved: true });
        let stderr = '';
        const active = startCommand(
          input,
          directory,
          (stream, text) => {
            if (stream === 'stderr') stderr += text;
          },
          context.signal,
        );
        const result = await active.done;
        return { ...result, stderr };
      };
      const result = await tool.execute(tool.schema.parse({ path: 'input.docx' }), context);
      expect(result.artifacts).toHaveLength(1);
      const artifact = result.artifacts[0]!;
      expect(artifact.artifactId).toBe('result');
      expect(artifact.purpose).toBe('intermediate');
      expect(artifact.requirementVersion).toBe(2);
      expect((await readFile(artifact.path)).subarray(0, 5).toString()).toBe('%PDF-');
      expect(result.visualCheck).toBe('not_run');
    }, 120_000);
  },
);
