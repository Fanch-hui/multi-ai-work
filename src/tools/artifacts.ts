import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { workspaceRuntimeRoot } from './office-runtime.js';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { ToolExecutionContext } from '../domain/tools.js';
import { ensureParent } from './paths.js';
import { approveFileChange, existingVersion, filePath, fileVersion } from './file-policy.js';

export interface ArtifactInput {
  path: string; format: 'markdown' | 'docx' | 'xlsx' | 'pdf'; content?: string; title?: string;
  sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
  purpose?: 'deliverable' | 'intermediate';
}

export async function createArtifact(input: ArtifactInput, context: ToolExecutionContext): Promise<unknown> {
  const extensions = { markdown: '.md', docx: '.docx', xlsx: '.xlsx', pdf: '.pdf' };
  if (path.extname(input.path).toLowerCase() !== extensions[input.format]) throw new Error('文件扩展名与成果格式不一致');
  const target = await filePath(input.path, context, true);
  const previous = await existingVersion(target, context);
  const content = input.content ?? '';
  let bytes: Uint8Array;
  if (input.format === 'docx') bytes = await word(content, input.title);
  else if (input.format === 'xlsx') bytes = await spreadsheet(input.sheets ?? []);
  else if (input.format === 'pdf') bytes = await pdf(content, input.title);
  else bytes = Buffer.from(input.title ? `# ${input.title}\n\n${content}` : content);
  if (previous) await approveFileChange(target, previous, 'write_artifact', context);
  context.signal.throwIfAborted();
  if (await filePath(target, context, true) !== target) throw new Error('目标路径已变化，请重新读取');
  await ensureParent(target);
  context.markDispatched?.();
  await writeFile(target, bytes, { flag: previous ? 'w' : 'wx' });
  const stored = await readFile(target);
  const version = fileVersion(stored);
  context.observeFile?.(target, version);
  const mimeTypes = { markdown: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
  return context.registerArtifact({ name: path.basename(target), path: target, workingPath: target, mimeType: mimeTypes[input.format],
    sha256: version, size: stored.length,
    taskId: context.task.id, botId: context.botId, conversationId: context.conversation.id,
    source: 'write_artifact', purpose: input.purpose ?? 'deliverable' });
}

async function word(content: string, title?: string): Promise<Uint8Array> {
  const children = content.split('\n').map(line => new Paragraph({ text: line.replace(/^#{1,6}\s/, ''), heading: line.startsWith('# ') ? HeadingLevel.HEADING_1 : undefined }));
  if (title) children.unshift(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

async function spreadsheet(sheets: NonNullable<ArtifactInput['sheets']>): Promise<Uint8Array> {
  if (!sheets.length) throw new Error('XLSX 至少需要一个工作表');
  const workbook = new ExcelJS.Workbook();
  for (const input of sheets) {
    const sheet = workbook.addWorksheet(input.name);
    sheet.addRows(input.rows);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns.forEach(column => { column.width = 24; });
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function findChineseFont(): Promise<Uint8Array> {
  const systemCandidates = process.platform === 'win32'
    ? ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc']
    : ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/System/Library/Fonts/PingFang.ttc',
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'];
  const candidates = [path.join(workspaceRuntimeRoot(), 'fonts', 'NotoSansCJKsc-Regular.otf'), ...systemCandidates];
  for (const candidate of candidates) {
    try { await access(candidate); return new Uint8Array(await readFile(candidate)); } catch { /* Try the next installed font. */ }
  }
  throw new Error('PDF 中文输出需要已安装的中文字体');
}

async function pdf(content: string, title?: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const text = title ? `${title}\n\n${content}` : content;
  // fontkit returns a collection for TTC; pdf-lib needs the concrete font face.
  document.registerFontkit({ ...fontkit, create: (bytes: Uint8Array) => {
    const result = fontkit.create(bytes) as unknown as { fonts?: unknown[] };
    return result.fonts?.[0] ?? result;
  } } as typeof fontkit);
  const font = /[^\u0009\u000a\u000d\u0020-\u007e]/.test(text)
    ? await document.embedFont(await findChineseFont(), { subset: true })
    : await document.embedFont(StandardFonts.Helvetica);
  let page = document.addPage([595.28, 841.89]);
  let y = 793;
  const draw = (line: string) => {
    if (y < 48) { page = document.addPage([595.28, 841.89]); y = 793; }
    if (line) page.drawText(line, { x: 48, y, size: 11, font });
    y -= 18;
  };
  for (const paragraph of text.replace(/\t/g, '    ').replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (font.widthOfTextAtSize(line + char, 11) > 499) { draw(line); line = ''; }
      line += char;
    }
    draw(line);
  }
  return document.save();
}
