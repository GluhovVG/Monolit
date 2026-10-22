import type { DepartmentFile } from '../import/department';
import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import { normalizeName } from '../import/sheet';
import { matchPositionOpp, type TkpFile, type TkpPosition } from '../import/tkp';
import { computeMkLines, type ContractorAliases, type MkIssue, type MkLine } from './mk-production';

/**
 * Реестр сделок по образцу листа «Сделки» (Управленческий учёт 2025): одна строка = один шифр
 * для бухгалтерии (ОПП), т.е. один тип баков сделки. Связь «сделка Б24 → бак → ОПП» — через «Номера заказов».
 *
 * Выручка план = Стоимость МК план (ТКП) + бюджеты блоков; выручка факт = Стоимость МК факт (ТКП) + бюджеты блоков.
 * Себестоимость план = Себестоимость МК план (ТКП) + бюджеты блоков.
 * Себестоимость факт = Себестоимость МК (выпуск) + факт блоков + БГ/штрафы.
 * Себестоимость МК = завод (списание «Сумма всего с НДС» + выпуск т × 1000 × коэффициент месяца)
 *                  + сторонние (списание + выпуск × расценка подрядчика; без расценки — «Переразмещения (частичные)»).
 */

export type BlockKey = 'docs' | 'supply' | 'delivery' | 'smr';
export const BLOCKS: ReadonlyArray<{ key: BlockKey; label: string }> = [
  { key: 'docs', label: 'Документация' },
  { key: 'supply', label: 'Комплектация' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'smr', label: 'СМР' },
];

/** Department (file name) → block of the deal. ОМТС is shown for information only. */
export function blockOfDepartment(department: string): BlockKey | 'omts' | null {
  const d = department.toLowerCase().replace(/ё/g, 'е');
  if (/проект|документ/.test(d)) return 'docs';
  if (/комплект/.test(d)) return 'supply';
  if (/логист|доставк/.test(d)) return 'delivery';
  if (/смр|монтаж|строит/.test(d)) return 'smr';
  if (/омтс/.test(d)) return 'omts';
  return null;
}

export type RegisterLine = {
  department: string;
  period: string;
  fileName: string;
  sourceRow: number;
  block: string;
  tank: string;
  name: string;
  supplier: string;
  note: string;
  budgetRub: number | null;
  factRub: number | null;
  weightT: number | null;
  /** Part of the line attributed to this ОПП: 1 when the tank in the line resolves to it. */
  share: number;
  by: 'tank' | 'share';
};

export type BlockPlanFact = { plan: number | null; fact: number | null; lines: RegisterLine[] };
export type MkSide = { totalRub: number; writeOffRub: number; workRub: number; outputKg: number };
export type OppMk = {
  own: MkSide;
  ext: MkSide & { reallocationRub: number };
  costRub: number;
  outputKg: number;
  lines: MkLine[];
  /** «Переразмещения (частичные)» of Комплектация counted as contractor work. */
  reallocations: RegisterLine[];
  /** Reallocations not counted because the contractor already has a rate for this ОПП. */
  skippedReallocations: RegisterLine[];
};

export type DealIssue = { level: 'blocker' | 'warning' | 'info'; code: string; message: string };

export type OppRow = {
  key: string;
  opp: number | null;
  b24: number | null;
  customer: string;
  product: string;
  /** Tanks of this ОПП from «Номера заказов»: «ШИФР Тип-Объём/номер-Заказчик №заводской». */
  tanks: string[];
  period: string | null;
  /** Share of deal-level amounts (contract, fines, lines without tank). */
  share: number;
  tkp: TkpPosition[];
  weightPlanKg: number | null;
  mkValuePlan: number | null;
  mkValueFact: number | null;
  mkCostPlan: number | null;
  blocks: Record<BlockKey, BlockPlanFact>;
  omts: BlockPlanFact;
  finesRub: number | null;
  contractShareRub: number | null;
  mk: OppMk | null;
  revenuePlan: number | null;
  revenueFact: number | null;
  costPlan: number | null;
  costFact: number | null;
  profitPlan: number | null;
  profitFact: number | null;
  mkProfitPlan: number | null;
  mkProfitFact: number | null;
  weightFactKg: number | null;
  /** Стоимость МК факт / вес факт, руб/кг. */
  priceKg: number | null;
  issues: DealIssue[];
};

export type DealGroup = {
  key: string;
  b24: number | null;
  customer: string;
  product: string;
  contractRub: number | null;
  finesRub: number | null;
  departments: string[];
  rows: OppRow[];
  issues: DealIssue[];
};

export type ProductionOpp = {
  opp: number;
  b24: number | null;
  customer: string;
  tanks: string[];
  /** In «Номера заказов» = finished production; otherwise work in progress (not an error). */
  finished: boolean;
  mk: OppMk;
};

export type WorkspaceData = {
  reference: ReferenceRow[] | null;
  rates: Rates | null;
  prodOwn: ProductionRow[] | null;
  prodExt: ProductionRow[] | null;
  departments: DepartmentFile[];
  tkp: TkpFile[];
  /** dept deal name key → Б24 confirmed by a user. */
  dealAliases: Record<string, number>;
  contractorAliases: ContractorAliases;
};

export type Consolidation = {
  rows: OppRow[];
  deals: DealGroup[];
  production: ProductionOpp[];
  globalIssues: MkIssue[];
  missingContractors: string[];
  unmatchedDealNames: string[];
  /** Codes in production reports that are not in «Номера заказов» (not finished yet). */
  unfinishedOpps: number[];
  departments: string[];
  missingBlocks: string[];
  periods: string[];
};

export const dealNameKey = (name: string) => name.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export const sumOrNull = (values: Array<number | null | undefined>) =>
  values.some(v => v !== null && v !== undefined) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
const minus = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const plus = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

const emptyBlock = (): BlockPlanFact => ({ plan: null, fact: null, lines: [] });
const emptySide = (): MkSide => ({ totalRub: 0, writeOffRub: 0, workRub: 0, outputKg: 0 });
const normTank = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/e/g, 'е').replace(/[\s№]/g, '');
export const tankLabel = (r: ReferenceRow) => (r.factoryNo && r.factoryNo !== '-' ? `${r.tankCode} №${r.factoryNo}` : r.tankCode);

/** Tank text of a department line («РВС-2500/1-… №138/25», two tanks joined by «и») → ОПП of the deal. */
export function resolveTankOpp(tank: string, dealRows: readonly ReferenceRow[]): number | null {
  if (!tank.trim()) return null;
  const numbers = Array.from(tank.matchAll(/(\d{1,4}\/\d{2})(?!\d)/g)).map(m => m[1]);
  let hits = dealRows.filter(r => r.opp !== null && r.factoryNo && numbers.includes(r.factoryNo));
  if (!hits.length) {
    const t = normTank(tank);
    hits = dealRows.filter(r => r.opp !== null && r.tankCode && t.includes(normTank(r.tankCode)));
  }
  const opps = new Set(hits.map(r => r.opp as number));
  return opps.size === 1 ? Array.from(opps)[0] : null;
}

/** Same contractor in two spellings: normalised names equal or one contains the other. */
export function sameContractor(a: string, b: string, aliases: ContractorAliases = {}): boolean {
  const x = aliases[normalizeName(a)] ?? normalizeName(a);
  const y = aliases[normalizeName(b)] ?? normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 4 && l.includes(s);
}

function buildMk(lines: MkLine[], reallocations: RegisterLine[], aliases: ContractorAliases): OppMk {
  const own = emptySide();
  const ext = { ...emptySide(), reallocationRub: 0 };
  for (const l of lines) {
    const side = l.source === 'own' ? own : ext;
    side.writeOffRub += l.metalRub;
    side.workRub += l.workRub;
    side.outputKg += l.outputT * 1000;
  }
  const counted: RegisterLine[] = [];
  const skipped: RegisterLine[] = [];
  for (const r of reallocations) {
    const rated = lines.some(l => l.source === 'external' && l.rate !== null && l.rate > 0 && sameContractor(l.workshop, r.supplier, aliases));
    (rated ? skipped : counted).push(r);
  }
  ext.reallocationRub = counted.reduce((s, r) => s + (r.factRub ?? 0) * r.share, 0);
  own.totalRub = own.writeOffRub + own.workRub;
  ext.totalRub = ext.writeOffRub + ext.workRub + ext.reallocationRub;
  return {
    own, ext, costRub: own.totalRub + ext.totalRub, outputKg: own.outputKg + ext.outputKg,
    lines, reallocations: counted, skippedReallocations: skipped,
  };
}

const isReallocation = (block: string) => /переразмещ/i.test(block);

export function consolidate(data: WorkspaceData): Consolidation {
  const ref = data.reference ?? [];
  const refByB24 = new Map<number, ReferenceRow[]>();
  const refByOpp = new Map<number, ReferenceRow[]>();
  for (const r of ref) {
    if (r.b24 !== null) refByB24.set(r.b24, [...(refByB24.get(r.b24) ?? []), r]);
    if (r.opp !== null) refByOpp.set(r.opp, [...(refByOpp.get(r.opp) ?? []), r]);
  }

  // ── Production МК per ОПП ──
  const { lines: mkLines, issues: mkIssues, missingContractors } =
    computeMkLines(data.prodOwn ?? [], data.prodExt ?? [], data.rates, data.contractorAliases);
  const linesByOpp = new Map<number, MkLine[]>();
  for (const l of mkLines) if (l.opp !== null) linesByOpp.set(l.opp, [...(linesByOpp.get(l.opp) ?? []), l]);
  const unfinishedOpps = Array.from(linesByOpp.keys()).filter(o => !refByOpp.has(o)).sort((a, b) => a - b);

  const tkpByB24 = new Map<number, TkpFile>();
  for (const t of data.tkp) if (t.b24 !== null) tkpByB24.set(t.b24, t);

  // ── Deals from department files ──
  type Acc = {
    key: string; b24: number | null; customer: string; product: string;
    contracts: number[]; fines: number[]; periods: Set<string>; departments: Set<string>;
    lines: Array<Omit<RegisterLine, 'share' | 'by'> & { blockKey: BlockKey | 'omts' | 'mk' | null }>;
    seen: Map<string, Set<string>>; issues: DealIssue[];
  };
  const accs = new Map<string, Acc>();
  const unmatched = new Set<string>();
  for (const file of data.departments) {
    const fileBlock = blockOfDepartment(file.department);
    for (const d of file.deals) {
      const nameKey = dealNameKey(`${d.customer} ${d.product}`);
      const b24 = d.b24 ?? data.dealAliases[nameKey] ?? null;
      if (b24 === null) unmatched.add(`${d.customer} ${d.product}`.trim());
      const key = b24 !== null ? `b24:${b24}` : `name:${nameKey}`;
      const acc: Acc = accs.get(key) ?? {
        key, b24, customer: d.customer, product: d.product, contracts: [], fines: [], periods: new Set(),
        departments: new Set(), lines: [], seen: new Map(), issues: [],
      };
      if (!acc.customer) acc.customer = d.customer;
      if (!acc.product) acc.product = d.product;
      if (d.contractRub !== null) acc.contracts.push(d.contractRub);
      if (d.finesRub !== null) acc.fines.push(d.finesRub);
      acc.periods.add(file.period);
      acc.departments.add(file.department);
      const seen = acc.seen.get(file.department) ?? new Set<string>();
      seen.add(file.period);
      acc.seen.set(file.department, seen);
      for (const l of d.lines) {
        acc.lines.push({
          department: file.department, period: file.period, fileName: file.fileName, sourceRow: l.sourceRow,
          block: l.block, tank: l.tank, name: l.name, supplier: l.supplier, note: l.note,
          budgetRub: l.budgetRub, factRub: l.factRub, weightT: l.weightT,
          blockKey: isReallocation(l.block) ? 'mk' : fileBlock,
        });
      }
      accs.set(key, acc);
    }
  }

  const rows: OppRow[] = [];
  const deals: DealGroup[] = [];
  for (const acc of accs.values()) {
    const issues: DealIssue[] = [];
    const dealRef = acc.b24 !== null ? refByB24.get(acc.b24) ?? [] : [];
    if (acc.b24 === null) issues.push({ level: 'warning', code: 'NO_B24', message: 'Нет ссылки на сделку Б24: шифр ОПП не определён.' });
    else if (!dealRef.length) issues.push({ level: 'warning', code: 'NOT_IN_REFERENCE', message: `Сделки ${acc.b24} нет в «Номерах заказов».` });
    for (const [dep, periods] of acc.seen) {
      if (periods.size > 1) issues.push({ level: 'blocker', code: 'DUPLICATE_BLOCK', message: `Сделка закрыта в «${dep}» несколько раз: ${Array.from(periods).sort().join(', ')}.` });
    }
    const contract = acc.contracts.length ? acc.contracts[0] : null;
    if (acc.contracts.some(c => Math.abs(c - acc.contracts[0]) > 1)) {
      issues.push({ level: 'warning', code: 'CONTRACT_MISMATCH', message: `Сумма договора различается в файлах подразделений: ${Array.from(new Set(acc.contracts.map(Math.round))).join(' / ')}.` });
    }
    const fines = acc.fines.length ? Math.max(...acc.fines) : null;

    // ОПП of the deal (one row per tank type).
    const opps = Array.from(new Set(dealRef.map(r => r.opp).filter((x): x is number => x !== null))).sort((a, b) => a - b);
    if (dealRef.length && !opps.length) issues.push({ level: 'warning', code: 'NO_OPP', message: 'В «Номерах заказов» у сделки нет шифра для бухгалтерии.' });
    const rowOpps: Array<number | null> = opps.length ? opps : [null];

    // ТКП positions → ОПП.
    const tkp = acc.b24 !== null ? tkpByB24.get(acc.b24) : undefined;
    const tkpByOpp = new Map<number | null, TkpPosition[]>();
    if (!tkp) issues.push({ level: 'warning', code: 'NO_TKP', message: 'Не загружен «Расчёт ТКП»: нет плана МК (стоимость, себестоимость, вес).' });
    for (const p of tkp?.positions ?? []) {
      let { opp, candidates } = matchPositionOpp(p.name, dealRef);
      if (opp === null && opps.length === 1 && tkp!.positions.length === 1) opp = opps[0];
      if (opp === null) {
        issues.push({ level: 'blocker', code: 'TKP_NO_OPP', message: `Позиция ТКП «${p.name}» не сопоставлена с ОПП${candidates.length ? ` (подходят ${candidates.join(', ')})` : ''}.` });
        continue;
      }
      tkpByOpp.set(opp, [...(tkpByOpp.get(opp) ?? []), p]);
    }

    // Shares for deal-level amounts: by MK value (ТКП), else by output, else by number of tanks.
    const weightsBy = (f: (opp: number | null) => number) => rowOpps.map(f);
    let weights = weightsBy(o => (tkpByOpp.get(o) ?? []).reduce((s, p) => s + (p.mkValuePlan ?? 0), 0));
    if (weights.some(w => w <= 0)) weights = weightsBy(o => (o !== null ? linesByOpp.get(o) ?? [] : []).reduce((s, l) => s + l.outputT, 0));
    if (weights.some(w => w <= 0)) weights = weightsBy(o => dealRef.filter(r => r.opp === o).length);
    if (weights.some(w => w <= 0)) weights = rowOpps.map(() => 1);
    const total = weights.reduce((s, w) => s + w, 0);
    const shares = new Map(rowOpps.map((o, i) => [o, weights[i] / total]));

    // Lines → ОПП.
    const perOpp = new Map<number | null, RegisterLine[]>(rowOpps.map(o => [o, []]));
    const blockKeyOf = new Map<RegisterLine, BlockKey | 'omts' | 'mk' | null>();
    let unresolvedTanks = 0;
    for (const { blockKey, ...l } of acc.lines) {
      const opp = rowOpps.length > 1 ? resolveTankOpp(l.tank, dealRef) : rowOpps[0];
      if (opp !== null && perOpp.has(opp)) {
        const line: RegisterLine = { ...l, share: 1, by: 'tank' };
        perOpp.get(opp)!.push(line);
        blockKeyOf.set(line, blockKey);
      } else {
        if (l.tank) unresolvedTanks += 1;
        for (const o of rowOpps) {
          const line: RegisterLine = { ...l, share: shares.get(o) ?? 0, by: 'share' };
          perOpp.get(o)!.push(line);
          blockKeyOf.set(line, blockKey);
        }
      }
    }
    if (unresolvedTanks) {
      issues.push({ level: 'warning', code: 'TANK_NOT_RESOLVED', message: `${unresolvedTanks} строк с шифром бака не сопоставлены с ОПП — распределены по долям.` });
    }
    const unknownBlocks = Array.from(new Set(acc.lines.filter(l => l.blockKey === null).map(l => l.department)));
    if (unknownBlocks.length) issues.push({ level: 'warning', code: 'UNKNOWN_BLOCK', message: `Подразделение не отнесено к блоку сделки и не учтено: ${unknownBlocks.join(', ')}.` });

    const period = Array.from(acc.periods).sort().pop() ?? null;
    const groupRows: OppRow[] = [];
    for (const opp of rowOpps) {
      const share = shares.get(opp) ?? 0;
      const lines = perOpp.get(opp) ?? [];
      const blocks = { docs: emptyBlock(), supply: emptyBlock(), delivery: emptyBlock(), smr: emptyBlock() } as Record<BlockKey, BlockPlanFact>;
      const omts = emptyBlock();
      const reallocations: RegisterLine[] = [];
      for (const line of lines) {
        const k = blockKeyOf.get(line);
        if (k === 'mk') { reallocations.push(line); continue; }
        const target = k === 'omts' ? omts : k ? blocks[k] : null;
        if (!target) continue;
        target.lines.push(line);
        if (line.budgetRub !== null) target.plan = (target.plan ?? 0) + line.budgetRub * line.share;
        if (line.factRub !== null) target.fact = (target.fact ?? 0) + line.factRub * line.share;
      }
      const prodLines = opp !== null ? linesByOpp.get(opp) ?? [] : [];
      const mk = prodLines.length || reallocations.length ? buildMk(prodLines, reallocations, data.contractorAliases) : null;
      const positions = tkpByOpp.get(opp) ?? [];
      const tkpSum = (f: (p: TkpPosition) => number | null) => sumOrNull(positions.map(f));
      const weightPlanKg = tkpSum(p => p.weightPlanKg);
      const mkValuePlan = tkpSum(p => p.mkValuePlan);
      const mkValueFact = tkpSum(p => p.mkValueFact ?? p.mkValuePlan);
      const mkCostPlan = tkpSum(p => p.mkCostPlan);
      const blocksPlan = sumOrNull(BLOCKS.map(b => blocks[b.key].plan)) ?? 0;
      const blocksFact = sumOrNull(BLOCKS.map(b => blocks[b.key].fact));
      const finesRub = fines !== null ? fines * share : null;
      const revenuePlan = mkValuePlan !== null ? mkValuePlan + blocksPlan : null;
      const revenueFact = mkValueFact !== null ? mkValueFact + blocksPlan : null;
      const costPlan = mkCostPlan !== null ? mkCostPlan + blocksPlan : null;
      const costFact = sumOrNull([mk?.costRub ?? null, blocksFact, finesRub]);
      const weightFactKg = mk && mk.outputKg > 0 ? mk.outputKg : null;
      const rowIssues: DealIssue[] = [];
      if (opp !== null && !prodLines.length && (mkCostPlan ?? 0) > 0) {
        rowIssues.push({ level: 'blocker', code: 'NO_PRODUCTION', message: `По шифру ${opp} нет выпуска МК в отчётах, хотя в ТКП есть МК: себестоимость МК не рассчитана.` });
      }
      const noRate = prodLines.filter(l => l.rate === null && l.outputT !== 0);
      if (noRate.some(l => l.source === 'own')) {
        rowIssues.push({ level: 'blocker', code: 'MK_NO_COEF', message: `По шифру ${opp} нет коэффициента СЗ за месяц выпуска.` });
      }
      const extNoRate = noRate.filter(l => l.source === 'external');
      if (extNoRate.length && !(mk?.reallocations.length)) {
        rowIssues.push({ level: 'blocker', code: 'MK_NO_RATE', message: `По шифру ${opp} у подрядчиков без расценки (${Array.from(new Set(extNoRate.map(l => l.workshop))).join(', ')}) нет «Переразмещения (частичные)» в Комплектации: работа не учтена.` });
      }
      if (mk?.skippedReallocations.length) {
        rowIssues.push({ level: 'info', code: 'REALLOCATION_RATED', message: `Переразмещение у подрядчика с расценкой не добавлено повторно: ${mk.skippedReallocations.map(r => r.supplier || r.name).join(', ')}.` });
      }
      const row: OppRow = {
        key: `${acc.key}|${opp ?? '—'}`, opp, b24: acc.b24, customer: acc.customer, product: acc.product,
        tanks: (opp !== null ? dealRef.filter(r => r.opp === opp) : dealRef).map(tankLabel),
        period, share, tkp: positions, weightPlanKg, mkValuePlan, mkValueFact, mkCostPlan, blocks, omts, finesRub,
        contractShareRub: contract !== null ? contract * share : null, mk,
        revenuePlan, revenueFact, costPlan, costFact,
        profitPlan: minus(revenuePlan, costPlan), profitFact: minus(revenueFact, costFact),
        mkProfitPlan: minus(mkValuePlan, mkCostPlan), mkProfitFact: minus(mkValueFact, mk ? mk.costRub : null),
        weightFactKg, priceKg: mkValueFact !== null && weightFactKg ? mkValueFact / weightFactKg : null,
        issues: rowIssues,
      };
      groupRows.push(row);
    }
    const revenueTotal = sumOrNull(groupRows.map(r => r.revenueFact));
    if (contract !== null && revenueTotal !== null && Math.abs(revenueTotal - contract) > Math.max(1000, contract * 0.005)) {
      issues.push({ level: 'warning', code: 'REVENUE_VS_CONTRACT', message: `Выручка по ТКП и бюджетам (${Math.round(revenueTotal).toLocaleString('ru-RU')}) отличается от суммы договора (${Math.round(contract).toLocaleString('ru-RU')}).` });
    }
    for (const r of groupRows) r.issues = [...issues, ...r.issues];
    rows.push(...groupRows);
    deals.push({
      key: acc.key, b24: acc.b24, customer: acc.customer, product: acc.product, contractRub: contract, finesRub: fines,
      departments: Array.from(acc.departments).sort(), rows: groupRows, issues,
    });
  }

  // ── Production page: every ОПП with output ──
  const realloc = new Map<number, RegisterLine[]>();
  for (const r of rows) if (r.opp !== null && r.mk) realloc.set(r.opp, r.mk.reallocations);
  const production: ProductionOpp[] = Array.from(linesByOpp.entries()).map(([opp, lines]) => {
    const refRows = refByOpp.get(opp) ?? [];
    return {
      opp, b24: refRows[0]?.b24 ?? null, customer: refRows[0]?.client ?? '', tanks: refRows.map(tankLabel),
      finished: refRows.length > 0, mk: buildMk(lines, realloc.get(opp) ?? [], data.contractorAliases),
    };
  }).sort((a, b) => b.mk.costRub - a.mk.costRub);

  const departments = Array.from(new Set(data.departments.map(f => f.department))).sort();
  const present = new Set(departments.map(blockOfDepartment));
  const missingBlocks = BLOCKS.filter(b => !present.has(b.key)).map(b => b.label);
  rows.sort((a, b) => (a.period ?? '').localeCompare(b.period ?? '') || (a.opp ?? 1e9) - (b.opp ?? 1e9) || (a.b24 ?? 0) - (b.b24 ?? 0));
  deals.sort((a, b) => (a.b24 ?? 1e9) - (b.b24 ?? 1e9));
  return {
    rows, deals, production, globalIssues: mkIssues, missingContractors,
    unmatchedDealNames: Array.from(unmatched).sort(), unfinishedOpps, departments, missingBlocks,
    periods: Array.from(new Set(data.departments.map(f => f.period))).sort(),
  };
}

/** Totals of a set of rows: sums first, ratios from sums. */
export function registerTotals(rows: readonly OppRow[]) {
  const s = (f: (r: OppRow) => number | null) => sumOrNull(rows.map(f));
  const revenueFact = s(r => r.revenueFact);
  const costFact = s(r => r.costFact);
  return {
    revenuePlan: s(r => r.revenuePlan), revenueFact, costPlan: s(r => r.costPlan), costFact,
    profitPlan: s(r => r.profitPlan), profitFact: minus(revenueFact, costFact),
    weightPlanKg: s(r => r.weightPlanKg), weightFactKg: s(r => r.weightFactKg),
    mkValueFact: s(r => r.mkValueFact), mkCostFact: s(r => r.mk?.costRub ?? null), mkCostPlan: s(r => r.mkCostPlan),
    fines: s(r => r.finesRub),
    blocks: Object.fromEntries(BLOCKS.map(b => [b.key, { plan: s(r => r.blocks[b.key].plan), fact: s(r => r.blocks[b.key].fact) }])) as Record<BlockKey, { plan: number | null; fact: number | null }>,
  };
}

export const ratio = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);
export { plus };
