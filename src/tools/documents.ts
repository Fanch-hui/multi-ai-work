import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 120_000;

export async function readDocument(target: string): Promise<unknown> {
  if (!(await stat(target)).isFile()) throw new Error('目标不是普通文件');
  if ((await stat(target)).size > MAX_BYTES) throw new Error('文件超过 25 MiB 读取限制');
  const extension = path.extname(target).toLowerCase();
  if (extension === '.pdf') return readPdf(target);
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: target });
    const paragraphs = result.value.split(/\n\s*\n/).filter(Boolean);
    let remaining = MAX_TEXT;
    return {
      format: 'docx',
      paragraphs: paragraphs
        .map((text, index) => {
          const content = text.slice(0, Math.max(0, remaining));
          remaining -= content.length;
          return { paragraph: index + 1, text: content };
        })
        .filter((item) => item.text),
      truncated: result.value.length > MAX_TEXT,
    };
  }
  if (extension === '.xlsx') return readWorkbook(target);
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw new Error('不支持读取此二进制格式');
  const content = bytes.toString('utf8');
  return {
    format: 'text',
    content: content.slice(0, MAX_TEXT),
    truncated: content.length > MAX_TEXT,
  };
}

async function readPdf(target: string): Promise<unknown> {
  // Electron utility processes are not detected as Node by PDF.js; load its matching local worker explicitly.
  const worker = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  await import(pathToFileURL(worker).href);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await readFile(target)),
    useSystemFonts: true,
  });
  const document = await loading.promise;
  const pages: { page: number; text: string }[] = [];
  let remaining = MAX_TEXT;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages && remaining > 0; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
        .join('')
        .slice(0, remaining);
      remaining -= text.length;
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
    return {
      format: 'pdf',
      totalPages: document.numPages,
      pages,
      truncated: remaining <= 0,
      needsOcr: pages.every((page) => !page.text.trim()),
    };
  } finally {
    await loading.destroy();
  }
}

async function readWorkbook(target: string): Promise<unknown> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(target);
  let remaining = MAX_TEXT;
  const sheets = workbook.worksheets.map((sheet) => {
    const rows: { row: number; values: string[] }[] = [];
    sheet.eachRow((row, number) => {
      if (remaining <= 0) return;
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const text = workbookCellText(cell).slice(0, Math.max(0, remaining));
        remaining -= text.length;
        values.push(text);
      });
      rows.push({ row: number, values });
    });
    return { name: sheet.name, rows };
  });
  return { format: 'xlsx', sheets, truncated: remaining <= 0 };
}

function workbookCellText(source: ExcelJS.Cell): string {
  const cell = source.master;
  if (cell.type !== ExcelJS.ValueType.Formula) return workbookValueText(cell.value);
  // ExcelJS cell.text and cell.value drop falsy formula results; the result getter preserves them.
  return cell.result == null ? `=${cell.formula}` : workbookValueText(cell.result);
}

function workbookValueText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('hyperlink' in value)
    return value.text === value.hyperlink ? value.hyperlink : `${value.text} (${value.hyperlink})`;
  if ('error' in value) return value.error;
  return JSON.stringify(value);
}
