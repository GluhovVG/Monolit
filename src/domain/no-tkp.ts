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

/**
 * Запрос недостающих «Расчётов ТКП». Приоритет:
 * 1 — сделка закрыта в подразделениях: без ТКП в реестре нет выручки;
 * 2 — по сделке есть выпуск: без ТКП нет цены за тонну и выручки в финрезе по выпуску;
 * отдельно — ТКП загружен, но его позиции не сопоставлены с баками сделки (нужно уточнить ТКП).
 */
export type TkpRequestRow = {
  b24: number;
  name: string;
  tanks: string[];
  opps: number[];
  closedMonths: string[];
  outputT: number;
  kind: 'missing' | 'unmatched';
  priority: 1 | 2;
  need: string;
};

type DealLike = { b24: number | null; customer: string; product: string; rows: ReadonlyArray<{ period: string | null; opp: number | null; tanks: string[]; issues: ReadonlyArray<{ code: string; message: string }> }> };

const MONTHS_GEN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
export const monthIn = (m: string) => `${MONTHS_GEN[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

export function tkpRequest(noTkp: readonly NoTkpRow[], deals: readonly DealLike[], tkpB24: ReadonlySet<number>): TkpRequestRow[] {
  const months = new Map<number, Set<string>>();
  for (const d of deals) {
    if (d.b24 === null) continue;
    for (const r of d.rows) if (r.period) months.set(d.b24, (months.get(d.b24) ?? new Set()).add(r.period));
  }
  const out: TkpRequestRow[] = [];
  const seen = new Set<number>();
  const need = (closed: string[], outputT: number) => [
    closed.length ? `выручка в реестре (сделка закрыта в ${closed.map(monthIn).join(', ')})` : '',
    outputT > 0 ? `цена за тонну и выручка по выпуску (${Math.round(outputT * 10) / 10} т)` : '',
  ].filter(Boolean).join('; ');
  for (const r of noTkp) {
    const closed = Array.from(months.get(r.b24) ?? []).sort();
    seen.add(r.b24);
    out.push({
      b24: r.b24, name: [r.client, r.product].filter(Boolean).join(' — '), tanks: r.tanks, opps: r.opps, closedMonths: closed,
      outputT: r.outputT, kind: 'missing', priority: closed.length ? 1 : 2, need: need(closed, r.outputT),
    });
  }
  for (const d of deals) {
    if (d.b24 === null || seen.has(d.b24)) continue;
    const closed = Array.from(months.get(d.b24) ?? []).sort();
    const noTkpDeal = !tkpB24.has(d.b24);
    const unmatched = !noTkpDeal && d.rows.some(r => r.issues.some(i => i.code === 'TKP_NO_OPP'));
    if (!noTkpDeal && !unmatched) continue;
    seen.add(d.b24);
    out.push({
      b24: d.b24, name: [d.customer, d.product].filter(Boolean).join(' — '),
      tanks: Array.from(new Set(d.rows.flatMap(r => r.tanks))), opps: d.rows.map(r => r.opp).filter((o): o is number => o !== null),
      closedMonths: closed, outputT: 0, kind: unmatched ? 'unmatched' : 'missing', priority: 1,
      need: unmatched ? 'позиции ТКП не сопоставлены с баками сделки — уточнить наименования позиций (тип и объём РВС)' : need(closed, 0),
    });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'missing' ? -1 : 1) || a.priority - b.priority || b.outputT - a.outputT || a.b24 - b.b24);
}

/** Текст запроса для письма / задачи в Б24. */
export function tkpRequestText(rows: readonly TkpRequestRow[]): string {
  const missing = rows.filter(r => r.kind === 'missing');
  const unmatched = rows.filter(r => r.kind === 'unmatched');
  const line = (r: TkpRequestRow, i: number) => `${i + 1}. Б24 ${r.b24} — ${r.name || 'без названия'}${r.tanks.length ? ` (${r.tanks.slice(0, 6).join(', ')}${r.tanks.length > 6 ? '…' : ''})` : ''}${r.opps.length ? `, ОПП ${r.opps.join(', ')}` : ''}. Нужен для: ${r.need || 'расчёта цены МК'}.`;
  const parts: string[] = [];
  if (missing.length) {
    parts.push('Прошу предоставить «Расчёт ТКП» (файл Excel, в имени файла — номер сделки Б24) по сделкам:');
    const urgent = missing.filter(r => r.priority === 1);
    const other = missing.filter(r => r.priority === 2);
    if (urgent.length) parts.push('В первую очередь — сделки закрыты, без ТКП нет выручки:', ...urgent.map(line));
    if (other.length) parts.push(urgent.length ? 'Далее — сделки с выпуском МК:' : 'Сделки с выпуском МК:', ...other.map((r, i) => line(r, i)));
  }
  if (unmatched.length) {
    parts.push('', 'Уточнить «Расчёт ТКП» (позиции не сопоставлены с баками сделки):', ...unmatched.map(line));
  }
  return parts.join('\n');
}
