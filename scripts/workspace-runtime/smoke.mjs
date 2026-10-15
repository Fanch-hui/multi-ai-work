import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2]);
const work = path.resolve(process.argv[3]);
await mkdir(work, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8'));
if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Smoke check must execute on the target architecture');
const python = path.join(root, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
const node = path.join(root, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const options = { cwd: work, timeout: 180_000, env: { ...process.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  HOME: process.env.HOME, LANG: 'zh_CN.UTF-8', TMPDIR: work, TEMP: work, TMP: work }, encoding: 'utf8' };
const files = JSON.parse(execFileSync(python, ['-I', '-B', fileURLToPath(new URL('./smoke.py', import.meta.url)), work], options));
const results = [];
for (const [format, input] of Object.entries(files)) {
  const check = JSON.parse(execFileSync(python, ['-I', '-B', path.join(root, 'office-skills', 'scripts', 'check_office.py'), input,
    '--contains', '中文工作报告', ...(format === 'pptx' || format === 'xlsx' ? ['--count', '2'] : [])], options));
  if (check.verdict !== 'pass') throw new Error(`Structural check failed: ${format}`);
  for (const outputFormat of ['pdf', 'png', ...(format === 'xlsx' ? ['xlsx'] : [])]) {
    const outputDirectory = path.join(work, `${format}-${outputFormat}`);
    await mkdir(outputDirectory, { recursive: true });
    const reportPath = path.join(outputDirectory, 'report.json');
    execFileSync(node, [path.join(root, 'office-skills', 'scripts', 'render_document.mjs'), JSON.stringify({
      inputPath: input, outputDirectory, reportPath, format: outputFormat, dpi: 96,
      ...(outputFormat !== 'png' ? {} : format === 'xlsx' ? { sheet: '月度统计', range: 'A1:J20' } : { pages: [1] }),
    })], options);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const rendered of report.files) {
      const bytes = await readFile(rendered.path);
      const valid = outputFormat === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : outputFormat === 'xlsx'
        ? bytes.subarray(0, 2).toString() === 'PK' : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if (!valid) throw new Error(`Invalid rendered ${outputFormat}`);
      if (outputFormat === 'xlsx') execFileSync(python, ['-I', '-B', '-c',
        'import sys; from openpyxl import load_workbook; assert load_workbook(sys.argv[1], data_only=True)["月度统计"]["B4"].value == 8', rendered.path], options);
    }
    results.push({ format, output: outputFormat, backend: report.backend, count: report.files.length, missingFonts: report.missingFonts });
  }
}
const pdfWork = path.join(work, 'pdf-preview');
await mkdir(pdfWork, { recursive: true });
const pdfReport = path.join(pdfWork, 'report.json');
execFileSync(node, [path.join(root, 'office-skills', 'scripts', 'render_document.mjs'), JSON.stringify({
  inputPath: path.join(work, 'docx-pdf', 'report.pdf'), outputDirectory: pdfWork, reportPath: pdfReport, format: 'png', pages: [1], dpi: 96,
})], options);
const pdfResult = JSON.parse(await readFile(pdfReport, 'utf8'));
if (!pdfResult.files.length) throw new Error('PDF preview produced no images');
results.push({ format: 'pdf', output: 'png', backend: pdfResult.backend, count: pdfResult.files.length, missingFonts: pdfResult.missingFonts });
console.log(JSON.stringify({ versions: { python: manifest.python, node: manifest.node, kit: manifest.kit }, results }, null, 2));
