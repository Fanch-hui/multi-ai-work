import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { createFileTools } from '../src/tools/files.js';

const tools = createFileTools();
type Name = keyof typeof tools;
function context(directory: string) {
  const observed = new Map<string, string>(),
    owned = new Map<string, string>();
  const ctx = {
    task: { id: 'task' },
    workspace: { path: directory, writable: true },
    signal: new AbortController().signal,
    getObservedFileVersion: (file: string) => observed.get(file),
    observeFile: (file: string, version: string) => observed.set(file, version),
    ownsFile: (file: string, version: string) => owned.get(file) === version,
    requestApproval: async () => false,
  } as unknown as ToolExecutionContext;
  return {
    ctx,
    async execute(name: Name, input: Record<string, unknown>): Promise<any> {
      const tool = tools[name];
      const result = (await tool.execute(tool.schema.parse(input) as any, ctx)) as any;
      if (['write_file', 'edit_file'].includes(name)) owned.set(result.path, result.version);
      return result;
    },
  };
}

describe('file discovery and editing', () => {
  let directory: string, outside: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'team-file-tools-'));
    outside = await mkdtemp(path.join(tmpdir(), 'team-file-outside-'));
  });
  afterEach(async () => {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('reads stable line ranges and hashes the complete file', async () => {
    await writeFile(path.join(directory, 'notes.txt'), 'one\r\ntwo\r\nthree\n');
    const { execute } = context(directory);
    const first = await execute('read_file', { path: 'notes.txt', offset: 2, limit: 1 });
    expect(first).toMatchObject({
      text: 'two',
      content: 'two',
      offset: 2,
      endLine: 2,
      nextOffset: 3,
      totalLines: 3,
      truncated: true,
    });
    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    const last = await execute('read_file', { path: 'notes.txt', offset: first.nextOffset });
    expect(last).toMatchObject({
      content: 'three',
      nextOffset: null,
      truncated: false,
      version: first.version,
    });
  });

  it('rejects traversal, symlink escapes and credentials', async () => {
    const { execute } = context(directory);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(outside, path.join(directory, 'escape'));
    await symlink(path.join(outside, 'missing.txt'), path.join(directory, 'dangling.txt'));
    await expect(execute('read_file', { path: '../private.txt' })).rejects.toThrow('授权');
    await expect(execute('write_file', { path: 'escape/new.txt', content: 'x' })).rejects.toThrow(
      '符号链接',
    );
    await expect(execute('write_file', { path: 'dangling.txt', content: 'x' })).rejects.toThrow(
      '符号链接',
    );
    await writeFile(path.join(directory, '.env'), 'not returned');
    await expect(execute('read_file', { path: '.env' })).rejects.toThrow('凭据');
    const list = await execute('list_directory', {});
    expect(list.items).toEqual([]);
  });

  it('lists paginated entries and respects inherited ignore rules', async () => {
    await mkdir(path.join(directory, 'docs'));
    await mkdir(path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, '.gitignore'), '*.tmp\ndocs/hidden.txt\n');
    await writeFile(path.join(directory, 'a.txt'), 'a');
    await writeFile(path.join(directory, 'b.tmp'), 'ignored');
    await writeFile(path.join(directory, 'docs', 'hidden.txt'), 'ignored');
    await writeFile(path.join(directory, 'docs', 'visible.txt'), 'visible');
    const { execute } = context(directory);
    const first = await execute('list_directory', { limit: 1 });
    expect(first).toMatchObject({ nextOffset: 1, total: 3 });
    expect(first.items).toHaveLength(1);
    const docs = await execute('list_directory', { path: 'docs' });
    expect(docs.items.map((item: any) => item.path)).toEqual(['docs/visible.txt']);
  });

  it('blocks known credential files from reads, writes and discovery', async () => {
    const { execute } = context(directory);
    const names = ['.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials'];
    for (const name of names) {
      await expect(execute('write_file', { path: name, content: 'synthetic' })).rejects.toThrow(
        '凭据',
      );
      await writeFile(path.join(directory, name), 'synthetic');
      await expect(execute('read_file', { path: name })).rejects.toThrow('凭据');
    }
    expect((await execute('list_directory', {})).items).toEqual([]);
    expect((await execute('find_files', { pattern: '**/*' })).items).toEqual([]);
    expect((await execute('search_text', { query: 'synthetic' })).items).toEqual([]);
  });

  it('keeps ordinary dotfiles, project configuration and databases writable', async () => {
    const { execute } = context(directory);
    for (const name of [
      '.editorconfig',
      '.vscode/settings.json',
      '.git/config',
      '.husky/pre-commit',
      'app.sqlite',
    ]) {
      const created = await execute('write_file', { path: name, content: 'project-content' });
      expect(created.created).toBe(true);
      expect((await execute('read_file', { path: name })).text).toBe('project-content');
    }
  });

  it('uses the real workspace root for symlink workspaces and blocks sensitive targets', async () => {
    const realRoot = path.join(outside, '.aws', 'project');
    const alias = path.join(directory, 'workspace');
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, alias, 'junction');
    await writeFile(path.join(realRoot, 'notes.txt'), 'ordinary');
    await writeFile(path.join(realRoot, '.netrc'), 'synthetic');
    await symlink(path.join(realRoot, '.netrc'), path.join(realRoot, 'alias.txt'));
    const { execute } = context(alias);
    expect((await execute('read_file', { path: 'notes.txt' })).text).toBe('ordinary');
    await expect(execute('read_file', { path: '.netrc' })).rejects.toThrow('凭据');
    await expect(execute('read_file', { path: 'alias.txt' })).rejects.toThrow('凭据');
  });

  it('finds glob files and searches literal or regex text with line context', async () => {
    await mkdir(path.join(directory, 'docs'));
    await writeFile(path.join(directory, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(directory, 'ignored.txt'), 'find.me');
    await writeFile(path.join(directory, '.env'), 'find.me');
    await writeFile(path.join(directory, 'docs', 'a.txt'), 'before\nfind.me\nafter\nfindXme');
    await writeFile(path.join(directory, 'docs', 'b.md'), 'find.me');
    const { execute } = context(directory);
    const files = await execute('find_files', { pattern: '*.txt' });
    expect(files.items).toEqual([{ path: 'docs/a.txt' }]);
    const recursive = await execute('find_files', { path: 'docs', pattern: '**/*' });
    expect(recursive.items).toEqual([{ path: 'docs/a.txt' }, { path: 'docs/b.md' }]);
    const literal = await execute('search_text', { query: 'find.me', glob: '*.txt' });
    expect(literal.items).toEqual([
      {
        path: 'docs/a.txt',
        line: 2,
        text: 'find.me',
        context: [
          { line: 1, text: 'before' },
          { line: 2, text: 'find.me' },
          { line: 3, text: 'after' },
        ],
      },
    ]);
    const regex = await execute('search_text', {
      query: 'find.me',
      regex: true,
      glob: '*.txt',
      limit: 1,
    });
    expect(regex).toMatchObject({ total: 2, nextOffset: 1 });
  });

  it('creates text and updates task-owned unchanged files without approval', async () => {
    const { execute } = context(directory);
    const created = await execute('write_file', {
      path: 'output/data.json',
      content: '{"count":1}',
    });
    expect(created).toMatchObject({ created: true, previousVersion: null });
    expect(await readFile(created.path, 'utf8')).toBe('{"count":1}');
    const edited = await execute('edit_file', {
      path: 'output/data.json',
      oldText: '1',
      newText: '2',
    });
    expect(edited).toMatchObject({ replacements: 1, previousVersion: created.version });
    await execute('write_file', { path: 'output/data.json', content: '{"count":3}' });
    expect(await readFile(created.path, 'utf8')).toBe('{"count":3}');
  });

  it('requires observation and approval before overwriting user files', async () => {
    await writeFile(path.join(directory, 'original.txt'), 'original');
    const { ctx, execute } = context(directory);
    await expect(
      execute('write_file', { path: 'original.txt', content: 'changed' }),
    ).rejects.toThrow('先读取');
    await execute('read_file', { path: 'original.txt' });
    await expect(
      execute('edit_file', { path: 'original.txt', oldText: 'original', newText: 'changed' }),
    ).rejects.toThrow('批准');
    expect(await readFile(path.join(directory, 'original.txt'), 'utf8')).toBe('original');
    ctx.requestApproval = async () => true;
    await execute('edit_file', { path: 'original.txt', oldText: 'original', newText: 'changed' });
    expect(await readFile(path.join(directory, 'original.txt'), 'utf8')).toBe('changed');
  });

  it('rejects ambiguous replacements unless replaceAll is explicit', async () => {
    const { execute } = context(directory);
    await execute('write_file', { path: 'repeated.txt', content: 'a a' });
    await expect(
      execute('edit_file', { path: 'repeated.txt', oldText: 'a', newText: 'b' }),
    ).rejects.toThrow('多处');
    const result = await execute('edit_file', {
      path: 'repeated.txt',
      oldText: 'a',
      newText: 'b',
      replaceAll: true,
    });
    expect(result.replacements).toBe(2);
    expect(await readFile(result.path, 'utf8')).toBe('b b');
  });

  it('rejects versions changed before or during approval', async () => {
    const { ctx, execute } = context(directory);
    const target = path.join(directory, 'original.txt');
    await writeFile(target, 'one');
    await execute('read_file', { path: 'original.txt' });
    await writeFile(target, 'two');
    await expect(
      execute('edit_file', { path: 'original.txt', oldText: 'two', newText: 'three' }),
    ).rejects.toThrow('版本');
    await execute('read_file', { path: 'original.txt' });
    ctx.requestApproval = async () => {
      await writeFile(target, 'external');
      return true;
    };
    await expect(execute('write_file', { path: 'original.txt', content: 'three' })).rejects.toThrow(
      '版本',
    );
    expect(await readFile(target, 'utf8')).toBe('external');
  });

  it('filters out-of-bounds symlinks and preserves stable candidate order under concurrent validation', async () => {
    await writeFile(path.join(outside, 'escaped.txt'), 'needle-content\n');
    await writeFile(path.join(directory, '.env'), 'needle-content\n');
    const expectedPaths: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const name = `item-${String(i).padStart(2, '0')}.txt`;
      expectedPaths.push(name);
      await writeFile(path.join(directory, name), `header\nneedle-content-${i}\n`);
    }
    await symlink(path.join(outside, 'escaped.txt'), path.join(directory, 'item-00-escape.txt'));
    await symlink(outside, path.join(directory, 'escape-dir'));
    await symlink(path.join(directory, '.env'), path.join(directory, 'item-10-env-alias.txt'));

    const { execute } = context(directory);
    const found1 = await execute('find_files', { pattern: '*.txt', limit: 50 });
    const found2 = await execute('find_files', { pattern: '*.txt', limit: 50 });
    expect(found1.items.map((item: { path: string }) => item.path)).toEqual(expectedPaths);
    expect(found2.items.map((item: { path: string }) => item.path)).toEqual(expectedPaths);

    const listed = await execute('list_directory', { limit: 50 });
    expect(listed.items.map((item: { path: string }) => item.path)).toEqual(expectedPaths);

    const searched = await execute('search_text', { query: 'needle-content', limit: 50 });
    expect(searched.items).toHaveLength(20);
    expect(searched.items.map((item: { path: string }) => item.path).sort()).toEqual(expectedPaths);
    expect(
      searched.items.some(
        (item: { path: string }) => item.path.includes('escape') || item.path.includes('env-alias'),
      ),
    ).toBe(false);
  });
});
