import type { DepartmentFile } from '../import/department';
import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import { computeMkLines, groupByOpp, type ContractorAliases, type MkByOpp, type MkIssue } from './mk-production';

export type BlockResult = {
  department: string;
  period: string;
  revenuePlan: number | null;
  revenueFact: number | null;
  costPlan: number | null;
  costFact: number | null;
  profitPlan: number | null;
  profitFact: number | null;
  fileName: string;
  sourceRow: number;
};

export type ConsolidatedDeal = {
  key: string;
  b24: number | null;
  name: string;
  client: string;
  tankCodes: string[];
  opps: number[];
  blocks: BlockResult[];
  mk: { outputT: number; metalRub: number; workRub: number; totalRub: number; byOpp: MkByOpp[] } | null;
  issues: DealIssue[];
};

export type DealIssue = { level: 'blocker' | 'warning'; code: string; message: string };

export type WorkspaceData = {
  reference: ReferenceRow[] | null;
  rates: Rates | null;
  prodOwn: ProductionRow[] | null;
  prodExt: ProductionRow[] | null;
  departments: DepartmentFile[];
  /** dept deal name (lowercased, trimmed) → Б24 confirmed by a user. */
  dealAliases: Record<string, number>;
  contractorAliases: ContractorAliases;
};

export type Consolidation = {
  deals: ConsolidatedDeal[];
  /** Deals from «Номера заказов» that have MK production, including those without department files. */
  productionDeals: ConsolidatedDeal[];
  globalIssues: MkIssue[];
  /** Workshops in the external report without a rate (exact or confirmed alias). */
  missingContractors: string[];
  unmatchedDealNames: string[];
  unmatchedProductionOpps: number[];
  departments: string[];
  periods: string[];
};

export const dealNameKey = (name: string) => name.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function consolidate(data: WorkspaceData): Consolidation {
  const ref = data.reference ?? [];
  const dealsByB24 = new Map<number, { client: string; tanks: Set<string>; opps: Set<number> }>();
  const dealsByOpp = new Map<number, Set<number>>();
  for (const row of ref) {
    if (row.b24 === null) continue;
    const d = dealsByB24.get(row.b24) ?? { client: row.client, tanks: new Set<string>(), opps: new Set<number>() };
    if (!d.client && row.client) d.client = row.client;
    if (row.tankCode) d.tanks.add(row.tankCode);
    if (row.opp !== null) {
      d.opps.add(row.opp);
      const s = dealsByOpp.get(row.opp) ?? new Set<number>();
      s.add(row.b24);
      dealsByOpp.set(row.opp, s);
    }
    dealsByB24.set(row.b24, d);
  }

  const { lines, issues: mkIssues, missingContractors } = computeMkLines(data.prodOwn ?? [], data.prodExt ?? [], data.rates, data.contractorAliases);
  const byOpp = groupByOpp(lines);
  const knownOpps = new Set(ref.map(r => r.opp).filter((x): x is number => x !== null));
  const unmatchedProductionOpps = Array.from(byOpp.keys()).filter(opp => !knownOpps.has(opp)).sort((a, b) => a - b);

  const mkFor = (opps: number[]) => {
    const items = opps.map(opp => byOpp.get(opp)).filter((x): x is MkByOpp => Boolean(x));
    if (!items.length) return null;
    return {
      outputT: items.reduce((s, x) => s + x.outputT, 0),
      metalRub: items.reduce((s, x) => s + x.metalRub, 0),
      workRub: items.reduce((s, x) => s + x.workRub, 0),
      totalRub: items.reduce((s, x) => s + x.totalRub, 0),
      byOpp: items,
    };
  };

  const build = (key: string, b24: number | null, name: string): ConsolidatedDeal => {
    const refDeal = b24 !== null ? dealsByB24.get(b24) : undefined;
    const opps = refDeal ? Array.from(refDeal.opps).sort((a, b) => a - b) : [];
    const issues: DealIssue[] = [];
    if (b24 === null) issues.push({ level: 'warning', code: 'NO_B24', message: 'Не найден номер сделки Б24: шифр ОПП не сопоставлен.' });
    else if (!refDeal) issues.push({ level: 'warning', code: 'NOT_IN_REFERENCE', message: `Сделки ${b24} нет в «Номерах заказов».` });
    else if (!opps.length) issues.push({ level: 'warning', code: 'NO_OPP', message: 'В «Номерах заказов» у сделки нет шифра для бухгалтерии.' });
    for (const opp of opps) {
      const shared = dealsByOpp.get(opp);
      if (shared && shared.size > 1) {
        issues.push({ level: 'warning', code: 'SHARED_OPP',
          message: `Шифр ${opp} указан у нескольких сделок (${Array.from(shared).join(', ')}): затраты МК показаны в каждой.` });
      }
    }
    const mk = mkFor(opps);
    if (mk) {
      for (const item of mk.byOpp) {
        if (item.lines.some(l => l.rate === null && l.outputT !== 0)) {
          issues.push({ level: 'blocker', code: 'MK_NO_RATE', message: `По шифру ${item.opp} часть выпуска без коэффициента/расценки.` });
        }
      }
    }
    return { key, b24, name, client: refDeal?.client ?? '', tankCodes: refDeal ? Array.from(refDeal.tanks) : [], opps, blocks: [], mk, issues };
  };

  const deals = new Map<string, ConsolidatedDeal>();
  const unmatched = new Set<string>();
  for (const file of data.departments) {
    for (const d of file.deals) {
      const b24 = d.b24 ?? data.dealAliases[dealNameKey(d.name)] ?? null;
      const key = b24 !== null ? `b24:${b24}` : `name:${dealNameKey(d.name)}`;
      if (b24 === null) unmatched.add(d.name);
      const deal = deals.get(key) ?? build(key, b24, d.name);
      deal.blocks.push({
        department: file.department, period: file.period, fileName: file.fileName, sourceRow: d.sourceRow,
        revenuePlan: d.revenuePlan, revenueFact: d.revenueFact, costPlan: d.costPlan, costFact: d.costFact,
        profitPlan: d.profitPlan, profitFact: d.profitFact,
      });
      if (d.revenueFact !== null && d.costFact !== null && d.profitFact !== null
        && Math.abs(d.revenueFact - d.costFact - d.profitFact) > 1) {
        deal.issues.push({ level: 'blocker', code: 'PROFIT_MISMATCH',
          message: `${file.department} ${file.period}: прибыль не равна выручке минус себестоимость (строка ${d.sourceRow}).` });
      }
      deals.set(key, deal);
    }
  }
  for (const deal of deals.values()) {
    const keys = new Map<string, number>();
    for (const block of deal.blocks) keys.set(block.department + '|' + block.period, (keys.get(block.department + '|' + block.period) ?? 0) + 1);
    for (const [k, n] of keys) if (n > 1) {
      deal.issues.push({ level: 'blocker', code: 'DUPLICATE_BLOCK', message: `Сделка встречается ${n} раза в «${k.replace('|', '» за ')}».` });
    }
  }

  const productionDeals = Array.from(dealsByB24.keys())
    .map(b24 => build(`b24:${b24}`, b24, dealsByB24.get(b24)!.client || `Сделка ${b24}`))
    .filter(d => d.mk !== null)
    .sort((a, b) => (b.mk?.totalRub ?? 0) - (a.mk?.totalRub ?? 0));

  const list = Array.from(deals.values()).sort((a, b) => (a.b24 ?? 1e9) - (b.b24 ?? 1e9) || a.name.localeCompare(b.name));
  return {
    deals: list,
    productionDeals,
    globalIssues: mkIssues,
    missingContractors,
    unmatchedDealNames: Array.from(unmatched).sort(),
    unmatchedProductionOpps,
    departments: Array.from(new Set(data.departments.map(f => f.department))).sort(),
    periods: Array.from(new Set(data.departments.map(f => f.period))).sort(),
  };
}

export const sumOrNull = (values: Array<number | null>) =>
  values.some(v => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
