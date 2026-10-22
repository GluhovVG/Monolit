import { code, findColumn, lower, num, type Cell, type Workbook } from './sheet';

/**
 * Файл весов: вес по шифру для бухгалтерии (ОПП). Колонки ищутся по заголовку:
 * шифр — «Шифр для бухгалтерии (ОПП)», «Шифр ОПП», «ОПП» или «Шифр»; вес — заголовок со словом «вес».
 * Единица берётся из заголовка («кг» или «т/тн»); если её нет — по величине чисел (медиана > 500 → кг).
 * Несколько строк одного шифра (баки одного типа) суммируются.
 */
export type WeightsFile = {
  fileName: string;
  /** ОПП → вес, кг. */
  byOpp: Record<string, number>;
  unit: 'кг' | 'т';
  unitFromHeader: boolean;
  rows: number;
};

type Layout = { sheet: number; header: number; cOpp: number; cWeight: number; unitHeader: string };

function locate(book: Workbook): Layout | null {
  for (let s = 0; s < book.sheets.length; s += 1) {
    const rows = book.sheets[s].rows;
    for (let h = 0; h < Math.min(10, rows.length); h += 1) {
      const row = rows[h];
      const cOpp = [
        (x: string) => x.includes('шифр для бухгалтерии'),
        (x: string) => x.includes('опп') && x.includes('шифр'),
        (x: string) => x === 'опп',
        (x: string) => x === 'шифр',
      ].map(p => findColumn(row, p)).find(c => c >= 0) ?? -1;
      const cWeight = findColumn(row, x => /(^|\s)вес/.test(x) && !x.includes('списание'));
      if (cOpp >= 0 && cWeight >= 0) return { sheet: s, header: h, cOpp, cWeight, unitHeader: lower(row[cWeight]) };
    }
  }
  return null;
}

export function isWeightsWorkbook(book: Workbook): boolean {
  return locate(book) !== null;
}

export function parseWeights(book: Workbook): WeightsFile {
  const layout = locate(book);
  if (!layout) throw new Error('В файле весов не найдены колонки «Шифр ОПП» и «Вес».');
  const rows = book.sheets[layout.sheet].rows.slice(layout.header + 1);
  const pairs: Array<[number, number]> = [];
  for (const row of rows as Cell[][]) {
    if (!row) continue;
    const opp = code(row[layout.cOpp]);
    const weight = num(row[layout.cWeight]);
    if (opp !== null && weight !== null && weight > 0) pairs.push([opp, weight]);
  }
  const h = layout.unitHeader;
  let unit: 'кг' | 'т' | null = /кг/.test(h) ? 'кг' : /(^|[\s,(])(т|тн|тонн)/.test(h.replace(/^вес/, '')) ? 'т' : null;
  const unitFromHeader = unit !== null;
  if (!unit) {
    const sorted = pairs.map(p => p[1]).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    unit = median > 500 ? 'кг' : 'т';
  }
  const factor = unit === 'т' ? 1000 : 1;
  const byOpp: Record<string, number> = {};
  for (const [opp, w] of pairs) byOpp[opp] = (byOpp[opp] ?? 0) + w * factor;
  return { fileName: book.fileName, byOpp, unit, unitFromHeader, rows: pairs.length };
}
