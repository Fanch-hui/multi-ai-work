import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const smokeScript = new URL('../scripts/workspace-runtime/smoke.mjs', import.meta.url).href;
const formats = [
  'docx-pdf',
  'docx-png',
  'pptx-pdf',
  'pptx-png',
  'xlsx-pdf',
  'xlsx-png',
  'xlsx-xlsx',
];
let directory: string;
let originalArgs: string[];
let emptyOutput: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  emptyOutput = undefined;
  directory = await mkdtemp(path.join(tmpdir(), 'team-runtime-smoke-'));
  const root = path.join(directory, 'runtime');
  mkdirSync(root);
  await writeFile(
    path.join(root, 'runtime.json'),
    JSON.stringify({ platform: process.platform, arch: process.arch }),
  );
  originalArgs = process.argv;
  process.argv = ['node', 'smoke.mjs', root, path.join(directory, 'work')];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    const inputs = args as string[];
    if (inputs.some((arg) => arg.endsWith('smoke.py')))
      return JSON.stringify(
        Object.fromEntries(['docx', 'pptx', 'xlsx'].map((format) => [format, `input.${format}`])),
      );
    if (inputs.some((arg) => arg.endsWith('check_office.py')))
      return JSON.stringify({ verdict: 'pass' });
    if (!inputs[0].endsWith('render_document.mjs')) return '';
    const options = JSON.parse(inputs[1]);
    const output = path.basename(options.outputDirectory);
    const target = path.join(options.outputDirectory, `report.${options.format}`);
    let bytes = Buffer.from('%PDF-fixture');
    if (options.format === 'png') bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    else if (options.format === 'xlsx') bytes = Buffer.from('PK-fixture');
    writeFileSync(target, bytes);
    writeFileSync(
      options.reportPath,
      JSON.stringify({
        backend: 'fixture',
        missingFonts: [],
        files: output === emptyOutput ? [] : [{ path: target }],
      }),
    );
    return '';
  });
});

afterEach(async () => {
  process.argv = originalArgs;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(formats)(
  'rejects an empty %s export even when the renderer exits successfully',
  async (output) => {
    emptyOutput = output;
    const [format, extension] = output.split('-');
    await expect(import(smokeScript)).rejects.toThrow(
      `${format} export produced no ${extension} files`,
    );
  },
);

it('validates every Office export and the PDF preview before reporting success', async () => {
  await import(smokeScript);
  const report = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
  expect(
    report.results.map((result: { format: string; output: string; count: number }) => ({
      format: result.format,
      output: result.output,
      count: result.count,
    })),
  ).toEqual([
    { format: 'docx', output: 'pdf', count: 1 },
    { format: 'docx', output: 'png', count: 1 },
    { format: 'pptx', output: 'pdf', count: 1 },
    { format: 'pptx', output: 'png', count: 1 },
    { format: 'xlsx', output: 'pdf', count: 1 },
    { format: 'xlsx', output: 'png', count: 1 },
    { format: 'xlsx', output: 'xlsx', count: 1 },
    { format: 'pdf', output: 'png', count: 1 },
  ]);
});
