import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Artifact } from '../src/domain/types.js';
import { ArtifactPreviews } from '../src/core/artifact-preview.js';
import { readDocument } from '../src/tools/documents.js';
import { loadWorkspaceDependencies, workspaceRuntimeRoot } from '../src/tools/office-runtime.js';

describe.skipIf(!existsSync(path.join(workspaceRuntimeRoot(), 'runtime.json')))(
  'original document previews',
  () => {
    let root: string;
    let previews: ArtifactPreviews;
    const artifacts = new Map<string, Artifact>();
    const metadata = new Map<string, unknown>();
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'artifact-preview-'));
      artifacts.clear();
      metadata.clear();
      previews = new ArtifactPreviews({
        dataDirectory: path.join(root, 'app-data'),
        storage: {
          get: (_collection: string, id: string) => artifacts.get(id),
          metadata: (key: string) => metadata.get(key),
          setMetadata: (key: string, value: unknown) => metadata.set(key, value),
        } as any,
      });
    });
    afterEach(async () => {
      await previews.close();
      await rm(root, { recursive: true, force: true });
    });

    async function register(name: string) {
      const target = path.join(root, name),
        bytes = await readFile(target);
      artifacts.set(name, {
        id: name,
        name,
        path: target,
        mimeType: 'application/octet-stream',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt: '',
        conversationId: 'room',
      });
      return name;
    }

    async function pdf(pages: number) {
      const deps = await loadWorkspaceDependencies();
      const document = await PDFDocument.create();
      document.registerFontkit(fontkit);
      const font = await document.embedFont(
        await readFile(path.join(deps.fontDirectory, 'NotoSansCJKsc-Regular.otf')),
        { subset: true },
      );
      for (let index = 0; index < pages; index++)
        document.addPage([300, 200]).drawText('中文验收正文', { font, size: 16, x: 20, y: 150 });
      await writeFile(path.join(root, 'input.pdf'), await document.save());
      return register('input.pdf');
    }

    it('reads Chinese PDF text in an Electron utility process without a browser worker', async () => {
      await pdf(2);
      const script = `Object.defineProperty(process.versions, 'electron', {value:'44.7.0'}); process.type='utility';
      const {readDocument} = await import(${JSON.stringify(pathToFileURL(path.resolve('src/tools/documents.ts')).href)});
      console.log(JSON.stringify(await readDocument(${JSON.stringify(path.join(root, 'input.pdf'))})));`;
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 30000 },
      );
      expect(output).toContain('中文验收正文');
      expect(output).toContain('"totalPages":2');
    });

    it('releases the artifact preview mapping and retains the reusable cache and document', async () => {
      const artifactId = await pdf(1);
      await previews.describe(artifactId);
      const key = metadata.get(`artifact-preview:${artifactId}`) as string;
      const directory = path.join(root, 'app-data', 'derived-cache', key);
      expect(existsSync(directory)).toBe(true);
      await previews.remove(artifactId);
      expect(metadata.get(`artifact-preview:${artifactId}`)).toBeNull();
      expect(existsSync(directory)).toBe(true);
      expect(existsSync(path.join(root, artifactId))).toBe(true);
    }, 30000);

    it('renders every original Office/PDF page and worksheet, caches it outside the workspace, and retains source identity', async () => {
      const deps = await loadWorkspaceDependencies();
      execFileSync(
        deps.python,
        [
          '-I',
          '-B',
          '-c',
          `import sys
from docx import Document
from pptx import Presentation
from openpyxl import Workbook
from pathlib import Path
p=Path(sys.argv[1]); d=Document(); d.add_paragraph('中文验收正文'); d.add_page_break(); d.add_paragraph('第二页'); d.save(p/'input.docx')
r=Presentation()
for title in ['中文首页', '中文第二页']:
 s=r.slides.add_slide(r.slide_layouts[0]); s.shapes.title.text=title
r.save(p/'input.pptx')
w=Workbook(); w.active.title='计划'; w.active.append(['中文任务', '分钟']); w.active.append(['复盘', 5]); w.create_sheet('合计').append(['合计', '=SUM(计划!B2:B2)']); w.save(p/'input.xlsx')`,
          root,
        ],
        { timeout: 30000 },
      );
      await pdf(2);
      expect(JSON.stringify(await readDocument(path.join(root, 'input.docx')))).toContain(
        '中文验收正文',
      );
      expect(JSON.stringify(await readDocument(path.join(root, 'input.xlsx')))).toContain('复盘');
      for (const name of ['input.docx', 'input.pptx', 'input.xlsx', 'input.pdf']) {
        await register(name);
        const result = await previews.describe(name);
        expect(result.artifactId).toBe(name);
        expect(result.pages).toHaveLength(2);
        if (name.endsWith('.xlsx'))
          expect(result.pages.map((page) => page.label).join(' ')).toContain('计划');
        for (const page of result.pages) {
          const image = await previews.page(name, page.index);
          expect(Buffer.from(image.data, 'base64').subarray(0, 8)).toEqual(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          );
          expect(page.width).toBeGreaterThan(0);
        }
        expect(await previews.describe(name)).toEqual(result);
      }
      expect(artifacts.size).toBe(4);
      expect(await readdir(root)).toEqual([
        'app-data',
        'input.docx',
        'input.pdf',
        'input.pptx',
        'input.xlsx',
      ]);
      await expect(previews.describe('other')).rejects.toThrow('成果不存在');
      await expect(previews.page('input.pdf', 3)).rejects.toThrow('范围');
    }, 180000);

    it('renders beyond forty pages and closes pending conversion work', async () => {
      const id = await pdf(41);
      expect((await previews.describe(id)).pages).toHaveLength(41);
      await rm(path.join(root, 'app-data', 'derived-cache'), { recursive: true, force: true });
      const pending = previews.describe(id).then(
        () => 'finished',
        () => 'cancelled',
      );
      let started = false;
      for (let attempt = 0; attempt < 200 && !started; attempt++) {
        const directory = path.join(root, 'app-data', 'derived-cache');
        const caches = await readdir(directory).catch(() => []);
        started = caches.some((cache) => existsSync(path.join(directory, cache, '.temporary')));
        if (!started) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(started).toBe(true);
      await previews.close();
      expect(await pending).toBe('cancelled');
      await expect(previews.describe(id)).rejects.toThrow();
    }, 180000);
  },
);
