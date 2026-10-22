import type { PriceRow } from './revenue-prices';

/**
 * Автоматические проверки реестра (предупреждения, не блокировки).
 * Пороги — черновые, вынесены в константы, чтобы их можно было утвердить и поменять в одном месте.
 */
export const THRESHOLDS = {
  /** Отклонение веса факт от плана, доля. */
  weightDeviation: 0.1,
  /** Перерасход полной себестоимости над планом, доля. */
  costOverrun: 0.05,
  /** Цена ₽/т дальше чем в N раз от медианы по всем шифрам. */
  priceOutlierFactor: 3,
};

export type CheckIssue = { level: 'warning'; code: string; message: string };

type Checkable = {
  opp: number | null;
  revenueFact: number | null;
  costPlan: number | null;
  costFact: number | null;
  profitFact: number | null;
  weightPlanKg: number | null;
  weightFactKg: number | null;
};

const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;
const rub = (x: number) => Math.round(x).toLocaleString('ru-RU');

export function rowChecks(r: Checkable): CheckIssue[] {
  const out: CheckIssue[] = [];
  if (r.profitFact !== null && r.revenueFact !== null && r.profitFact < 0) {
    out.push({ level: 'warning', code: 'LOSS', message: `Убыток по шифру ${r.opp ?? '—'}: ${rub(r.profitFact)} ₽.` });
  }
  if (r.costPlan !== null && r.costFact !== null && r.costPlan > 0) {
    const over = (r.costFact - r.costPlan) / r.costPlan;
    if (over > THRESHOLDS.costOverrun) {
      out.push({ level: 'warning', code: 'COST_OVER_PLAN', message: `Себестоимость факт выше плана на ${pct(over)} (${rub(r.costFact - r.costPlan)} ₽).` });
    }
  }
  if (r.weightPlanKg !== null && r.weightFactKg !== null && r.weightPlanKg > 0) {
    const dev = (r.weightFactKg - r.weightPlanKg) / r.weightPlanKg;
    if (Math.abs(dev) > THRESHOLDS.weightDeviation) {
      out.push({ level: 'warning', code: 'WEIGHT_DEVIATION', message: `Вес факт отличается от плана на ${dev > 0 ? '+' : ''}${pct(dev)} (${rub(r.weightFactKg)} кг против ${rub(r.weightPlanKg)} кг).` });
    }
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Цена ₽/т, которая в N раз выше или ниже медианы по всем шифрам: вероятная ошибка в ТКП или весе. */
export function priceOutliers(rows: readonly PriceRow[]): Map<string, string> {
  const prices = rows.map(r => r.pricePerT).filter((p): p is number => p !== null && p > 0);
  const med = median(prices);
  const out = new Map<string, string>();
  if (med === null || prices.length < 3) return out;
  const k = THRESHOLDS.priceOutlierFactor;
  for (const r of rows) {
    if (r.pricePerT === null || r.pricePerT <= 0) continue;
    if (r.pricePerT > med * k || r.pricePerT < med / k) {
      out.set(r.key, `Цена ${rub(r.pricePerT)} ₽/т сильно отличается от медианы ${rub(med)} ₽/т — проверьте «ИТОГО МК» в ТКП и вес.`);
    }
  }
  return out;
}
