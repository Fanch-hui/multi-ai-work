import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { ToolExecutionContext } from '../domain/tools.js';
import {
  credentialFileNames,
  excludedFromScan,
  filePath,
  resolveCanonicalRoot,
  scanExclusions,
  sensitivePath,
  validateExistingWorkspaceCandidate,
} from './file-policy.js';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const SEARCH_VALIDATION_CONCURRENCY = 8;
const CASE_INSENSITIVE_GLOBS = path.matchesGlob('file.TXT', '*.txt');
type Page = { path: string; offset: number; limit: number };
type Search = Page & { query: string; regex: boolean; glob?: string; contextLines: number };
const privateGlobs = [
  ...credentialFileNames,
  '.env*',
  'credentials*',
  'secret*',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '*.pem',
  '*.p12',
  '*.pfx',
  '*.key',
];

function paginate<T>(items: T[], offset: number, limit: number) {
  return {
    items: items.slice(offset, offset + limit),
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    total: items.length,
  };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        results[current] = await mapper(items[current], current);
      }
    }),
  );
  return results;
}

async function directory(
  input: string,
  context: ToolExecutionContext,
  rootReal?: string,
): Promise<string> {
  const target = await filePath(input, context, false, rootReal);
  if (!(await stat(target)).isDirectory()) throw new Error('目标不是目录');
  return target;
}

async function visiblePath(
  target: string,
  context: ToolExecutionContext,
  root: string,
): Promise<string | undefined> {
  if (excludedFromScan(path.relative(root, target))) return undefined;
  try {
    const canonical = await validateExistingWorkspaceCandidate(
      root,
      context.workspace.path,
      target,
    );
    if (sensitivePath(path.relative(root, canonical))) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

async function ignoreRules(root: string, target: string, context: ToolExecutionContext) {
  const rules: { base: string; matcher: ReturnType<typeof ignore> }[] = [];
  let current = root;
  const directories = [root];
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    directories.push(current);
  }
  for (const base of directories) {
    const matcher = ignore();
    for (const name of ['.gitignore', '.ignore', '.rgignore']) {
      try {
        matcher.add(
          await readFile(await filePath(path.join(base, name), context, true, root), 'utf8'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    rules.push({ base, matcher });
  }
  return rules;
}

export async function listDirectory(input: Page, context: ToolExecutionContext): Promise<unknown> {
  const root = await resolveCanonicalRoot(context.workspace.path);
  const target = await directory(input.path, context, root);
  const rules = await ignoreRules(root, target, context);
  const items = await readdir(target, { withFileTypes: true });
  const checked = await mapConcurrent(items, SEARCH_VALIDATION_CONCURRENCY, async (item) => {
    const candidate = path.join(target, item.name);
    const canonical = await visiblePath(candidate, context, root);
    if (!canonical) return undefined;
    const info = await stat(canonical);
    let ignored = false;
    for (const rule of rules) {
      const relative =
        path.relative(rule.base, candidate).split(path.sep).join('/') +
        (info.isDirectory() ? '/' : '');
      const verdict = rule.matcher.test(relative);
      if (verdict.ignored || verdict.unignored) ignored = verdict.ignored;
    }
    if (ignored) return undefined;
    return {
      path: path.relative(root, candidate).split(path.sep).join('/'),
      name: item.name,
      type: item.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
      size: info.size,
    };
  });
  const entries = checked.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== undefined,
  );
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { path: target, ...paginate(entries, input.offset, input.limit) };
}

async function ripgrep(
  args: string[],
  cwd: string,
  context: ToolExecutionContext,
): Promise<string> {
  const { rgPath } = require('@vscode/ripgrep') as { rgPath: string };
  const executable = rgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const excluded = [
    ...scanExclusions.map((name) => `!**/${name}/**`),
    ...privateGlobs.map((name) => `!**/${name}`),
  ];
  try {
    const { stdout } = await executeFile(
      executable,
      ['--hidden', '--no-require-git', ...excluded.flatMap((glob) => ['--iglob', glob]), ...args],
      {
        cwd,
        signal: context.signal,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    return stdout;
  } catch (error) {
    const result = error as Omit<NodeJS.ErrnoException, 'code'> & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    if (result.code === 1) return result.stdout ?? '';
    if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new Error('搜索结果过多，请缩小目录或搜索条件');
    context.signal.throwIfAborted();
    throw new Error(`文件搜索失败：${result.stderr?.trim().slice(0, 1000) || result.message}`);
  }
}

export async function findFiles(
  input: Page & { pattern: string },
  context: ToolExecutionContext,
): Promise<unknown> {
  const root = await resolveCanonicalRoot(context.workspace.path);
  const target = await directory(input.path, context, root);
  const output = await ripgrep(
    ['--files', '--null', ...patternFilter(input.pattern), '.'],
    target,
    context,
  );
  const candidates = output
    .split('\0')
    .filter((relative) => Boolean(relative) && matchesPattern(relative, input.pattern));
  const validated = await mapConcurrent(
    candidates,
    SEARCH_VALIDATION_CONCURRENCY,
    async (relative) => {
      const candidate = path.resolve(target, relative);
      if (!(await visiblePath(candidate, context, root))) return undefined;
      return { path: path.relative(root, candidate).split(path.sep).join('/') };
    },
  );
  const matches = validated.filter((item): item is { path: string } => item !== undefined);
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return { path: target, ...paginate(matches, input.offset, input.limit) };
}

function matchesPattern(relative: string, pattern: string): boolean {
  const normalized = relative.split(path.sep).join('/').replace(/^\.\//, '');
  return (
    path.matchesGlob(normalized, pattern) ||
    (!pattern.includes('/') && path.matchesGlob(path.basename(normalized), pattern))
  );
}

function patternFilter(pattern?: string): string[] {
  if (!pattern || !/^[\w./*? -]+$/.test(pattern)) return [];
  let basename = pattern.split('/').at(-1)!;
  if (!basename || basename === '*' || basename.includes('**')) return [];
  if (CASE_INSENSITIVE_GLOBS)
    basename = basename.replace(
      /[a-z]/gi,
      (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`,
    );
  // Type filters preserve ignore rules; positive --glob filters would override them.
  // Keep path.matchesGlob as the authority for path components and richer patterns.
  return ['--type-add', `appsearch:${basename}`, '--type', 'appsearch'];
}

type EventData = { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
export async function searchText(input: Search, context: ToolExecutionContext): Promise<unknown> {
  const root = await resolveCanonicalRoot(context.workspace.path);
  const target = await directory(input.path, context, root);
  const options = [
    '--json',
    '--context',
    String(input.contextLines),
    '--max-columns',
    '2000',
    ...patternFilter(input.glob),
  ];
  if (!input.regex) options.push('--fixed-strings');
  const output = await ripgrep([...options, '--', input.query, '.'], target, context);
  const pendingFiles = new Map<string, { lines: Map<number, string>; matches: number[] }>();
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as { type: string; data: EventData };
    if (event.type !== 'match' && event.type !== 'context') continue;
    const data = event.data;
    if (!data.path?.text || !data.line_number || data.lines?.text === undefined) continue;
    if (input.glob && !matchesPattern(data.path.text, input.glob)) continue;
    const candidate = path.resolve(target, data.path.text);
    let record = pendingFiles.get(candidate);
    if (!record) {
      record = { lines: new Map(), matches: [] };
      pendingFiles.set(candidate, record);
    }
    record.lines.set(data.line_number, data.lines.text.replace(/\r?\n$/, ''));
    if (event.type === 'match') record.matches.push(data.line_number);
  }
  const validatedEntries = await mapConcurrent(
    [...pendingFiles.entries()],
    SEARCH_VALIDATION_CONCURRENCY,
    async ([candidate, record]) => {
      const canonical = await visiblePath(candidate, context, root);
      if (!canonical) return undefined;
      return [candidate, record] as const;
    },
  );
  const matches = validatedEntries
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .flatMap(([candidate, record]) =>
      record.matches.map((number) => ({
        path: path.relative(root, candidate).split(path.sep).join('/'),
        line: number,
        text: record.lines.get(number),
        context: [...record.lines]
          .filter(
            ([line]) => line >= number - input.contextLines && line <= number + input.contextLines,
          )
          .map(([line, text]) => ({ line, text })),
      })),
    );
  return { path: target, ...paginate(matches, input.offset, input.limit) };
}
