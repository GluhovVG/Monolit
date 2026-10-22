import { api } from '@appdeploy/client';
import type { DepartmentFile } from '../import/department';
import type { ProductionRow } from '../import/production';
import type { Rates } from '../import/rates';
import type { ReferenceRow } from '../import/reference';
import type { Consolidation, WorkspaceData } from '../domain/consolidate';

export type UploadMeta = {
  id: string;
  kind: 'reference' | 'rates' | 'prod_own' | 'prod_ext' | 'department';
  fileName: string;
  department: string;
  period: string;
  rowCount: number | null;
  uploadedBy: string;
  uploadedAt: number;
};
export type Alias = { id: string; kind: 'contractor' | 'deal'; from: string; to: string | number; confirmedBy: string };

// Stored payloads are compact tuples to stay within database item limits.
type RefTuple = [number | null, string, string, number | null, string];
type ProdTuple = [number | null, string, string | null, string, number, number, number, number];

export const packReference = (rows: ReferenceRow[]) => rows.map(r => [r.b24, r.client, r.tankCode, r.opp, r.sheet] as RefTuple);
export const packProduction = (rows: ProductionRow[]) =>
  rows.map(r => [r.opp, r.order, r.month, r.workshop, r.outputT, r.metalT, r.metalRub, r.totalRub] as ProdTuple);
const unpackReference = (rows: RefTuple[]): ReferenceRow[] =>
  rows.map(([b24, client, tankCode, opp, sheet]) => ({ b24, client, tankCode, opp, sheet }));
const unpackProduction = (rows: ProdTuple[]): ProductionRow[] =>
  rows.map(([opp, order, month, workshop, outputT, metalT, metalRub, totalRub]) => ({ opp, order, month, workshop, outputT, metalT, metalRub, totalRub }));

export async function loadWorkspace(): Promise<{ data: WorkspaceData; uploads: UploadMeta[]; aliases: Alias[] }> {
  const [u, a] = await Promise.all([api.get('/api/uploads'), api.get('/api/aliases')]);
  const raw = ((u.data as { uploads?: Array<UploadMeta & { payload: unknown }> }).uploads ?? []);
  const aliases = ((a.data as { aliases?: Alias[] }).aliases ?? []);
  const data: WorkspaceData = { reference: null, rates: null, prodOwn: null, prodExt: null, departments: [], dealAliases: {}, contractorAliases: {} };
  for (const item of raw) {
    const p = item.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (item.kind === 'reference') data.reference = unpackReference((p.rows as RefTuple[]) ?? []);
    if (item.kind === 'rates') data.rates = p as unknown as Rates;
    if (item.kind === 'prod_own') data.prodOwn = unpackProduction((p.rows as ProdTuple[]) ?? []);
    if (item.kind === 'prod_ext') data.prodExt = unpackProduction((p.rows as ProdTuple[]) ?? []);
    if (item.kind === 'department') data.departments.push(p as unknown as DepartmentFile);
  }
  for (const al of aliases) {
    if (al.kind === 'deal' && typeof al.to === 'number') data.dealAliases[al.from] = al.to;
    if (al.kind === 'contractor' && typeof al.to === 'string') data.contractorAliases[al.from] = al.to;
  }
  const uploads = raw.map(({ payload: _payload, ...meta }) => meta);
  return { data, uploads, aliases };
}

const r0 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Math.round(n)));

/** Compact text for AI review and chat: one line per deal, no raw source rows. */
export function buildAiContext(c: Consolidation, maxDeals = 250): string {
  const lines = [
    'Колонки: ключ | Б24 | сделка | шифры ОПП | блоки подразделений (подразделение месяц: выручка факт/план; себестоимость факт/план; прибыль факт/план) | МК: выпуск т; металл руб; работа руб; итого руб; руб/кг | замечания системы',
  ];
  for (const d of c.deals.slice(0, maxDeals)) {
    const blocks = d.blocks.map(b =>
      `${b.department} ${b.period}: выр ${r0(b.revenueFact)}/${r0(b.revenuePlan)}; себ ${r0(b.costFact)}/${r0(b.costPlan)}; приб ${r0(b.profitFact)}/${r0(b.profitPlan)}`
    ).join('; ');
    const mk = d.mk
      ? `${d.mk.outputT.toFixed(1)} т; ${r0(d.mk.metalRub)}; ${r0(d.mk.workRub)}; ${r0(d.mk.totalRub)}; ${d.mk.outputT > 0 ? (d.mk.totalRub / (d.mk.outputT * 1000)).toFixed(1) : '—'}`
      : 'нет выпуска';
    lines.push([d.key, d.b24 ?? '—', d.name.slice(0, 80), d.opps.join(',') || '—', blocks || '—', mk, d.issues.map(i => i.code).join(',') || '—'].join(' | '));
  }
  if (c.deals.length > maxDeals) lines.push(`… ещё ${c.deals.length - maxDeals} сделок не показано.`);
  if (!c.deals.length && c.productionDeals.length) {
    lines.push('Файлов подразделений нет. Производство МК по сделкам справочника:');
    for (const d of c.productionDeals.slice(0, maxDeals)) {
      lines.push(`${d.key} | ${d.b24} | ${d.client.slice(0, 60)} | ${d.opps.join(',')} | ${d.mk!.outputT.toFixed(1)} т | итого ${r0(d.mk!.totalRub)}`);
    }
  }
  lines.push('Общие замечания: ' + (c.globalIssues.map(i => i.message).join(' ') || 'нет'));
  return lines.join('\n');
}
