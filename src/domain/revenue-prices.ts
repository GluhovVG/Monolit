import type { ReferenceRow } from '../import/reference';
import { matchPositionOpp, type TkpFile, type TkpPosition } from '../import/tkp';
import type { WeightsFile } from '../import/weights';
import { priceOutliers } from './checks';

/**
 * Расчёт цен для выручки: цена МК за тонну по шифру ОПП.
 * Стоимость МК — «Конечная стоимость для продажи план» позиций ТКП этого шифра.
 * Вес — из файла весов по шифру ОПП; если шифра там нет — «Кол-во на поставку план, кг» из ТКП.
 * Если общий выпуск по шифру (завод + сторонние) больше этого планового веса — берётся вес выпуска.
 * Цена, ₽/т = стоимость МК / (вес, кг / 1000). Позиции ТКП сопоставляются с ОПП через «Номера заказов».
 */
export type PriceRow = {
  key: string;
  opp: number | null;
  b24: number | null;
  customer: string;
  /** Баки шифра из «Номеров заказов» (или названия позиций ТКП, если шифр не найден). */
  tanks: string[];
  positions: TkpPosition[];
  mkValue: number | null;
  weightKg: number | null;
  weightSource: 'weights' | 'tkp' | 'output' | null;
  /** Плановый вес (файл весов или ТКП), кг — для сравнения с выпуском. */
  planWeightKg: number | null;
  /** Общий выпуск по шифру, кг. */
  outputKg: number | null;
  /** ₽ за тонну. */
  pricePerT: number | null;
  issue: string;
};

const tankLabel = (r: ReferenceRow) => (r.factoryNo && r.factoryNo !== '-' ? `${r.tankCode} №${r.factoryNo}` : r.tankCode);

/** Общий выпуск по шифру ОПП, кг (завод + сторонние цеха). */
export function outputKgByOpp(rows: ReadonlyArray<{ opp: number | null; outputT: number }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) if (r.opp !== null) m.set(r.opp, (m.get(r.opp) ?? 0) + r.outputT * 1000);
  return m;
}

/**
 * Фактический выпуск по шифру для правила «выпуск больше планового веса → цена по выпуску», кг:
 * при загруженном «Выпуске продукции» — тоннаж брутто для выручки по всем цехам (с упаковкой),
 * иначе — выпуск из отчётов «Выпуск СЗ» и «Выпуск сторонних цехов».
 */
export function factOutputKgByOpp(data: {
  acts?: { rows: ReadonlyArray<readonly [string, string, string, number | null, number]> } | null;
  prodOwn: ReadonlyArray<{ opp: number | null; outputT: number }> | null;
  prodExt: ReadonlyArray<{ opp: number | null; outputT: number }> | null;
}): Map<number, number> {
  if (data.acts?.rows.length) {
    const m = new Map<number, number>();
    for (const [, , , opp, kg] of data.acts.rows) if (opp !== null) m.set(opp, (m.get(opp) ?? 0) + kg);
    return m;
  }
  return outputKgByOpp([...(data.prodOwn ?? []), ...(data.prodExt ?? [])]);
}

export function revenuePrices(
  tkp: readonly TkpFile[], reference: readonly ReferenceRow[], weights: WeightsFile | null, output: ReadonlyMap<number, number> = new Map(),
): PriceRow[] {
  const byB24 = new Map<number, ReferenceRow[]>();
  for (const r of reference) if (r.b24 !== null) byB24.set(r.b24, [...(byB24.get(r.b24) ?? []), r]);
  const rows = new Map<string, PriceRow>();
  for (const file of tkp) {
    const dealRef = file.b24 !== null ? byB24.get(file.b24) ?? [] : [];
    const opps = new Set(dealRef.map(r => r.opp).filter((x): x is number => x !== null));
    for (const p of file.positions) {
      let { opp, candidates } = matchPositionOpp(p.name, dealRef);
      if (opp === null && opps.size === 1 && file.positions.length === 1) opp = Array.from(opps)[0];
      const key = opp !== null ? `opp:${opp}` : `pos:${file.b24}:${p.sourceRow}`;
      const row = rows.get(key) ?? {
        key, opp, b24: file.b24, customer: (dealRef[0]?.client ?? '').replace(/\s+/g, ' ').trim(),
        tanks: opp !== null ? Array.from(new Set(dealRef.filter(r => r.opp === opp).map(tankLabel))) : [],
        positions: [], mkValue: null, weightKg: null, weightSource: null, planWeightKg: null, outputKg: null, pricePerT: null,
        issue: opp !== null ? '' : !dealRef.length
          ? `Сделки ${file.b24 ?? '—'} нет в «Номерах заказов».`
          : `Позиция не сопоставлена с ОПП${candidates.length ? ` (подходят ${candidates.join(', ')})` : ''}.`,
      };
      row.positions.push(p);
      rows.set(key, row);
    }
  }
  for (const row of rows.values()) {
    const values = row.positions.map(p => p.mkValuePlan).filter((v): v is number => v !== null);
    row.mkValue = values.length ? values.reduce((s, v) => s + v, 0) : null;
    const fileWeight = row.opp !== null ? weights?.byOpp[String(row.opp)] : undefined;
    const tkpWeights = row.positions.map(p => p.weightPlanKg).filter((v): v is number => v !== null && v > 0);
    if (fileWeight !== undefined && fileWeight > 0) {
      row.weightKg = fileWeight;
      row.weightSource = 'weights';
    } else if (tkpWeights.length) {
      row.weightKg = tkpWeights.reduce((s, v) => s + v, 0);
      row.weightSource = 'tkp';
    }
    row.planWeightKg = row.weightKg;
    const out = row.opp !== null ? output.get(row.opp) : undefined;
    row.outputKg = out ?? null;
    // Выпуск больше планового веса — цена считается на фактический вес выпуска.
    if (out !== undefined && out > 0 && (row.weightKg === null || out > row.weightKg)) {
      row.weightKg = out;
      row.weightSource = 'output';
    }
    row.pricePerT = row.mkValue !== null && row.weightKg ? row.mkValue / (row.weightKg / 1000) : null;
    if (!row.tanks.length) row.tanks = row.positions.map(p => p.name);
  }
  const outliers = priceOutliers(Array.from(rows.values()));
  for (const row of rows.values()) {
    const note = outliers.get(row.key);
    if (note) row.issue = row.issue ? `${row.issue} ${note}` : note;
  }
  return Array.from(rows.values()).sort((a, b) => (a.opp ?? 1e9) - (b.opp ?? 1e9) || (a.b24 ?? 0) - (b.b24 ?? 0));
}

/**
 * Выпуск по шифру за период (месяцы from..to включительно, 'YYYY-MM'), кг — для отчётов с фильтром периода.
 * Источник с месяцами: «Акты» (все цеха), иначе «Выпуск СЗ» (только завод: у сторонних в отчёте нет месяцев).
 */
export function outputKgByOppInPeriod(data: {
  acts?: { rows: ReadonlyArray<readonly [string, string, string, number | null, number]> } | null;
  prodOwn: ReadonlyArray<{ opp: number | null; outputT: number; month: string | null }> | null;
}, from: string | null, to: string | null): Map<number, number> {
  const inRange = (m: string | null) => m !== null && (!from || m >= from) && (!to || m <= to);
  const out = new Map<number, number>();
  if (data.acts?.rows.length) {
    for (const [month, , , opp, kg] of data.acts.rows) if (opp !== null && inRange(month)) out.set(opp, (out.get(opp) ?? 0) + kg);
    return out;
  }
  for (const r of data.prodOwn ?? []) if (r.opp !== null && inRange(r.month)) out.set(r.opp, (out.get(r.opp) ?? 0) + r.outputT * 1000);
  return out;
}

/** Месяцы, за которые есть выпуск с датой (для выбора периода). */
export function outputMonths(data: {
  acts?: { periods: readonly string[] } | null;
  prodOwn: ReadonlyArray<{ month: string | null }> | null;
}): string[] {
  if (data.acts?.periods.length) return [...data.acts.periods].sort();
  return Array.from(new Set((data.prodOwn ?? []).map(r => r.month).filter((m): m is string => Boolean(m)))).sort();
}
