import type { ActsFile } from '../import/acts';
import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import { sameContractor } from './consolidate';
import type { ContractorAliases } from './mk-production';
import type { PriceRow } from './revenue-prices';

/**
 * Финрез по выпуску по цехам — по общему выпуску (файл «Выпуск продукции», лист «Акты», тоннаж брутто для выручки, кг).
 * Строка = месяц × юр. лицо × цех × шифр ОПП.
 * – Выручка = выпуск, т × цена за тонну из «Расчёта цен для выручки».
 * – Завод (СЗ): металл = «Сумма всего с НДС» из «Выпуска СЗ» за месяц по шифру, распределённая по цехам завода
 *   пропорционально выпуску; переработка = выпуск × 1000 × коэффициент месяца из «Расценок».
 * – Сторонние из н/м (наш металл): переработка = выпуск × 1000 × расценка подрядчика; металл — оценка:
 *   выпуск × средняя сумма списания на тонну по шифру из «Выпуска сторонних цехов» (по этому подрядчику, иначе по шифру).
 * – Сторонние (металл подрядчика): затраты по месяцам не известны (они в «Переразмещениях» Комплектации) — только выручка.
 * Неизвестное значение = null, а не 0.
 */
export type WorkshopGroup = 'own' | 'ext_our_metal' | 'ext';

export type WorkshopRow = {
  key: string;
  month: string;
  legal: string;
  group: WorkshopGroup;
  workshop: string;
  opp: number | null;
  b24: number | null;
  customer: string;
  outputT: number;
  pricePerT: number | null;
  revenue: number | null;
  metalRub: number | null;
  metalEstimated: boolean;
  /** ₽/кг: коэффициент СЗ или расценка подрядчика. */
  rate: number | null;
  processingRub: number | null;
  result: number | null;
  margin: number | null;
  issue: string;
};

export const WORKSHOP_GROUP_LABELS: Record<WorkshopGroup, string> = {
  own: 'Завод (СЗ)',
  ext_our_metal: 'Сторонние из нашего металла',
  ext: 'Сторонние (металл подрядчика)',
};

export function workshopGroup(legal: string): WorkshopGroup {
  const l = legal.toLowerCase();
  if (l.startsWith('сз') || l.includes('квоит')) return 'own';
  if (l.includes('н/м')) return 'ext_our_metal';
  return 'ext';
}

const sumOrNull = (...v: Array<number | null>) => (v.some(x => x === null) ? null : v.reduce<number>((s, x) => s + (x as number), 0));

export function outputByWorkshops(
  acts: ActsFile,
  prodOwn: readonly ProductionRow[],
  prodExt: readonly ProductionRow[],
  prices: readonly PriceRow[],
  rates: Rates | null,
  reference: readonly ReferenceRow[],
  aliases: ContractorAliases = {},
): WorkshopRow[] {
  const priceByOpp = new Map(prices.filter(p => p.opp !== null).map(p => [p.opp as number, p]));
  const refByOpp = new Map<number, ReferenceRow>();
  for (const r of reference) if (r.opp !== null && !refByOpp.has(r.opp)) refByOpp.set(r.opp, r);

  // Металл СЗ: «Сумма всего с НДС» по месяц|ОПП и выпуск СЗ по «Актам» для распределения по цехам.
  const ownMetal = new Map<string, number>();
  for (const r of prodOwn) if (r.month && r.opp !== null) ownMetal.set(`${r.month}|${r.opp}`, (ownMetal.get(`${r.month}|${r.opp}`) ?? 0) + r.totalRub);
  const ownActsKg = new Map<string, number>();
  for (const [month, legal, , opp, kg] of acts.rows) {
    if (opp !== null && workshopGroup(legal) === 'own') ownActsKg.set(`${month}|${opp}`, (ownActsKg.get(`${month}|${opp}`) ?? 0) + kg);
  }

  const contractorRate = (workshop: string): number | null => {
    if (!rates) return null;
    const key = Object.keys(rates.contractor).find(k => sameContractor(workshop, k, aliases));
    return key ? rates.contractor[key] : null;
  };
  /** Списание на тонну по «Выпуску сторонних»: по подрядчику и шифру, иначе по шифру. */
  const extMetalPerT = (workshop: string, opp: number): number | null => {
    const rows = prodExt.filter(r => r.opp === opp && r.outputT > 0);
    const own = rows.filter(r => sameContractor(workshop, r.workshop, aliases));
    const use = own.length ? own : rows;
    const t = use.reduce((s, r) => s + r.outputT, 0);
    return t > 0 ? use.reduce((s, r) => s + r.totalRub, 0) / t : null;
  };

  return acts.rows.map(([month, legal, workshop, opp, kg]) => {
    const group = workshopGroup(legal);
    const outputT = kg / 1000;
    const price = opp !== null ? priceByOpp.get(opp) : undefined;
    const ref = opp !== null ? refByOpp.get(opp) : undefined;
    const pricePerT = price?.pricePerT ?? null;
    const revenue = pricePerT !== null ? outputT * pricePerT : null;
    const issues: string[] = [];
    if (pricePerT === null) issues.push(opp === null ? 'нет шифра' : 'нет цены за тонну (нет ТКП по шифру)');
    let metalRub: number | null = null;
    let metalEstimated = false;
    let rate: number | null = null;
    let processingRub: number | null = null;
    if (group === 'own') {
      const total = opp !== null ? ownMetal.get(`${month}|${opp}`) : undefined;
      const base = opp !== null ? ownActsKg.get(`${month}|${opp}`) ?? 0 : 0;
      if (total !== undefined && base > 0) metalRub = total * (kg / base);
      else issues.push('нет списания в «Выпуске СЗ» за месяц');
      rate = rates?.ownByMonth[month] ?? null;
      if (rate === null) issues.push(`нет коэффициента СЗ за ${month}`);
    } else if (group === 'ext_our_metal') {
      const perT = opp !== null ? extMetalPerT(workshop, opp) : null;
      if (perT !== null) {
        metalRub = outputT * perT;
        metalEstimated = true;
      } else issues.push('нет списания в «Выпуске сторонних цехов»');
      rate = contractorRate(workshop);
      if (rate === null) issues.push('нет расценки подрядчика');
    } else {
      issues.push('затраты — в «Переразмещениях» Комплектации');
    }
    if (rate !== null) processingRub = outputT * 1000 * rate;
    const result = revenue !== null && group !== 'ext' ? sumOrNull(revenue, metalRub === null ? null : -metalRub, processingRub === null ? null : -processingRub) : null;
    return {
      key: `${month}|${legal}|${workshop}|${opp ?? ''}`, month, legal, group, workshop, opp,
      b24: price?.b24 ?? ref?.b24 ?? null,
      customer: (acts.customers[String(opp)] || price?.customer || ref?.client || '').replace(/\s+/g, ' ').trim(),
      outputT, pricePerT, revenue, metalRub, metalEstimated, rate, processingRub, result,
      margin: result !== null && revenue ? result / revenue : null, issue: issues.join('; '),
    };
  });
}

/** Итоги по строкам; финрез и рентабельность — только по строкам, где он рассчитан. */
export function workshopTotals(rows: readonly WorkshopRow[]) {
  const sum = (f: (r: WorkshopRow) => number | null) => {
    const v = rows.map(f).filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) : null;
  };
  const complete = rows.filter(r => r.result !== null && r.revenue !== null);
  const rev = complete.reduce((s, r) => s + (r.revenue as number), 0);
  const res = complete.reduce((s, r) => s + (r.result as number), 0);
  return {
    outputT: sum(r => r.outputT), revenue: sum(r => r.revenue), metalRub: sum(r => r.metalRub), processingRub: sum(r => r.processingRub),
    result: sum(r => r.result), margin: rev ? res / rev : null, incomplete: rows.length - complete.length,
  };
}
