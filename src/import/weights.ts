import { code, findColumn, lower, num, text, type Cell, type Sheet, type Workbook } from './sheet';

/**
 * Файл весов. Два формата:
 * 1) «Веса» ОПП (листы «2026», «20242025»): блоки по заказу — строка-заголовок «шифр ОПП | заказчик | РВС-… | N шт | … »,
 *    затем элементы (стенка, днище…) и строка «ВСЕГО:» с чистым весом по КМД за все комплекты, кг.
 *    Один шифр может занимать несколько блоков (партии баков) — веса блоков складываются.
 * 2) Таблица «Шифр ОПП | Вес». Колонки ищутся по заголовку:
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
  /** Замечания разбора (блок без «ВСЕГО», шифр на нескольких листах). */
  notes?: string[];
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

/** Лист в формате блоков: в заголовке есть «Чистый вес (по КМД …), кг». */
const isBlockSheet = (sheet: Sheet) => sheet.rows.slice(0, 3).some(row => findColumn(row, x => x.startsWith('чистый вес') && x.includes('кг')) >= 0);

export function isWeightsWorkbook(book: Workbook): boolean {
  return book.sheets.some(isBlockSheet) || locate(book) !== null;
}

/** Строка начала блока: шифр ОПП (целое) в колонке A и тип бака текстом в колонке C. */
function blockStart(row: Cell[]): number | null {
  const opp = code(row[0]);
  return opp !== null && opp < 100000 && typeof row[2] === 'string' && text(row[2]) !== '' ? opp : null;
}

function parseBlocks(book: Workbook): WeightsFile {
  const byOpp: Record<string, number> = {};
  const sheetsOf = new Map<number, Set<string>>();
  const notes: string[] = [];
  let blocks = 0;
  for (const sheet of book.sheets.filter(isBlockSheet)) {
    let opp: number | null = null;
    let headerTotal: number | null = null;
    let subtotal: number | null = null;
    let done = true;
    const close = () => {
      if (opp === null || done) return;
      const w = headerTotal ?? subtotal;
      if (w !== null && w > 0) {
        byOpp[opp] = (byOpp[opp] ?? 0) + w;
        blocks += 1;
      } else notes.push(`Шифр ${opp} (лист «${sheet.name}»): нет строки «ВСЕГО» — вес не взят.`);
      done = true;
    };
    for (const row of sheet.rows) {
      if (!row) continue;
      const start = blockStart(row);
      if (start !== null) {
        close();
        opp = start;
        // Общий вес иногда записан в строке-заголовке блока (первое число после колонки G).
        headerTotal = row.slice(7).map(v => num(v)).find((v): v is number => v !== null && v > 0) ?? null;
        subtotal = null;
        done = false;
        sheetsOf.set(opp, (sheetsOf.get(opp) ?? new Set()).add(sheet.name));
        continue;
      }
      if (opp === null || done) continue;
      const label = lower(row[1]);
      if (label.startsWith('всего')) {
        const w = num(row[2]);
        if (w !== null && w > 0) {
          byOpp[opp] = (byOpp[opp] ?? 0) + w;
          blocks += 1;
          done = true;
        }
      } else if (label.startsWith('итого')) subtotal = num(row[2]);
    }
    close();
  }
  for (const [opp, sheets] of sheetsOf) {
    if (sheets.size > 1) notes.push(`Шифр ${opp} есть на нескольких листах (${Array.from(sheets).join(', ')}): веса сложены — проверьте.`);
  }
  return { fileName: book.fileName, byOpp, unit: 'кг', unitFromHeader: true, rows: blocks, notes };
}

export function parseWeights(book: Workbook): WeightsFile {
  if (book.sheets.some(isBlockSheet)) return parseBlocks(book);
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
