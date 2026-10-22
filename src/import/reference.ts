import { code, findColumn, lower, text, type Sheet, type Workbook } from './sheet';

/** One tank / item line of «Номера заказов»: deal (Б24) → tank code → accounting code (ОПП). */
export type ReferenceRow = {
  b24: number | null;
  client: string;
  tankCode: string;
  /** Заводской номер, e.g. «138/25». */
  factoryNo: string;
  opp: number | null;
  sheet: string;
};

export function isReferenceWorkbook(book: Workbook): boolean {
  return book.sheets.some(sheet => headerRowIndex(sheet) >= 0);
}

function headerRowIndex(sheet: Sheet): number {
  for (let i = 0; i < Math.min(6, sheet.rows.length); i += 1) {
    if (findColumn(sheet.rows[i], h => h.includes('шифр для бухгалтерии')) >= 0) return i;
  }
  return -1;
}

/**
 * Deal number and customer are written only on the first line of a deal; following
 * lines (other tanks of the same deal) are blank there, so they are carried forward.
 * A line with a customer but no Б24 starts a new deal without a number.
 */
export function parseReference(book: Workbook): ReferenceRow[] {
  const result: ReferenceRow[] = [];
  for (const sheet of book.sheets) {
    const h = headerRowIndex(sheet);
    if (h < 0) continue;
    const header = sheet.rows[h];
    const cB24 = findColumn(header, x => x.replace(/^№/, '') === 'б24');
    const cClient = findColumn(header, x => x === 'наименование');
    const cTank = findColumn(header, x => x.startsWith('шифр') && !x.includes('бухгалтерии'));
    const cOpp = findColumn(header, x => x.includes('шифр для бухгалтерии'));
    const cFactory = findColumn(header, x => x.startsWith('заводской номер'));
    let b24: number | null = null;
    let client = '';
    let lastOpp: { b24: number | null; type: string; opp: number } | null = null;
    for (const row of sheet.rows.slice(h + 1)) {
      if (!row || row.every(cell => text(cell) === '')) continue;
      const rowB24 = cB24 >= 0 ? code(row[cB24]) : null;
      const rowClient = cClient >= 0 ? text(row[cClient]) : '';
      if (rowB24 !== null) {
        b24 = rowB24;
        client = rowClient;
      } else if (rowClient) {
        b24 = null;
        client = rowClient;
      }
      const tankCode = cTank >= 0 ? text(row[cTank]) : '';
      let opp = cOpp >= 0 ? code(row[cOpp]) : null;
      if (!tankCode && opp === null) continue;
      if (lower(tankCode) === 'отсутствует') continue;
      // ОПП is written once per tank type (merged cell): next tanks of the same type in the same deal inherit it.
      const type = tankTypeKey(tankCode);
      if (opp === null && lastOpp && lastOpp.b24 === b24 && type && lastOpp.type === type) opp = lastOpp.opp;
      if (opp !== null) lastOpp = { b24, type, opp };
      const factoryNo = cFactory >= 0 ? text(row[cFactory]).replace(/^№\s*/, '') : '';
      result.push({ b24, client, tankCode, factoryNo, opp, sheet: sheet.name });
    }
  }
  return result;
}

/** «РВС-5000/2-ПНГ», «РВС- 5 000м3», «РВСп-4950» → 'рвс-5000' / 'рвсп-4950'. Empty when no volume. */
export function tankTypeKey(value: string): string {
  const m = /^\s*([а-яa-z]+)\s*-?\s*(\d[\d\s]*)/i.exec(value.toLowerCase().replace(/ё/g, 'е'));
  return m ? `${m[1]}-${m[2].replace(/\s/g, '')}` : '';
}

/** Б24 deal → set of accounting codes. */
export function oppByDeal(rows: readonly ReferenceRow[]): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.b24 === null || row.opp === null) continue;
    if (!map.has(row.b24)) map.set(row.b24, new Set());
    map.get(row.b24)!.add(row.opp);
  }
  return map;
}
