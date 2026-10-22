import { tankTypeKey, type ReferenceRow } from './reference';
import { findColumn, lower, num, text, type Sheet, type Workbook } from './sheet';

/**
 * «Расчёт ТКП» (.xlsm) — плановая калькуляция сделки. Лист «Расчёт ТКП» состоит из позиций
 * (одна позиция = один тип баков, может быть несколько комплектов). По строке «ИТОГО МК» позиции берём:
 * – вес МК план, кг («Кол-во на поставку план, кг»);
 * – себестоимость МК план («Итого полная себестоимость план»);
 * – стоимость МК план и факт («Конечная стоимость для продажи план / факт»).
 * Плановые бюджеты остальных блоков берутся из файлов подразделений (они равны ТКП).
 */
export type TkpPosition = {
  /** «РВС- 700м3», «РВС- 200м3 Е-811/1, Е-811/2». */
  name: string;
  weightPlanKg: number | null;
  mkCostPlan: number | null;
  mkValuePlan: number | null;
  mkValueFact: number | null;
  sourceRow: number;
};
export type TkpFile = { b24: number | null; fileName: string; positions: TkpPosition[] };

const SHEET = 'расчет ткп';

function tkpSheet(book: Workbook): Sheet | undefined {
  return book.sheets.find(s => lower(s.name) === SHEET);
}

export function isTkpWorkbook(book: Workbook): boolean {
  return Boolean(tkpSheet(book));
}

/** «6222 Расчёт ТКП …», «ТКП 8559 …» → 6222 / 8559: the first 4–6 digit group in the file name. */
export function b24FromTkpFileName(fileName: string): number | null {
  const m = /(?:^|\D)(\d{4,6})(?!\d)/.exec(fileName.replace(/\.[^.]+$/, ''));
  return m ? Number(m[1]) : null;
}

export function parseTkp(book: Workbook): TkpFile {
  const sheet = tkpSheet(book);
  if (!sheet) throw new Error('В файле нет листа «Расчёт ТКП».');
  const h = sheet.rows.slice(0, 10).findIndex(row => findColumn(row, x => x.startsWith('наименование позиций')) >= 0);
  if (h < 0) throw new Error('На листе «Расчёт ТКП» не найдена строка заголовков.');
  const header = sheet.rows[h];
  const col = (pred: (x: string) => boolean) => findColumn(header, pred);
  const cName = col(x => x === 'наименование');
  const cWeight = col(x => x.startsWith('кол-во на поставку план'));
  const cCost = col(x => x.startsWith('итого полная себестоимость план'));
  const cValuePlan = col(x => x.startsWith('конечная стоимость для продажи план'));
  const cValueFact = col(x => x.startsWith('конечная стоимость для продажи факт'));
  if ([cName, cWeight, cCost, cValuePlan].some(c => c < 0)) throw new Error('На листе «Расчёт ТКП» не хватает колонок.');

  const positions: TkpPosition[] = [];
  let name = '';
  sheet.rows.slice(h + 1).forEach((row, offset) => {
    if (!row) return;
    const first = text(row[0]);
    // A position starts with its name in column A («Позиция №N» is only a separator).
    if (first && !/^позиция\s*№/i.test(first)) name = first;
    if (!/^итого мк$/i.test(lower(row[cName]))) return;
    const weight = num(row[cWeight]);
    const cost = num(row[cCost]);
    const value = num(row[cValuePlan]);
    if (!weight && !cost && !value) return; // empty template position
    positions.push({
      name: name.replace(/\s+/g, ' ').trim(), weightPlanKg: weight, mkCostPlan: cost, mkValuePlan: value,
      mkValueFact: cValueFact >= 0 ? num(row[cValueFact]) : null, sourceRow: h + 2 + offset,
    });
  });
  return { b24: b24FromTkpFileName(book.fileName), fileName: book.fileName, positions };
}

/** Designations like «Е-811/1» written in a position name. */
const designations = (s: string) => Array.from(s.toLowerCase().replace(/ё/g, 'е').matchAll(/[а-яa-z]-\d+\/\d+/g)).map(m => m[0].replace(/e/g, 'е'));

/**
 * ТКП position → ОПП of the deal: first by tank designations (Е-811/1) found in «Номерах заказов»,
 * then by type and volume (РВС-700). Null when nothing or more than one ОПП fits.
 */
export function matchPositionOpp(position: string, dealRows: readonly ReferenceRow[]): { opp: number | null; candidates: number[] } {
  const withOpp = dealRows.filter(r => r.opp !== null);
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/e/g, 'е').replace(/\s/g, '');
  const marks = designations(position);
  let hits = marks.length ? withOpp.filter(r => marks.some(m => norm(r.tankCode).includes(m))) : [];
  if (!hits.length) {
    const type = tankTypeKey(position);
    hits = type ? withOpp.filter(r => tankTypeKey(r.tankCode) === type) : [];
  }
  const candidates = Array.from(new Set(hits.map(r => r.opp as number))).sort((a, b) => a - b);
  return { opp: candidates.length === 1 ? candidates[0] : null, candidates };
}
