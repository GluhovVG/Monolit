import type { Cell, Workbook } from './sheet';

type ExcelValue = unknown;

/** exceljs cell value → plain cell (formula → cached result, rich text → text, error → null). */
function cellValue(value: ExcelValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('error' in v) return null;
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text?: string }>).map(t => t.text ?? '').join('');
    if (typeof v.text === 'string') return v.text;
  }
  return null;
}

/** Reads an .xlsx file in the browser. The library is loaded only when a file is actually opened. */
export async function readWorkbook(file: File): Promise<Workbook> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Поддерживаются файлы .xlsx. Сохраните файл в формате Excel 2007+.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Файл больше 25 МБ.');
  const mod = await import('exceljs');
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheets = workbook.worksheets.map(ws => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? (row.values as ExcelValue[]).slice(1) : [];
      rows[rowNumber - 1] = Array.from(values, cellValue);
    });
    return { name: ws.name, rows: Array.from(rows, r => r ?? []) };
  });
  return { fileName: file.name, sheets };
}
