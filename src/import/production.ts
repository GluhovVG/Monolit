import { code, findColumn, lower, num, periodFromNumber, text, type Workbook } from './sheet';

export type ProductionKind = 'own' | 'external';
/** One detail line of a production report (Выпуск брутто in tonnes, sums in rubles). */
export type ProductionRow = {
  opp: number | null;
  order: string;
  /** Own plant: month 'YYYY-MM'. External: null (rate does not depend on month). */
  month: string | null;
  /** External: workshop / contractor. Own: legal entity. */
  workshop: string;
  outputT: number;
  metalT: number;
  metalRub: number;
  totalRub: number;
};
export type ProductionReport = { kind: ProductionKind; periodFrom: string; periodTo: string; rows: ProductionRow[] };

/**
 * Order subtotal line («РВС-200-Алроса/25 (688)» = 19,12 т): the total of the detail lines below it.
 * When the order name is a merged cell it may spill into «Месяц» / «Цех»: own plant subtotal has no
 * month and no legal entity; external subtotal has the order name instead of a workshop.
 */
export function isSubtotalRow(kind: ProductionKind, row: Pick<ProductionRow, 'order' | 'month' | 'workshop'>): boolean {
  const order = row.order.trim().toLowerCase();
  const workshop = row.workshop.trim().toLowerCase();
  if (kind === 'own') return row.month === null && (workshop === '' || workshop === order);
  return workshop === '' || workshop === order;
}

export function productionKind(book: Workbook): ProductionKind | null {
  const head = book.sheets[0]?.rows.slice(0, 4).map(row => row.map(lower).join(' ')).join(' ') ?? '';
  if (head.includes('отчет по выпуску') && head.includes('сторонние')) return 'external';
  if (head.includes('отчет по выпуску') && head.includes('сз')) return 'own';
  return null;
}

export function parseProduction(book: Workbook): ProductionReport {
  const kind = productionKind(book);
  if (!kind) throw new Error('Это не отчёт по выпуску.');
  const rows = book.sheets[0].rows;
  const h = rows.findIndex(row => findColumn(row, x => x === 'выпуск брутто') >= 0);
  if (h < 0) throw new Error('В отчёте по выпуску не найдена строка заголовков.');
  const top = rows[h];
  const sub = rows[h + 1] ?? [];
  const col = (pred: (x: string) => boolean) => {
    const a = findColumn(top, pred);
    return a >= 0 ? a : findColumn(sub, pred);
  };
  const cOpp = col(x => x === 'шифр');
  const cOrder = col(x => x === 'заказ');
  const cOutput = col(x => x === 'выпуск брутто');
  const cMetalT = col(x => x.startsWith('списание вес'));
  const cTotal = col(x => x.startsWith('сумма всего'));
  const cMetal = col(x => x.startsWith('сумма металл'));
  const cDetail = kind === 'own' ? findColumn(sub, x => x === 'месяц') : findColumn(sub, x => x === 'цех');
  const cEntity = findColumn(sub, x => x === 'юрлицо');
  if ([cOrder, cOutput, cMetal, cDetail].some(i => i < 0)) throw new Error('В отчёте по выпуску не хватает колонок.');
  const header = rows.slice(0, h).map(row => row.map(text).join(' ')).join(' ');
  const periodFrom = /Начало периода:\s*([\d.]+)/.exec(header)?.[1] ?? '';
  const periodTo = /Конец периода:\s*([\d.]+)/.exec(header)?.[1] ?? '';
  const result: ProductionRow[] = [];
  for (const row of rows.slice(h + 2)) {
    if (!row || text(row[cDetail]) === '') continue; // order subtotal or empty line
    if (lower(row[0]) === 'итого') continue;
    const line: ProductionRow = {
      opp: code(row[cOpp]),
      order: text(row[cOrder]),
      month: kind === 'own' ? periodFromNumber(row[cDetail]) : null,
      workshop: kind === 'own' ? text(row[cEntity]) : text(row[cDetail]),
      outputT: num(row[cOutput]) ?? 0,
      metalT: num(row[cMetalT]) ?? 0,
      metalRub: num(row[cMetal]) ?? 0,
      totalRub: num(row[cTotal]) ?? 0,
    };
    if (isSubtotalRow(kind, line)) continue;
    result.push(line);
  }
  return { kind, periodFrom, periodTo, rows: result };
}
