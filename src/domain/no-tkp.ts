import type { ReferenceRow } from '../import/reference';
import type { TkpFile } from '../import/tkp';

/**
 * Сделки без «Расчёта ТКП»: сделки из «Номеров заказов», по которым есть выпуск МК или которые закрыты
 * в файлах подразделений, но ТКП не загружен. Без ТКП нет цены за тонну, плана МК и выручки по выпуску.
 */
export type NoTkpRow = {
  b24: number;
  client: string;
  product: string;
  tanks: string[];
  opps: number[];
  outputT: number;
  closed: boolean;
  sheets: string[];
};

export function dealsWithoutTkp(
  reference: readonly ReferenceRow[],
  tkp: readonly TkpFile[],
  outputKgByOpp: ReadonlyMap<number, number>,
  closedB24: ReadonlySet<number>,
): NoTkpRow[] {
  const withTkp = new Set(tkp.map(t => t.b24).filter((b): b is number => b !== null));
  const byB24 = new Map<number, ReferenceRow[]>();
  for (const r of reference) if (r.b24 !== null) byB24.set(r.b24, [...(byB24.get(r.b24) ?? []), r]);
  const out: NoTkpRow[] = [];
  for (const [b24, rows] of byB24) {
    if (withTkp.has(b24)) continue;
    const opps = Array.from(new Set(rows.map(r => r.opp).filter((o): o is number => o !== null))).sort((a, b) => a - b);
    const outputT = opps.reduce((s, o) => s + (outputKgByOpp.get(o) ?? 0), 0) / 1000;
    const closed = closedB24.has(b24);
    if (outputT <= 0 && !closed) continue;
    out.push({
      b24, client: (rows[0].client ?? '').replace(/\s+/g, ' ').trim(),
      product: (rows.find(r => r.product)?.product ?? '').replace(/\s+/g, ' ').trim(),
      tanks: Array.from(new Set(rows.map(r => r.tankCode).filter(Boolean))), opps, outputT, closed,
      sheets: Array.from(new Set(rows.map(r => r.sheet))),
    });
  }
  return out.sort((a, b) => Number(b.closed) - Number(a.closed) || b.outputT - a.outputT);
}
