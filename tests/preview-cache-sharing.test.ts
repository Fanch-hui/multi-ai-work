import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import { ArtifactPreviews } from '../src/core/artifact-preview.js';
import { maintainDerivedCache } from '../src/tools/derived-cache.js';
import { loadWorkspaceDependencies } from '../src/tools/office-runtime.js';
import { startCommand } from '../src/tools/process-runner.js';

vi.mock('../src/tools/office-runtime.js', () => ({ loadWorkspaceDependencies: vi.fn() }));
vi.mock('../src/tools/process-runner.js', () => ({ startCommand: vi.fn() }));

describe('shared document previews', () => {
  let directory: string;
  let previews: ArtifactPreviews;
  let dataDirectory: string;
  const artifacts = new Map<string, Artifact>();
  const metadata = new Map<string, unknown>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'preview-sharing-'));
    dataDirectory = path.join(directory, 'data');
    artifacts.clear();
    metadata.clear();
    const renderScript = path.join(directory, 'renderer.js');
    await writeFile(renderScript, 'renderer-version-1');
    vi.mocked(loadWorkspaceDependencies).mockResolvedValue({
      renderScript,
      node: process.execPath,
    } as any);
    vi.mocked(startCommand).mockClear();
    vi.mocked(startCommand).mockImplementation(
      (request) =>
        ({
          done: (async () => {
            const args = JSON.parse(request.args![1]);
            const target = path.join(args.outputDirectory, 'page.png');
            await writeFile(target, 'rendered-page');
            await writeFile(
              args.reportPath,
              JSON.stringify({
                files: [{ path: target, width: 100, height: 200, page: 1 }],
                missingFonts: [],
              }),
            );
            return { status: 'completed' };
          })(),
        }) as any,
    );
    previews = new ArtifactPreviews({
      dataDirectory,
      storage: {
        get: (_collection: string, id: string) => artifacts.get(id),
        metadata: (key: string) => metadata.get(key),
        setMetadata: (key: string, value: unknown) => metadata.set(key, value),
      } as any,
    });
  });
  afterEach(async () => {
    await previews.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function register(id: string, content = 'document', extension = '.pdf') {
    const source = path.join(directory, `${id}${extension}`);
    await writeFile(source, content);
    artifacts.set(id, {
      id,
      path: source,
      name: id,
      mimeType: 'application/octet-stream',
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      conversationId: 'conversation',
      createdAt: '',
    } satisfies Artifact);
  }

  it('shares identical content and keeps shared pages after removing one artifact mapping', async () => {
    await register('first');
    await register('second');
    await Promise.all([previews.describe('first'), previews.describe('second')]);
    expect(startCommand).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(dataDirectory, 'derived-cache'))).toHaveLength(1);
    expect(metadata.get('artifact-preview:first')).toBe(metadata.get('artifact-preview:second'));
    await previews.remove('first');
    expect(metadata.get('artifact-preview:first')).toBeNull();
    expect(Buffer.from((await previews.page('second', 1)).data, 'base64').toString()).toBe(
      'rendered-page',
    );
    expect(await readFile(artifacts.get('first')!.path, 'utf8')).toBe('document');
  });

  it('rebuilds collected previews and checks current source bytes and real extension', async () => {
    await register('first');
    await previews.describe('first');
    await maintainDerivedCache(path.join(dataDirectory, 'derived-cache'), { clear: true });
    await previews.page('first', 1);
    expect(startCommand).toHaveBeenCalledTimes(2);
    await writeFile(artifacts.get('first')!.path, 'changed');
    await previews.describe('first');
    await register('office', 'changed', '.docx');
    await previews.describe('office');
    expect(startCommand).toHaveBeenCalledTimes(4);
    await rm(artifacts.get('first')!.path);
    await expect(previews.describe('first')).rejects.toThrow();
  });
});
