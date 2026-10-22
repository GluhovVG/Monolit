import { ratio, registerTotals, type OppRow } from './consolidate';

/** Свод реестра по ключу (месяц, заказчик): сначала суммы, затем рентабельность по суммам. */
export type SummaryLine = {
  key: string;
  rows: number;
  revenueFact: number | null;
  costFact: number | null;
  profitFact: number | null;
  margin: number | null;
  weightFactKg: number | null;
};

export function summarize(rows: readonly OppRow[], keyOf: (r: OppRow) => string): SummaryLine[] {
  const groups = new Map<string, OppRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Array.from(groups.entries()).map(([key, list]) => {
    const t = registerTotals(list);
    return {
      key, rows: list.length, revenueFact: t.revenueFact, costFact: t.costFact, profitFact: t.profitFact,
      margin: ratio(t.profitFact, t.revenueFact), weightFactKg: t.weightFactKg,
    };
  });
}

/** Нормализованное имя заказчика для группировки: регистр, кавычки и лишние пробелы не важны. */
export const customerKey = (name: string) => name.replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim() || 'Без заказчика';
