import type { OppRow } from './consolidate';

/**
 * Дашборд года — та же раскладка, что лист «Финрез.» файла 2025: показатели по месяцам закрытия сделок,
 * кварталам и за год. Строится из строк реестра (шифр ОПП × сделка) по месяцу закрытия, поэтому для каждого
 * нового года дашборд появляется сам, как только в реестре есть сделки этого года.
 * Суммы — по известным значениям; если значений нет ни в одной строке — пусто, а не 0.
 */
export type DashMetric = {
  key: string;
  label: string;
  /** Строка-подпункт («в т.ч.») — показывается с отступом. */
  sub?: boolean;
  unit: 'rub' | 'kg' | 'rubkg';
  value: (rows: readonly OppRow[]) => number | null;
};

const sum = (rows: readonly OppRow[], f: (r: OppRow) => number | null | undefined): number | null => {
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = f(r);
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
};
const div = (a: number | null, b: number | null) => (a !== null && b ? a / b : null);
const minus = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) - (b ?? 0));

const block = (k: 'docs' | 'supply' | 'delivery' | 'smr', side: 'plan' | 'fact') => (rows: readonly OppRow[]) => sum(rows, r => r.blocks[k][side]);
const economy = (k: 'docs' | 'supply' | 'delivery' | 'smr') => (rows: readonly OppRow[]) => minus(block(k, 'plan')(rows), block(k, 'fact')(rows));

export const DASH_METRICS: DashMetric[] = [
  { key: 'revenue', label: 'Выручка факт', unit: 'rub', value: rows => sum(rows, r => r.revenueFact) },
  { key: 'mkValue', label: 'Стоимость МК факт', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mkValueFact) },
  { key: 'docsPlan', label: 'Документация план', sub: true, unit: 'rub', value: block('docs', 'plan') },
  { key: 'supplyPlan', label: 'Комплектация план', sub: true, unit: 'rub', value: block('supply', 'plan') },
  { key: 'deliveryPlan', label: 'Доставка план', sub: true, unit: 'rub', value: block('delivery', 'plan') },
  { key: 'smrPlan', label: 'СМР план', sub: true, unit: 'rub', value: block('smr', 'plan') },
  { key: 'cost', label: 'Полная себестоимость факт', unit: 'rub', value: rows => sum(rows, r => r.costFact) },
  { key: 'mkCost', label: 'Себестоимость МК факт', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mk?.costRub) },
  { key: 'docsFact', label: 'Документация факт', sub: true, unit: 'rub', value: block('docs', 'fact') },
  { key: 'supplyFact', label: 'Комплектация факт', sub: true, unit: 'rub', value: block('supply', 'fact') },
  { key: 'deliveryFact', label: 'Доставка факт', sub: true, unit: 'rub', value: block('delivery', 'fact') },
  { key: 'smrFact', label: 'СМР факт', sub: true, unit: 'rub', value: block('smr', 'fact') },
  { key: 'fines', label: 'БГ, штрафы', sub: true, unit: 'rub', value: rows => sum(rows, r => r.finesRub) },
  { key: 'profit', label: 'Маржа факт', unit: 'rub', value: rows => sum(rows, r => r.profitFact) },
  { key: 'mkProfit', label: 'Маржинальная прибыль МК факт', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mkProfitFact) },
  { key: 'docsEconomy', label: 'Документация экономия', sub: true, unit: 'rub', value: economy('docs') },
  { key: 'supplyEconomy', label: 'Комплектация экономия', sub: true, unit: 'rub', value: economy('supply') },
  { key: 'deliveryEconomy', label: 'Доставка экономия', sub: true, unit: 'rub', value: economy('delivery') },
  { key: 'smrEconomy', label: 'СМР экономия', sub: true, unit: 'rub', value: economy('smr') },
  { key: 'weight', label: 'Вес, кг факт', unit: 'kg', value: rows => sum(rows, r => r.weightFactKg) },
  { key: 'ownKg', label: 'Выпуск завода, кг', sub: true, unit: 'kg', value: rows => sum(rows, r => r.mk?.own.outputKg) },
  { key: 'extKg', label: 'Выпуск сторонних, кг', sub: true, unit: 'kg', value: rows => sum(rows, r => r.mk?.ext.outputKg) },
  { key: 'ownTotal', label: 'Всего затраты завода', unit: 'rub', value: rows => sum(rows, r => r.mk?.own.totalRub) },
  { key: 'ownMetal', label: 'Металл, руб (завод)', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mk?.own.writeOffRub) },
  { key: 'ownWork', label: 'Затраты без сырья (завод)', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mk?.own.workRub) },
  { key: 'extTotal', label: 'Всего затраты сторонние', unit: 'rub', value: rows => sum(rows, r => r.mk?.ext.totalRub) },
  { key: 'extMetal', label: 'Металл, руб (сторонние)', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mk?.ext.writeOffRub) },
  { key: 'realloc', label: 'Частичное переразмещение (услуги)', sub: true, unit: 'rub', value: rows => sum(rows, r => r.mk?.ext.reallocationRub) },
  { key: 'mkPerKg', label: 'Средняя стоимость кг МК', unit: 'rubkg', value: rows => div(sum(rows, r => r.mkValueFact), sum(rows, r => r.weightFactKg)) },
  { key: 'profitPerKg', label: 'Маржинальная прибыль, руб/кг', unit: 'rubkg', value: rows => div(sum(rows, r => r.profitFact), sum(rows, r => r.weightFactKg)) },
  { key: 'ownPerKg', label: 'Затраты завода, руб/кг', unit: 'rubkg', value: rows => div(sum(rows, r => r.mk?.own.totalRub), sum(rows, r => r.mk?.own.outputKg)) },
];

export type DashColumn = { key: string; label: string; kind: 'month' | 'quarter' | 'year'; months: string[] };

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

/** Годы, по которым в реестре есть закрытые сделки, — новый год появляется автоматически. */
export function dashboardYears(rows: readonly OppRow[]): string[] {
  return Array.from(new Set(rows.map(r => r.period?.slice(0, 4)).filter((y): y is string => Boolean(y && /^\d{4}$/.test(y))))).sort().reverse();
}

/** Колонки года: месяцы с данными, кварталы с данными, итог года. */
export function dashboardColumns(rows: readonly OppRow[], year: string): DashColumn[] {
  const months = Array.from(new Set(rows.map(r => r.period).filter((p): p is string => Boolean(p && p.startsWith(year + '-'))))).sort();
  const cols: DashColumn[] = months.map(m => ({ key: m, label: monthName(m), kind: 'month', months: [m] }));
  for (let q = 1; q <= 4; q += 1) {
    const qm = months.filter(m => Math.ceil(Number(m.slice(5, 7)) / 3) === q);
    if (qm.length) cols.push({ key: `${year}-Q${q}`, label: `${q} квартал`, kind: 'quarter', months: qm });
  }
  cols.push({ key: year, label: `Итого ${year}`, kind: 'year', months });
  return cols;
}

export function rowsOf(rows: readonly OppRow[], months: readonly string[]): OppRow[] {
  const set = new Set(months);
  return rows.filter(r => r.period !== null && set.has(r.period));
}

/** Таблица «Финрез» года: значение каждого показателя в каждой колонке. */
export function dashboardTable(rows: readonly OppRow[], year: string) {
  const columns = dashboardColumns(rows, year);
  const byCol = columns.map(c => rowsOf(rows, c.months));
  return { columns, lines: DASH_METRICS.map(m => ({ metric: m, values: byCol.map(list => m.value(list)) })) };
}

/** Предыдущий сопоставимый период: месяц → прошлый месяц, квартал → прошлый квартал, год → прошлый год. */
export function previousPeriod(key: string): string[] {
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    return [m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`];
  }
  const quarter = /^(\d{4})-Q(\d)$/.exec(key);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    const [py, pq] = q === 1 ? [y - 1, 4] : [y, q - 1];
    return [1, 2, 3].map(i => `${py}-${String((pq - 1) * 3 + i).padStart(2, '0')}`);
  }
  if (/^\d{4}$/.test(key)) return Array.from({ length: 12 }, (_, i) => `${Number(key) - 1}-${String(i + 1).padStart(2, '0')}`);
  return [];
}
