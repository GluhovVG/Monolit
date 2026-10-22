import type { ReferenceRow } from '../import/reference';
import { matchPositionOpp, type TkpFile, type TkpPosition } from '../import/tkp';
import type { WeightsFile } from '../import/weights';

/**
 * Расчёт цен для выручки: цена МК за тонну по шифру ОПП.
 * Стоимость МК — «Конечная стоимость для продажи план» позиций ТКП этого шифра.
 * Вес — из файла весов по шифру ОПП; если шифра там нет — «Кол-во на поставку план, кг» из ТКП.
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
  weightSource: 'weights' | 'tkp' | null;
  /** ₽ за тонну. */
  pricePerT: number | null;
  issue: string;
};

const tankLabel = (r: ReferenceRow) => (r.factoryNo && r.factoryNo !== '-' ? `${r.tankCode} №${r.factoryNo}` : r.tankCode);

export function revenuePrices(tkp: readonly TkpFile[], reference: readonly ReferenceRow[], weights: WeightsFile | null): PriceRow[] {
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
        positions: [], mkValue: null, weightKg: null, weightSource: null, pricePerT: null,
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
    row.pricePerT = row.mkValue !== null && row.weightKg ? row.mkValue / (row.weightKg / 1000) : null;
    if (!row.tanks.length) row.tanks = row.positions.map(p => p.name);
  }
  return Array.from(rows.values()).sort((a, b) => (a.opp ?? 1e9) - (b.opp ?? 1e9) || (a.b24 ?? 0) - (b.b24 ?? 0));
}
