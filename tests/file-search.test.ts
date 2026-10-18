import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { findFiles, searchText } from '../src/tools/file-search.js';

describe('file search prefilter', () => {
  let directory: string;
  let context: ToolExecutionContext;
  const page = { path: '.', offset: 0, limit: 100 };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'team-file-search-'));
    context = { workspace: { path: directory }, signal: new AbortController().signal } as ToolExecutionContext;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(['*.txt', '**/*.txt', 'docs/*.txt', 'docs/**/*.txt', 'a.txt', 'docs/a.txt', 'a.???', '{a,b}.txt', '@(a|b).txt', '[ab].txt'])(
    'preserves existing path and basename matching for %s', async pattern => {
      const files = ['a.txt', 'b.txt', 'upper.TXT', 'docs/a.txt', 'docs/deep/b.txt', 'docs/notes.md'];
      await mkdir(path.join(directory, 'docs', 'deep'), { recursive: true });
      await Promise.all(files.map(name => writeFile(path.join(directory, name), 'needle\n')));
      const expected = files.filter(name => path.matchesGlob(name, pattern)
        || (!pattern.includes('/') && path.matchesGlob(path.basename(name), pattern))).sort((a, b) => a.localeCompare(b));
      const found = await findFiles({ ...page, pattern }, context) as { items: { path: string }[]; total: number };
      expect(found.items.map(item => item.path)).toEqual(expected);
      const searched = await searchText({ ...page, query: 'needle', regex: false, glob: pattern, contextLines: 0 }, context) as typeof found;
      expect(searched.items.map(item => item.path).sort((a, b) => a.localeCompare(b))).toEqual(expected);
      expect(searched.total).toBe(expected.length);
    }
  );

  it('respects inherited and nested ignore rules with filename filters and scoped searches', async () => {
    await mkdir(path.join(directory, 'docs'));
    await writeFile(path.join(directory, '.gitignore'), '*.txt\n!docs/\n!docs/keep.txt\n!docs/local.txt\n');
    await writeFile(path.join(directory, 'docs', '.ignore'), 'local.txt\n');
    await Promise.all(['hidden.txt', 'docs/hidden.txt', 'docs/keep.txt', 'docs/local.txt'].map(name => writeFile(path.join(directory, name), 'needle\n')));
    const scoped = { ...page, path: 'docs' };
    const found = await findFiles({ ...scoped, pattern: '*.txt' }, context) as { items: unknown[] };
    expect(found.items).toEqual([{ path: 'docs/keep.txt' }]);
    const searched = await searchText({ ...scoped, query: 'needle', regex: false, glob: '*.txt', contextLines: 0 }, context) as { items: { path: string }[] };
    expect(searched.items.map(item => item.path)).toEqual(['docs/keep.txt']);
  });

  it('skips unmatched file contents before scanning and preserves pagination and line context', async () => {
    await writeFile(path.join(directory, 'large.log'), 'needle\n'.repeat(60_000));
    await writeFile(path.join(directory, 'notes.txt'), 'before\nneedle one\nafter\nneedle two\n');
    const input = { ...page, query: 'needle', regex: false, contextLines: 1, limit: 1 };
    await expect(searchText(input, context)).rejects.toThrow('搜索结果过多');
    const result = await searchText({ ...input, glob: '*.txt' }, context);
    expect(result).toMatchObject({ total: 2, nextOffset: 1, items: [{ path: 'notes.txt', line: 2, text: 'needle one', context: [
      { line: 1, text: 'before' }, { line: 2, text: 'needle one' }, { line: 3, text: 'after' }
    ] }] });
    expect(await searchText({ ...input, glob: '*.txt', offset: 1 }, context)).toMatchObject({ total: 2, nextOffset: null, items: [{ line: 4, text: 'needle two' }] });
  });

  it('honors cancellation with a filename filter', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchText({ ...page, query: 'needle', regex: false, glob: '*.txt', contextLines: 0 }, { ...context, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
