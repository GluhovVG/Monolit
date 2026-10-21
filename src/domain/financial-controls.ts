/**
 * Deterministic controls and shared financial parameters for MONOLITH.
 * Adapted from the policies used by KVOiT.Liquidity (vps-migration):
 * server-side financial truth, explicit inclusion flags, required confirmations,
 * daily/carry-forward values, and hard checks before AI assistance.
 *
 * The current MONOLITH dataset is DEMO ONLY. These functions do not approve
 * actual financial reports or replace authenticated server-side validation.
 */
export type DealStatus = 'Подтверждён' | 'На проверке' | 'Предварительный';
export type FinancialDeal = {
  id: string;
  name: string;
  block: string;
  revenue: number;
  cost: number;
  plan: number;
  status: string;
};
export type BlockParameter = {
  name: string;
  active: boolean;
  includeInTotals: boolean;
  requireConfirmation: boolean;
};
export type GeneralParameters = {
  materialityRub: number;
  materialityPercent: number;
  blocks: BlockParameter[];
};
export type CheckIssue = {
  code: string;
  level: 'blocker' | 'warning';
  dealId?: string;
  message: string;
};
export type CheckResult = {
  okToPublish: boolean;
  checkedDeals: number;
  blockers: number;
  warnings: number;
  issues: CheckIssue[];
};

export const DEFAULT_GENERAL_PARAMETERS: GeneralParameters = {
  materialityRub: 50_000,
  materialityPercent: 2,
  blocks: ['МК', 'Комплектация', 'Документация', 'СМР', 'Логистика'].map(name => ({
    name, active: true, includeInTotals: true, requireConfirmation: true,
  })),
};

export function validateGeneralParameters(params: GeneralParameters): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(params.materialityRub) || params.materialityRub <= 0) {
    errors.push('Порог в рублях должен быть положительным конечным числом.');
  }
  if (!Number.isFinite(params.materialityPercent) || params.materialityPercent <= 0 || params.materialityPercent > 100) {
    errors.push('Порог в процентах должен быть больше 0 и не превышать 100.');
  }
  const names = new Set<string>();
  for (const block of params.blocks) {
    if (!block.name.trim() || names.has(block.name)) errors.push('Названия финансовых блоков должны быть уникальными и непустыми.');
    names.add(block.name);
  }
  return errors;
}

/** Either threshold is enough: RUB OR percent; zero plan has no percent baseline. */
export function isMaterialDeviation(actual: number, plan: number, params: GeneralParameters): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(plan)) return false;
  const diff = Math.abs(actual - plan);
  return diff >= params.materialityRub || (plan !== 0 && (diff / Math.abs(plan)) * 100 >= params.materialityPercent);
}

export function financialTotals(deals: readonly FinancialDeal[], params: GeneralParameters) {
  const included = deals.filter(d => {
    const block = params.blocks.find(item => item.name === d.block);
    return block?.active && block.includeInTotals;
  });
  if (included.some(d => ![d.revenue, d.cost, d.plan].every(value => Number.isFinite(value) && value >= 0))) {
    throw new Error('Нельзя рассчитывать итоги из некорректных сумм.');
  }
  const revenue = included.reduce((sum, d) => sum + d.revenue, 0);
  const cost = included.reduce((sum, d) => sum + d.cost, 0);
  const plan = included.reduce((sum, d) => sum + d.plan, 0);
  const profit = revenue - cost;
  return { revenue, cost, plan, profit, margin: revenue === 0 ? null : (profit / revenue) * 100, count: included.length };
}

/**
 * Readiness is deterministic. AI warnings never override blockers.
 * This checks the demo register; when real sources are connected, approval must
 * also check source versions, mappings, reconciliation and permissions on backend.
 */
export function checkFinancialRegister(deals: readonly FinancialDeal[], params: GeneralParameters): CheckResult {
  const issues: CheckIssue[] = validateGeneralParameters(params).map(message => ({
    code: 'INVALID_PARAMETER', level: 'blocker', message,
  }));
  const known = new Map(params.blocks.map(item => [item.name, item]));
  const seen = new Set<string>();
  let checkedDeals = 0;
  for (const deal of deals) {
    if (!deal.id.trim() || !deal.name.trim()) {
      issues.push({ code: 'REQUIRED_FIELD', level: 'blocker', dealId: deal.id, message: 'Не заполнен ID или название сделки.' });
    }
    if (seen.has(deal.id)) {
      issues.push({ code: 'DUPLICATE_ID', level: 'blocker', dealId: deal.id, message: `Повторяется ID сделки ${deal.id}.` });
    }
    seen.add(deal.id);
    const policy = known.get(deal.block);
    if (!policy) {
      issues.push({ code: 'UNKNOWN_BLOCK', level: 'blocker', dealId: deal.id, message: `Для сделки ${deal.id} отсутствует финансовый блок в общих параметрах.` });
      continue;
    }
    if (!policy.active) continue;
    checkedDeals += 1;
    if (![deal.revenue, deal.cost, deal.plan].every(value => Number.isFinite(value) && value >= 0)) {
      issues.push({ code: 'INVALID_AMOUNT', level: 'blocker', dealId: deal.id, message: `Некорректная сумма по сделке ${deal.id}.` });
      continue;
    }
    if (policy.requireConfirmation && deal.status !== 'Подтверждён') {
      issues.push({ code: 'NOT_CONFIRMED', level: 'blocker', dealId: deal.id, message: `Сделка ${deal.id} ещё не подтверждена администратором.` });
    }
    if (isMaterialDeviation(deal.revenue, deal.plan, params)) {
      issues.push({ code: 'MATERIAL_VARIANCE', level: 'warning', dealId: deal.id, message: `Существенное отклонение выручки от плана по ${deal.id}: нужна проверка первоисточника.` });
    }
    if (deal.cost > deal.revenue) {
      issues.push({ code: 'NEGATIVE_PROFIT', level: 'warning', dealId: deal.id, message: `Затраты по сделке ${deal.id} превышают выручку.` });
    }
    if (deal.revenue === 0) {
      issues.push({ code: 'NO_MARGIN', level: 'warning', dealId: deal.id, message: `По сделке ${deal.id} рентабельность не рассчитывается при нулевой выручке.` });
    }
  }
  if (checkedDeals === 0) {
    issues.push({ code: 'NO_DATA', level: 'blocker', message: 'Нет активных сделок за период. Отчёт не может быть подтверждён.' });
  }
  const blockers = issues.filter(item => item.level === 'blocker').length;
  const warnings = issues.filter(item => item.level === 'warning').length;
  return { okToPublish: blockers === 0, checkedDeals, blockers, warnings, issues };
}

// Source value rules from CashFlow: "no data" stays null (never implicit zero).
export type ValuePolicy = 'daily' | 'carry_forward';
export type SourceParameter = { code: string; active: boolean; required: boolean; valuePolicy: ValuePolicy };
export type SourceValue = { code: string; period: string; amount: number };
export function effectiveSourceValue(source: SourceParameter, entries: readonly SourceValue[], period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Ожидается период YYYY-MM.');
  if (!source.active) return { amount: null, sourcePeriod: null, carriedForward: false };
  const matches = entries.filter(item => item.code === source.code
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(item.period)
    && (source.valuePolicy === 'carry_forward' ? item.period <= period : item.period === period))
    .sort((a, b) => b.period.localeCompare(a.period));
  const latest = matches[0];
  if (!latest) return { amount: null, sourcePeriod: null, carriedForward: false };
  if (!Number.isFinite(latest.amount)) throw new Error('Некорректная сумма источника.');
  return { amount: latest.amount, sourcePeriod: latest.period, carriedForward: latest.period !== period };
}
