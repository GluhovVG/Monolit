import type { ActsFile, ActTuple } from '../import/acts';
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
 * – Сторонние цеха: металл = «Сумма всего с НДС» из «Выпуска сторонних цехов» (тот же отчёт, что в себестоимости сделок)
 *   по шифру и подрядчику; отчёт без месяцев, поэтому сумма распределяется по месяцам пропорционально выпуску по «Актам».
 *   Переработка = выпуск × 1000 × расценка подрядчика; без расценки работа идёт через «Переразмещения» Комплектации —
 *   помесячно её нет, финрез не считается.
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
  /** Металл сторонних распределён по месяцам пропорционально выпуску (в отчёте нет месяцев). */
  metalAllocated: boolean;
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
  // Металл сторонних: списание по шифру и подрядчику из «Выпуска сторонних цехов» делится между строками «Актов»
  // этого шифра и подрядчика (все месяцы) пропорционально выпуску.
  // «Выпуск сторонних цехов» выгружается с даты начала отчётов о выпуске — «Акты» раньше этой даты не участвуют.
  const since = prodOwn.reduce<string | null>((m, r) => (r.month && (!m || r.month < m) ? r.month : m), null);
  const extActs = acts.rows.filter(r => r[3] !== null && workshopGroup(r[1]) !== 'own' && (!since || r[0] >= since));
  const extMetal = new Map<ActTuple, number>();
  for (const opp of new Set(prodExt.map(r => r.opp).filter((o): o is number => o !== null))) {
    const prod = prodExt.filter(r => r.opp === opp && r.totalRub !== 0);
    const actsOfOpp = extActs.filter(a => a[3] === opp);
    for (const a of actsOfOpp) {
      const matched = prod.filter(p => sameContractor(a[2], p.workshop, aliases));
      if (!matched.length) continue;
      const writeOff = matched.reduce((s, p) => s + p.totalRub, 0);
      // База распределения — строки «Актов» того же подрядчика по шифру; наш металл получают строки «из н/м»,
      // строки «на металле подрядчика» — только если у подрядчика по шифру нет строк «из н/м».
      const sameShop = actsOfOpp.filter(b => matched.some(p => sameContractor(b[2], p.workshop, aliases)));
      const ourMetal = sameShop.filter(b => workshopGroup(b[1]) === 'ext_our_metal');
      const peers = ourMetal.length ? ourMetal : sameShop;
      if (!peers.includes(a)) continue;
      const kg = peers.reduce((s, b) => s + b[4], 0);
      if (kg > 0) extMetal.set(a, writeOff * (a[4] / kg));
    }
  }

  return acts.rows.map(act => {
    const [month, legal, workshop, opp, kg] = act;
    const group = workshopGroup(legal);
    const outputT = kg / 1000;
    const price = opp !== null ? priceByOpp.get(opp) : undefined;
    const ref = opp !== null ? refByOpp.get(opp) : undefined;
    const pricePerT = price?.pricePerT ?? null;
    const revenue = pricePerT !== null ? outputT * pricePerT : null;
    const issues: string[] = [];
    if (pricePerT === null) issues.push(opp === null ? 'нет шифра' : 'нет цены за тонну (нет ТКП по шифру)');
    let metalRub: number | null = null;
    let metalAllocated = false;
    let rate: number | null = null;
    let processingRub: number | null = null;
    if (group === 'own') {
      const total = opp !== null ? ownMetal.get(`${month}|${opp}`) : undefined;
      const base = opp !== null ? ownActsKg.get(`${month}|${opp}`) ?? 0 : 0;
      if (total !== undefined && base > 0) metalRub = total * (kg / base);
      else issues.push('нет списания в «Выпуске СЗ» за месяц');
      rate = rates?.ownByMonth[month] ?? null;
      if (rate === null) issues.push(`нет коэффициента СЗ за ${month}`);
    } else {
      const m = extMetal.get(act);
      if (m !== undefined) {
        metalRub = m;
        metalAllocated = true;
      } else {
        // Металл подрядчика не списывается с нашего склада — списания может не быть.
        metalRub = group === 'ext' ? 0 : null;
        if (group !== 'ext') issues.push('нет списания по подрядчику в «Выпуске сторонних цехов»');
      }
      // Расценка «Расценок» — за переработку нашего металла; изделия на металле подрядчика оплачиваются через «Переразмещения».
      rate = group === 'ext_our_metal' ? contractorRate(workshop) : null;
      if (rate === null) issues.push(group === 'ext' ? 'металл подрядчика — затраты в «Переразмещениях» Комплектации' : 'нет расценки подрядчика — работа в «Переразмещениях» Комплектации');
    }
    if (rate !== null) processingRub = outputT * 1000 * rate;
    const result = revenue !== null ? sumOrNull(revenue, metalRub === null ? null : -metalRub, processingRub === null ? null : -processingRub) : null;
    return {
      key: `${month}|${legal}|${workshop}|${opp ?? ''}`, month, legal, group, workshop, opp,
      b24: price?.b24 ?? ref?.b24 ?? null,
      customer: (acts.customers[String(opp)] || price?.customer || ref?.client || '').replace(/\s+/g, ' ').trim(),
      outputT, pricePerT, revenue, metalRub, metalAllocated, rate, processingRub, result,
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

/**
 * Сверка источников выпуска: «Акты» против отчётов о выпуске, по которым считается себестоимость.
 * Завод — по месяцу и шифру («Выпуск СЗ»); сторонние — по шифру за весь период («Выпуск сторонних цехов» без месяцев).
 * Сюда же позже встанет выпуск из 1С. Расхождения показываются, источник не подменяется молча.
 */
export type OutputCheckRow = { scope: 'own' | 'ext'; month: string | null; opp: number; actsT: number; reportT: number; diffT: number };

const NOT_PRODUCTION = /склад готовой продукции/i;

export function outputReconciliation(
  acts: ActsFile, prodOwn: readonly ProductionRow[], prodExt: readonly ProductionRow[],
): OutputCheckRow[] {
  const since = prodOwn.reduce<string | null>((m, r) => (r.month && (!m || r.month < m) ? r.month : m), null);
  const own = new Map<string, { month: string; opp: number; a: number; r: number }>();
  const ext = new Map<number, { a: number; r: number }>();
  for (const [month, legal, , opp, kg] of acts.rows) {
    if (opp === null) continue;
    if (workshopGroup(legal) === 'own') {
      const k = `${month}|${opp}`;
      const x = own.get(k) ?? { month, opp, a: 0, r: 0 };
      x.a += kg / 1000;
      own.set(k, x);
    } else if (!since || month >= since) {
      const x = ext.get(opp) ?? { a: 0, r: 0 };
      x.a += kg / 1000;
      ext.set(opp, x);
    }
  }
  const months = new Set(acts.periods);
  for (const r of prodOwn) {
    // Сравниваются только месяцы, которые есть в «Актах».
    if (r.opp === null || !r.month || !months.has(r.month)) continue;
    const k = `${r.month}|${r.opp}`;
    const x = own.get(k) ?? { month: r.month, opp: r.opp, a: 0, r: 0 };
    x.r += r.outputT;
    own.set(k, x);
  }
  for (const r of prodExt) {
    if (r.opp === null || NOT_PRODUCTION.test(r.workshop)) continue;
    const x = ext.get(r.opp) ?? { a: 0, r: 0 };
    x.r += r.outputT;
    ext.set(r.opp, x);
  }
  const out: OutputCheckRow[] = [];
  for (const x of own.values()) out.push({ scope: 'own', month: x.month, opp: x.opp, actsT: x.a, reportT: x.r, diffT: x.a - x.r });
  for (const [opp, x] of ext) out.push({ scope: 'ext', month: null, opp, actsT: x.a, reportT: x.r, diffT: x.a - x.r });
  // Акты — брутто с упаковкой: расхождение до 0,5 т или 3 % считается нормой.
  return out.filter(r => Math.abs(r.diffT) > Math.max(0.5, 0.03 * Math.abs(r.reportT)))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'own' ? -1 : 1) || (b.month ?? '').localeCompare(a.month ?? '') || Math.abs(b.diffT) - Math.abs(a.diffT));
}
