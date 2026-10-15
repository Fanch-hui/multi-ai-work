import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { ToolExecutionContext } from '../domain/tools.js';
import { credentialFileNames, excludedFromScan, filePath, scanExclusions } from './file-policy.js';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
type Page = { path: string; offset: number; limit: number };
type Search = Page & { query: string; regex: boolean; glob?: string; contextLines: number };
const privateGlobs = [...credentialFileNames, '.env*', 'credentials*', 'secret*', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '*.pem', '*.p12', '*.pfx', '*.key'];

function paginate<T>(items: T[], offset: number, limit: number) {
  return { items: items.slice(offset, offset + limit), offset, nextOffset: offset + limit < items.length ? offset + limit : null, total: items.length };
}

async function directory(input: string, context: ToolExecutionContext): Promise<string> {
  const target = await filePath(input, context);
  if (!(await stat(target)).isDirectory()) throw new Error('目标不是目录');
  return target;
}

async function visiblePath(target: string, context: ToolExecutionContext): Promise<string | undefined> {
  const root = await realpath(context.workspace.path);
  if (excludedFromScan(path.relative(root, target))) return undefined;
  try { return await filePath(target, context); } catch { return undefined; }
}

async function ignoreRules(root: string, target: string, context: ToolExecutionContext) {
  const rules: { base: string; matcher: ReturnType<typeof ignore> }[] = [];
  let current = root;
  const directories = [root];
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); directories.push(current);
  }
  for (const base of directories) {
    const matcher = ignore();
    for (const name of ['.gitignore', '.ignore', '.rgignore']) {
      try { matcher.add(await readFile(await filePath(path.join(base, name), context, true), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rules.push({ base, matcher });
  }
  return rules;
}

export async function listDirectory(input: Page, context: ToolExecutionContext): Promise<unknown> {
  const target = await directory(input.path, context);
  const root = await realpath(context.workspace.path);
  const rules = await ignoreRules(root, target, context);
  const entries: { path: string; name: string; type: string; size: number }[] = [];
  for (const item of await readdir(target, { withFileTypes: true })) {
    const candidate = path.join(target, item.name);
    const canonical = await visiblePath(candidate, context);
    if (!canonical) continue;
    const info = await stat(canonical);
    let ignored = false;
    for (const rule of rules) {
      const relative = path.relative(rule.base, candidate).split(path.sep).join('/') + (info.isDirectory() ? '/' : '');
      const verdict = rule.matcher.test(relative);
      if (verdict.ignored || verdict.unignored) ignored = verdict.ignored;
    }
    if (ignored) continue;
    entries.push({ path: path.relative(root, candidate).split(path.sep).join('/'), name: item.name,
      type: item.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', size: info.size });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { path: target, ...paginate(entries, input.offset, input.limit) };
}

async function ripgrep(args: string[], cwd: string, context: ToolExecutionContext): Promise<string> {
  const { rgPath } = require('@vscode/ripgrep') as { rgPath: string };
  const executable = rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const excluded = [...scanExclusions.map(name => `!**/${name}/**`), ...privateGlobs.map(name => `!**/${name}`)];
  try {
    const { stdout } = await executeFile(executable, ['--hidden', '--no-require-git', ...excluded.flatMap(glob => ['--iglob', glob]), ...args],
      { cwd, signal: context.signal, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
    return stdout;
  } catch (error) {
    const result = error as Omit<NodeJS.ErrnoException, 'code'> & { stdout?: string; stderr?: string; code?: string | number };
    if (result.code === 1) return result.stdout ?? '';
    if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('搜索结果过多，请缩小目录或搜索条件');
    context.signal.throwIfAborted();
    throw new Error(`文件搜索失败：${result.stderr?.trim().slice(0, 1000) || result.message}`);
  }
}

export async function findFiles(input: Page & { pattern: string }, context: ToolExecutionContext): Promise<unknown> {
  const target = await directory(input.path, context);
  const root = await realpath(context.workspace.path);
  const output = await ripgrep(['--files', '--null', '.'], target, context);
  const matches: { path: string }[] = [];
  for (const relative of output.split('\0').filter(Boolean)) {
    if (!matchesPattern(relative, input.pattern)) continue;
    const candidate = path.resolve(target, relative);
    if (await visiblePath(candidate, context)) matches.push({ path: path.relative(root, candidate).split(path.sep).join('/') });
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return { path: target, ...paginate(matches, input.offset, input.limit) };
}

function matchesPattern(relative: string, pattern: string): boolean {
  const normalized = relative.split(path.sep).join('/').replace(/^\.\//, '');
  return path.matchesGlob(normalized, pattern) || (!pattern.includes('/') && path.matchesGlob(path.basename(normalized), pattern));
}

type EventData = { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
export async function searchText(input: Search, context: ToolExecutionContext): Promise<unknown> {
  const target = await directory(input.path, context);
  const root = await realpath(context.workspace.path);
  const options = ['--json', '--context', String(input.contextLines), '--max-columns', '2000'];
  if (!input.regex) options.push('--fixed-strings');
  const output = await ripgrep([...options, '--', input.query, '.'], target, context);
  const files = new Map<string, { canonical: string; lines: Map<number, string>; matches: number[] }>();
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as { type: string; data: EventData };
    if (event.type !== 'match' && event.type !== 'context') continue;
    const data = event.data;
    if (!data.path?.text || !data.line_number || data.lines?.text === undefined) continue;
    if (input.glob && !matchesPattern(data.path.text, input.glob)) continue;
    const candidate = path.resolve(target, data.path.text);
    let record = files.get(candidate);
    if (!record) {
      const canonical = await visiblePath(candidate, context);
      if (!canonical) continue;
      record = { canonical, lines: new Map(), matches: [] }; files.set(candidate, record);
    }
    record.lines.set(data.line_number, data.lines.text.replace(/\r?\n$/, ''));
    if (event.type === 'match') record.matches.push(data.line_number);
  }
  const matches = [...files].flatMap(([candidate, record]) => record.matches.map(number => ({
    path: path.relative(root, candidate).split(path.sep).join('/'), line: number, text: record.lines.get(number),
    context: [...record.lines].filter(([line]) => line >= number - input.contextLines && line <= number + input.contextLines)
      .map(([line, text]) => ({ line, text }))
  })));
  return { path: target, ...paginate(matches, input.offset, input.limit) };
}
