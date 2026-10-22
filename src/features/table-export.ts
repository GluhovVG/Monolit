/** Выгрузка таблиц в CSV (Excel, разделитель «;») и в настоящий .xlsx. Одна матрица — оба формата. */
export type Matrix = { head: string[]; rows: Array<Array<string | number | null>>; widths?: number[] };

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(m: Matrix, fileName: string) {
  const csv = '﻿' + [m.head.map(csvCell).join(';'), ...m.rows.map(r => r.map(csvCell).join(';'))].join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), fileName);
}

export async function downloadXlsx(m: Matrix, sheetName: string, fileName: string) {
  const mod = await import('exceljs');
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(m.head);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { wrapText: true, vertical: 'top' };
  for (const r of m.rows) ws.addRow(r.map(v => (v === null ? null : v)));
  m.head.forEach((_, i) => {
    const col = ws.getColumn(i + 1);
    col.width = m.widths?.[i] ?? 16;
    const isNumber = m.rows.some(r => typeof r[i] === 'number');
    if (isNumber) col.numFmt = '#,##0.00';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const buffer = await wb.xlsx.writeBuffer();
  download(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
}
