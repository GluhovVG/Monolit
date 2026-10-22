import { api } from '@appdeploy/client';
import type { DepartmentFile } from '../import/department';
import { isSubtotalRow, type ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import { BLOCKS, type Consolidation, type WorkspaceData } from '../domain/consolidate';
import type { TkpFile } from '../import/tkp';
import type { WeightsFile } from '../import/weights';

export type UploadMeta = {
  id: string;
  kind: 'reference' | 'rates' | 'prod_own' | 'prod_ext' | 'department' | 'tkp' | 'weights';
  fileName: string;
  department: string;
  period: string;
  rowCount: number | null;
  uploadedBy: string;
  uploadedAt: number;
};
export type Alias = { id: string; kind: 'contractor' | 'deal'; from: string; to: string | number; confirmedBy: string };

// Stored payloads are compact tuples to stay within database item limits.
// Reference tuple: b24, client, tank code, ОПП, sheet, factory number (6th item added later, may be absent).
type RefTuple = [number | null, string, string, number | null, string, string?];
type ProdTuple = [number | null, string, string | null, string, number, number, number, number];

export const packReference = (rows: ReferenceRow[]) => rows.map(r => [r.b24, r.client, r.tankCode, r.opp, r.sheet, r.factoryNo] as RefTuple);
export const packProduction = (rows: ProductionRow[]) =>
  rows.map(r => [r.opp, r.order, r.month, r.workshop, r.outputT, r.metalT, r.metalRub, r.totalRub] as ProdTuple);
const unpackReference = (rows: RefTuple[]): ReferenceRow[] =>
  rows.map(([b24, client, tankCode, opp, sheet, factoryNo]) => ({ b24, client, tankCode, opp, sheet, factoryNo: factoryNo ?? '' }));
const unpackProduction = (rows: ProdTuple[]): ProductionRow[] =>
  rows.map(([opp, order, month, workshop, outputT, metalT, metalRub, totalRub]) => ({ opp, order, month, workshop, outputT, metalT, metalRub, totalRub }));

export type SheetSource = { kind: 'reference' | 'weights'; url: string; updatedBy: string; updatedAt: number };

export async function loadWorkspace(): Promise<{ data: WorkspaceData; uploads: UploadMeta[]; aliases: Alias[]; weights: WeightsFile | null; sources: SheetSource[] }> {
  const [u, a, s] = await Promise.all([api.get('/api/uploads'), api.get('/api/aliases'), api.get('/api/sources')]);
  const sources = ((s.data as { sources?: SheetSource[] }).sources ?? []);
  let weights: WeightsFile | null = null;
  const raw = ((u.data as { uploads?: Array<UploadMeta & { payload: unknown }> }).uploads ?? []);
  const aliases = ((a.data as { aliases?: Alias[] }).aliases ?? []);
  const data: WorkspaceData = { reference: null, rates: null, prodOwn: null, prodExt: null, departments: [], tkp: [], dealAliases: {}, contractorAliases: {} };
  for (const item of raw) {
    const p = item.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (item.kind === 'reference') data.reference = unpackReference((p.rows as RefTuple[]) ?? []);
    if (item.kind === 'rates') data.rates = p as unknown as Rates;
    // Files saved earlier may contain order subtotal lines: they are dropped here, otherwise output is counted twice.
    if (item.kind === 'prod_own') data.prodOwn = unpackProduction((p.rows as ProdTuple[]) ?? []).filter(r => !isSubtotalRow('own', r));
    if (item.kind === 'prod_ext') data.prodExt = unpackProduction((p.rows as ProdTuple[]) ?? []).filter(r => !isSubtotalRow('external', r));
    // Files saved by an earlier version have no cost lines: they must be uploaded again.
    if (item.kind === 'department' && Array.isArray(p.deals) && (p.deals as Array<{ lines?: unknown }>).every(d => Array.isArray(d.lines))) {
      data.departments.push(p as unknown as DepartmentFile);
    }
    if (item.kind === 'tkp') data.tkp.push(p as unknown as TkpFile);
    if (item.kind === 'weights') weights = p as unknown as WeightsFile;
  }
  for (const al of aliases) {
    if (al.kind === 'deal' && typeof al.to === 'number') data.dealAliases[al.from] = al.to;
    if (al.kind === 'contractor' && typeof al.to === 'string') data.contractorAliases[al.from] = al.to;
  }
  const uploads = raw.map(({ payload: _payload, ...meta }) => meta);
  return { data, uploads, aliases, weights, sources };
}

const r0 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Math.round(n)));

/** Compact text for AI review and chat: one line per ОПП row, no raw source rows. */
export function buildAiContext(c: Consolidation, maxRows = 250): string {
  const lines = [
    'Строка = шифр ОПП (тип баков сделки). Колонки: ключ | месяц | ОПП | Б24 | заказчик | баки | выручка план/факт | себестоимость план/факт | прибыль план/факт | вес кг план/факт | стоимость МК факт; себестоимость МК факт (завод; сторонние) | '
      + BLOCKS.map(b => b.label).join(', ') + ' (бюджет/факт) | БГ/штрафы | замечания системы',
  ];
  for (const r of c.rows.slice(0, maxRows)) {
    const blocks = BLOCKS.map(b => `${r0(r.blocks[b.key].plan)}/${r0(r.blocks[b.key].fact)}`).join('; ');
    const mk = r.mk ? `${r0(r.mkValueFact)}; ${r0(r.mk.costRub)} (${r0(r.mk.own.totalRub)}; ${r0(r.mk.ext.totalRub)})` : `${r0(r.mkValueFact)}; нет выпуска`;
    lines.push([
      r.key, r.period ?? '—', r.opp ?? '—', r.b24 ?? '—', r.customer.slice(0, 50), r.tanks.join(', ').slice(0, 120),
      `${r0(r.revenuePlan)}/${r0(r.revenueFact)}`, `${r0(r.costPlan)}/${r0(r.costFact)}`, `${r0(r.profitPlan)}/${r0(r.profitFact)}`,
      `${r0(r.weightPlanKg)}/${r0(r.weightFactKg)}`, mk, blocks, r0(r.finesRub), r.issues.map(i => i.code).join(',') || '—',
    ].join(' | '));
  }
  if (c.rows.length > maxRows) lines.push(`… ещё ${c.rows.length - maxRows} строк не показано.`);
  if (!c.rows.length && c.production.length) {
    lines.push('Файлов подразделений нет. Производство МК по шифрам (ОПП | Б24 | заказчик | выпуск кг | себестоимость):');
    for (const p of c.production.slice(0, maxRows)) {
      lines.push(`${p.opp} | ${p.b24 ?? '—'} | ${p.customer.slice(0, 50)} | ${r0(p.mk.outputKg)} | ${r0(p.mk.costRub)}${p.finished ? '' : ' | незавершённое'}`);
    }
  }
  lines.push('Общие замечания: ' + (c.globalIssues.map(i => i.message).join(' ') || 'нет'));
  return lines.join('\n');
}
