import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const request = JSON.parse(process.argv[2]);
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = path.join(request.outputDirectory, '.temporary');
await mkdir(temporary, { recursive: true });
process.env.TMPDIR = temporary;
process.env.TEMP = temporary;
process.env.TMP = temporary;
const { createConverter } = await import(pathToFileURL(path.join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js')).href);
const maxInputBytes = (path.extname(request.inputPath).toLowerCase() === '.pdf' ? 64 : 25) * 1024 * 1024;
const converter = await createConverter({ timeoutMs: 150_000, maxInputBytes,
  maxOutputBytes: 100 * 1024 * 1024, fontDirectories: [path.join(root, 'fonts')],
  fontMetadataCacheDirectory: false });
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
try {
  let report;
  if (request.format === 'png') {
    const result = await converter.renderImages({ inputPath: request.inputPath, outputDir: path.join(request.outputDirectory, 'pages'),
      pages: request.pages, sheet: request.sheet, range: request.range, dpi: request.dpi, maxPages: request.maxPages ?? 40 }, controller.signal);
    report = { backend: result.backend, missingFonts: result.missingFonts, pageCount: result.pageCount, files: result.images };
  } else if (request.format === 'xlsx') {
    const outputPath = path.join(request.outputDirectory, `${path.basename(request.inputPath, path.extname(request.inputPath))}-recalculated.xlsx`);
    const result = await converter.recalculate({ inputPath: request.inputPath, outputPath }, controller.signal);
    report = { backend: result.backend, missingFonts: result.missingFonts, files: [{ path: outputPath }] };
  } else {
    const outputPath = path.join(request.outputDirectory, `${path.basename(request.inputPath, path.extname(request.inputPath))}.pdf`);
    const result = await converter.convert({ inputPath: request.inputPath, outputPath }, controller.signal);
    report = { backend: result.backend, missingFonts: result.missingFonts, files: [{ path: outputPath }] };
  }
  await writeFile(request.reportPath, JSON.stringify(report) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await converter.dispose();
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
}
