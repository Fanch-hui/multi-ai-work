import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { readDocument } from '../src/tools/documents.js';

type WorkbookDocument = { sheets: { name: string; rows: { row: number; values: string[] }[] }[] };

describe('workbook document reading', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'document-workbook-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function readWorkbook(workbook: ExcelJS.Workbook) {
    const target = path.join(root, 'input.xlsx');
    await workbook.xlsx.writeFile(target);
    const original = await readFile(target);
    const result = await readDocument(target) as WorkbookDocument;
    expect(await readFile(target)).toEqual(original);
    return result.sheets[0].rows;
  }

  it('preserves zero and false cached formula results alongside blank cells and errors', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('缓存');
    sheet.addRow([
      { formula: '1-1', result: 0 }, null,
      { formula: '1=2', result: false }, false, 0,
      { formula: '1/0', result: { error: '#DIV/0!' } },
      { formula: 'SUM(A1:E1)' }, { error: '#N/A' },
    ]);
    sheet.getCell('A2').value = { sharedFormula: 'A1', result: 0 };
    sheet.mergeCells('A2:B2');
    expect(await readWorkbook(workbook)).toEqual([
      { row: 1, values: ['0', '', 'false', 'false', '0', '#DIV/0!', '=SUM(A1:E1)', '#N/A'] },
      { row: 2, values: ['0', '0'] },
    ]);
  });

  it('reads merged rich text, hyperlinks, formulas and dates as readable values', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('合并');
    sheet.getCell('A1').value = { richText: [{ text: '预算' }, { text: '260元', font: { bold: true } }] };
    sheet.mergeCells('A1:B1');
    sheet.getCell('A2').value = { text: '资料', hyperlink: 'https://example.com/materials' };
    sheet.mergeCells('A2:B2');
    sheet.getCell('A3').value = { formula: '1+1', result: 2 };
    sheet.mergeCells('A3:B3');
    sheet.getCell('A4').value = new Date('2026-10-14T00:00:00.000Z');
    sheet.mergeCells('A4:B4');
    expect(await readWorkbook(workbook)).toEqual([
      { row: 1, values: ['预算260元', '预算260元'] },
      { row: 2, values: ['资料 (https://example.com/materials)', '资料 (https://example.com/materials)'] },
      { row: 3, values: ['2', '2'] },
      { row: 4, values: ['2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'] },
    ]);
  });
});
