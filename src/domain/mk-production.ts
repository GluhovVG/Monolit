import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import { normalizeName } from '../import/sheet';

/** Workshops that are stock movements, not production: no processing cost. */
const NON_PRODUCTION = [/склад готовой продукции/];

export type MkLine = {
  source: 'own' | 'external';
  opp: number | null;
  order: string;
  month: string | null;
  workshop: string;
  outputT: number;
  /** Списание по отчёту о выпуске: «Сумма всего с НДС» (металл + неметалл). */
  metalRub: number;
  /** руб/кг, null when no rate was found. */
  rate: number | null;
  workRub: number;
  totalRub: number;
  note: string;
};

export type MkIssue = { level: 'blocker' | 'warning'; message: string };

export type MkByOpp = {
  opp: number;
  outputT: number;
  metalRub: number;
  workRub: number;
  totalRub: number;
  /** Own-plant cost split by month ('YYYY-MM'). */
  ownByMonth: Record<string, number>;
  lines: MkLine[];
};

/** contractor alias: normalised workshop name → normalised rate name (confirmed by a user). */
export type ContractorAliases = Record<string, string>;

/**
 * Себестоимость производства МК = списание («Сумма всего с НДС», руб) + выпуск (т × 1000 кг) × коэффициент:
 * – СЗ (собственное производство): коэффициент месяца из «Расценок», руб/кг;
 * – сторонние цеха: расценка подрядчика, руб/кг, одинаковая для любого месяца.
 */
export function computeMkLines(
  own: readonly ProductionRow[],
  external: readonly ProductionRow[],
  rates: Rates | null,
  aliases: ContractorAliases = {}
): { lines: MkLine[]; issues: MkIssue[]; missingContractors: string[] } {
  const lines: MkLine[] = [];
  const missingMonths = new Set<string>();
  const missingContractors = new Map<string, number>();
  for (const row of own) {
    const rate = row.month && rates ? rates.ownByMonth[row.month] ?? null : null;
    if (rate === null && row.outputT !== 0) missingMonths.add(row.month ?? 'без месяца');
    const workRub = rate === null ? 0 : row.outputT * 1000 * rate;
    lines.push({
      source: 'own', opp: row.opp, order: row.order, month: row.month, workshop: row.workshop,
      outputT: row.outputT, metalRub: row.totalRub, rate, workRub, totalRub: row.totalRub + workRub,
      note: rate === null ? 'нет коэффициента СЗ за месяц' : '',
    });
  }
  for (const row of external) {
    const key = normalizeName(row.workshop);
    const nonProduction = NON_PRODUCTION.some(re => re.test(key));
    const rateKey = aliases[key] ?? key;
    const rate = nonProduction ? 0 : rates?.contractor[rateKey] ?? null;
    if (rate === null && row.outputT !== 0) {
      missingContractors.set(row.workshop.trim(), (missingContractors.get(row.workshop.trim()) ?? 0) + row.outputT);
    }
    const workRub = rate === null ? 0 : row.outputT * 1000 * rate;
    lines.push({
      source: 'external', opp: row.opp, order: row.order, month: null, workshop: row.workshop.trim(),
      outputT: row.outputT, metalRub: row.totalRub, rate, workRub, totalRub: row.totalRub + workRub,
      note: nonProduction ? 'передача на склад, работа не начисляется' : rate === null ? 'нет расценки подрядчика' : '',
    });
  }
  const issues: MkIssue[] = [];
  if (!rates) issues.push({ level: 'blocker', message: 'Не загружен файл «Расценки»: стоимость работы не рассчитана.' });
  if (missingMonths.size) {
    issues.push({ level: 'blocker', message: 'Нет коэффициента СЗ за: ' + Array.from(missingMonths).sort().join(', ') + '.' });
  }
  for (const [name, tonnes] of missingContractors) {
    issues.push({ level: 'warning', message: `Нет расценки для «${name}» (выпуск ${tonnes.toFixed(3)} т): стоимость работ берётся из «Переразмещения (частичные)» Комплектации.` });
  }
  return { lines, issues, missingContractors: Array.from(missingContractors.keys()).sort() };
}

export function groupByOpp(lines: readonly MkLine[]): Map<number, MkByOpp> {
  const map = new Map<number, MkByOpp>();
  for (const line of lines) {
    if (line.opp === null) continue;
    const item = map.get(line.opp) ?? { opp: line.opp, outputT: 0, metalRub: 0, workRub: 0, totalRub: 0, ownByMonth: {}, lines: [] };
    item.outputT += line.outputT;
    item.metalRub += line.metalRub;
    item.workRub += line.workRub;
    item.totalRub += line.totalRub;
    if (line.source === 'own' && line.month) item.ownByMonth[line.month] = (item.ownByMonth[line.month] ?? 0) + line.totalRub;
    item.lines.push(line);
    map.set(line.opp, item);
  }
  return map;
}
