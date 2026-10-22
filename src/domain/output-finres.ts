import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import type { PriceRow } from './revenue-prices';

/**
 * Финрез по выпуску (собственный завод, по месяцам выпуска):
 * – выручка по выпуску = выпуск, т × цена МК, ₽/т (справочник «Расчёт цен для выручки» по шифру ОПП);
 * – списание металла = «Списание вес (металл)», т и «Сумма всего с НДС», ₽ из отчёта о выпуске;
 * – переработка (затраты без металла) = выпуск, т × 1000 × коэффициент месяца из «Расценок», ₽/кг;
 * – финрез = выручка − списание − переработка; рентабельность = финрез / выручка.
 * Нет цены или коэффициента ⇒ соответствующие суммы не рассчитываются (null), а не 0.
 */
export type OutputRow = {
  key: string;
  month: string | null;
  opp: number | null;
  /** Сделка Б24 (из «Расчёта цен») — для открытия ТКП. */
  b24: number | null;
  customer: string;
  tanks: string[];
  outputT: number;
  pricePerT: number | null;
  revenue: number | null;
  metalT: number;
  writeOffRub: number;
  coef: number | null;
  processingRub: number | null;
  result: number | null;
  margin: number | null;
  issue: string;
};

const sub = (a: number | null, ...b: Array<number | null>) => (a === null || b.some(x => x === null) ? null : b.reduce<number>((s, x) => s - (x as number), a));

export function outputFinres(
  prodOwn: readonly ProductionRow[],
  prices: readonly PriceRow[],
  rates: Rates | null,
  reference: readonly ReferenceRow[],
): OutputRow[] {
  const priceByOpp = new Map(prices.filter(p => p.opp !== null).map(p => [p.opp as number, p]));
  const refByOpp = new Map<number, ReferenceRow[]>();
  for (const r of reference) if (r.opp !== null) refByOpp.set(r.opp, [...(refByOpp.get(r.opp) ?? []), r]);
  const acc = new Map<string, { month: string | null; opp: number | null; outputT: number; metalT: number; writeOffRub: number }>();
  for (const row of prodOwn) {
    const key = `${row.month ?? '—'}|${row.opp ?? row.order}`;
    const a = acc.get(key) ?? { month: row.month, opp: row.opp, outputT: 0, metalT: 0, writeOffRub: 0 };
    a.outputT += row.outputT;
    a.metalT += row.metalT;
    a.writeOffRub += row.totalRub;
    acc.set(key, a);
  }
  const out: OutputRow[] = [];
  for (const [key, a] of acc) {
    const price = a.opp !== null ? priceByOpp.get(a.opp) : undefined;
    const refRows = a.opp !== null ? refByOpp.get(a.opp) ?? [] : [];
    const pricePerT = price?.pricePerT ?? null;
    const coef = a.month && rates ? rates.ownByMonth[a.month] ?? null : null;
    const revenue = pricePerT !== null ? a.outputT * pricePerT : null;
    const processingRub = coef !== null ? a.outputT * 1000 * coef : null;
    const result = sub(revenue, a.writeOffRub, processingRub);
    const issues = [
      pricePerT === null ? 'нет цены за тонну (нет ТКП по шифру)' : '',
      coef === null ? `нет коэффициента СЗ за ${a.month ?? 'месяц'}` : '',
      !refRows.length ? 'шифра нет в «Номерах заказов» (незавершённое производство)' : '',
    ].filter(Boolean);
    out.push({
      key, month: a.month, opp: a.opp, b24: price?.b24 ?? refRows[0]?.b24 ?? null,
      customer: (price?.customer || refRows[0]?.client || '').replace(/\s+/g, ' ').trim(),
      tanks: price?.tanks.length ? price.tanks : Array.from(new Set(refRows.map(r => r.tankCode))),
      outputT: a.outputT, pricePerT, revenue, metalT: a.metalT, writeOffRub: a.writeOffRub, coef, processingRub,
      result, margin: result !== null && revenue ? result / revenue : null, issue: issues.join('; '),
    });
  }
  return out.sort((x, y) => (x.month ?? '').localeCompare(y.month ?? '') || (x.opp ?? 1e9) - (y.opp ?? 1e9));
}

/** Итоги: суммы считаются только там, где значение известно; рентабельность — по суммам строк, у которых есть и выручка, и финрез. */
export function outputTotals(rows: readonly OutputRow[]) {
  const sum = (f: (r: OutputRow) => number | null) => {
    const v = rows.map(f).filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) : null;
  };
  const complete = rows.filter(r => r.result !== null && r.revenue !== null);
  const rev = complete.reduce((s, r) => s + (r.revenue as number), 0);
  const res = complete.reduce((s, r) => s + (r.result as number), 0);
  return {
    outputT: sum(r => r.outputT), revenue: sum(r => r.revenue), metalT: sum(r => r.metalT), writeOffRub: sum(r => r.writeOffRub),
    processingRub: sum(r => r.processingRub), result: sum(r => r.result), margin: rev ? res / rev : null,
    incomplete: rows.length - complete.length,
  };
}

/** Справочно: выпуск сторонних цехов × цена за тонну (без месяца; в финрез не входит). */
export type ExternalRefRow = { opp: number | null; b24: number | null; customer: string; workshops: string[]; outputT: number; pricePerT: number | null; revenue: number | null };

export function externalReference(prodExt: readonly ProductionRow[], prices: readonly PriceRow[], reference: readonly ReferenceRow[]): ExternalRefRow[] {
  const priceByOpp = new Map(prices.filter(p => p.opp !== null).map(p => [p.opp as number, p]));
  const refByOpp = new Map<number, ReferenceRow>();
  for (const r of reference) if (r.opp !== null && !refByOpp.has(r.opp)) refByOpp.set(r.opp, r);
  const acc = new Map<string, ExternalRefRow>();
  for (const row of prodExt) {
    if (!row.outputT) continue;
    const key = String(row.opp ?? row.order);
    const price = row.opp !== null ? priceByOpp.get(row.opp) : undefined;
    const ref = row.opp !== null ? refByOpp.get(row.opp) : undefined;
    const a = acc.get(key) ?? {
      opp: row.opp, b24: price?.b24 ?? ref?.b24 ?? null,
      customer: (price?.customer || ref?.client || '').replace(/\s+/g, ' ').trim(), workshops: [], outputT: 0,
      pricePerT: price?.pricePerT ?? null, revenue: null,
    };
    a.outputT += row.outputT;
    const w = row.workshop.trim();
    if (w && !a.workshops.includes(w)) a.workshops.push(w);
    acc.set(key, a);
  }
  for (const a of acc.values()) a.revenue = a.pricePerT !== null ? a.outputT * a.pricePerT : null;
  return Array.from(acc.values()).sort((x, y) => (x.opp ?? 1e9) - (y.opp ?? 1e9));
}
