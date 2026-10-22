import { findColumn, normalizeName, num, periodFromNumber, text, type Workbook } from './sheet';

export type Rates = {
  /** 'YYYY-MM' → руб/кг выпуска, затраты СЗ без металла. */
  ownByMonth: Record<string, number>;
  /** normalised contractor name → руб/кг (одинаково для любого месяца). */
  contractor: Record<string, number>;
  contractorLabels: Record<string, string>;
  conflicts: string[];
};

export function isRatesWorkbook(book: Workbook): boolean {
  return book.sheets.some(sheet => sheet.rows.slice(0, 5).some(row =>
    findColumn(row, h => h.includes('к/ты по мес') || h.includes('стоимость кг')) >= 0));
}

export function parseRates(book: Workbook): Rates {
  const rates: Rates = { ownByMonth: {}, contractor: {}, contractorLabels: {}, conflicts: [] };
  for (const sheet of book.sheets) {
    const head = sheet.rows.slice(0, 5);
    const locate = (pred: (h: string) => boolean): [number, number] => {
      for (let r = 0; r < head.length; r += 1) {
        const c = findColumn(head[r], pred);
        if (c >= 0) return [r, c];
      }
      return [-1, -1];
    };
    const [coefRow, cCoef] = locate(x => x.includes('к/ты по мес'));
    const [, cPeriodFound] = locate(x => x === 'период');
    const [nameRow, cName] = locate(x => x.includes('наименование подрядчика'));
    const [, cRate] = locate(x => x.includes('стоимость кг'));
    if (cCoef < 0 && cName < 0) continue;
    const cPeriod = cPeriodFound >= 0 ? cPeriodFound : cCoef - 1;
    const firstData = Math.max(coefRow, nameRow) + 1;
    for (const row of sheet.rows.slice(Math.min(coefRow >= 0 ? coefRow + 1 : firstData, nameRow >= 0 ? nameRow + 1 : firstData))) {
      if (!row) continue;
      if (cCoef >= 0) {
        const period = periodFromNumber(row[cPeriod]);
        const coef = num(row[cCoef]);
        if (period && coef !== null && coef > 0) {
          const prev = rates.ownByMonth[period];
          if (prev !== undefined && Math.abs(prev - coef) > 1e-9) {
            rates.conflicts.push(`Коэффициент СЗ за ${period} указан дважды: ${prev} и ${coef}.`);
          }
          rates.ownByMonth[period] = coef;
        }
      }
      if (cName >= 0 && cRate >= 0) {
        const key = normalizeName(row[cName]);
        const rate = num(row[cRate]);
        if (key && rate !== null && rate > 0) {
          const prev = rates.contractor[key];
          if (prev !== undefined && prev !== rate) {
            rates.conflicts.push(`Расценка «${text(row[cName])}» указана как ${prev} и ${rate} руб/кг.`);
          }
          rates.contractor[key] = rate;
          rates.contractorLabels[key] = rates.contractorLabels[key] ?? text(row[cName]);
        }
      }
    }
  }
  return rates;
}
