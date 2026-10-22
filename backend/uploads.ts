import { db, error, json, type RouterContext } from '@appdeploy/sdk';
import { safeKey } from './safe-key';
import { deleteSourceFile, UPLOAD_ID } from './source-files';

const UPLOADS = 'uploads';
const UPLOAD_LOG = 'upload_log';
const ALIASES = 'aliases';
/** Leaves headroom under the 256 KiB per-item database limit. */
const MAX_PAYLOAD_CHARS = 230_000;
const KINDS = ['reference', 'rates', 'prod_own', 'prod_ext', 'department', 'tkp', 'weights'] as const;
type Kind = typeof KINDS[number];

type UploadBody = {
  kind?: unknown;
  fileName?: unknown;
  department?: unknown;
  period?: unknown;
  payload?: unknown;
  rowCount?: unknown;
  /** Ссылка на Google Таблицу, если данные загружены по ссылке. */
  sourceUrl?: unknown;
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function uploadId(kind: Kind, department: string, period: string): string {
  if (kind === 'department') return `dept_${safeKey(department.toLowerCase() + '|' + period)}`;
  // «Расчёт ТКП»: one current version per Б24 deal (the deal number is sent in `department`).
  if (kind === 'tkp') return `tkp_${department}`;
  return kind;
}

export async function saveUpload(ctx: RouterContext) {
  const body = (ctx.body ?? {}) as UploadBody;
  const kind = KINDS.find(k => k === body.kind);
  if (!kind) return error('Неизвестный тип файла.', 400);
  const fileName = str(body.fileName, 200);
  const department = str(body.department, 80);
  const period = str(body.period, 7);
  if (!fileName) return error('Не указано имя файла.', 400);
  if (kind === 'department' && (!department || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))) {
    return error('Для файла подразделения нужны подразделение и месяц.', 400);
  }
  if (kind === 'tkp' && !/^\d{3,7}$/.test(department)) return error('Для «Расчёта ТКП» нужен номер сделки Б24.', 400);
  if (body.payload === null || typeof body.payload !== 'object') return error('Нет данных файла.', 400);
  const serialized = JSON.stringify(body.payload);
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    return error('Файл слишком большой для хранения одним набором. Разделите выгрузку по периодам.', 413);
  }
  const id = uploadId(kind, department, period);
  const sourceUrl = str(body.sourceUrl, 600);
  if (sourceUrl && !/^https:\/\/(docs|drive)\.google\.com\//.test(sourceUrl)) return error('Неверная ссылка на источник.', 400);
  // The previous copy of the source file belongs to the replaced version.
  const [prev] = await db.get<{ filePath?: string }>(UPLOADS, [id]);
  if (prev?.filePath) await deleteSourceFile(prev.filePath);
  const record = {
    kind, fileName, department, period, sourceUrl,
    rowCount: typeof body.rowCount === 'number' ? body.rowCount : null,
    uploadedBy: ctx.user?.email ?? '', uploadedAt: Date.now(),
    payload: serialized,
  };
  const [saved] = await db.tx.update(UPLOADS, [{ id, record }]);
  if (!saved) return error('Не удалось сохранить файл.', 500);
  // History of uploads (metadata only); the current version replaces the previous one.
  await db.add(UPLOAD_LOG, [{ uploadId: id, kind, fileName, department, period, uploadedBy: record.uploadedBy, uploadedAt: record.uploadedAt }]);
  return json({ id, replaced: true });
}

export async function listUploads() {
  const items: Array<Record<string, unknown>> = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const res = await db.list(UPLOADS, { limit: 100, nextToken });
    items.push(...res.items);
    if (!res.nextToken) break;
    nextToken = res.nextToken;
  }
  return json({
    uploads: items.map(item => ({
      id: item.id, kind: item.kind, fileName: item.fileName, department: item.department, period: item.period,
      rowCount: item.rowCount, uploadedBy: item.uploadedBy, uploadedAt: item.uploadedAt,
      sourceUrl: item.sourceUrl ?? '', hasFile: Boolean(item.filePath),
      payload: typeof item.payload === 'string' ? JSON.parse(item.payload) : null,
    })),
  });
}

export async function deleteUpload(ctx: RouterContext) {
  const id = str(ctx.params.id, 40);
  if (!UPLOAD_ID.test(id)) return error('Неверный идентификатор.', 400);
  const [prev] = await db.get<{ filePath?: string }>(UPLOADS, [id]);
  if (prev?.filePath) await deleteSourceFile(prev.filePath);
  const [ok] = await db.delete(UPLOADS, [id]);
  return json({ deleted: Boolean(ok) });
}

/** Confirmed matches: contractor name → rate name, deal name → Б24. */
export async function listAliases() {
  const res = await db.list(ALIASES, { limit: 500 });
  return json({ aliases: res.items.map(a => ({ id: a.id, kind: a.kind, from: a.from, to: a.to, confirmedBy: a.confirmedBy })) });
}

export async function saveAliases(ctx: RouterContext) {
  const body = (ctx.body ?? {}) as { aliases?: unknown };
  if (!Array.isArray(body.aliases) || body.aliases.length === 0 || body.aliases.length > 100) {
    return error('Передайте от 1 до 100 сопоставлений.', 400);
  }
  const items = [];
  for (const raw of body.aliases as Array<Record<string, unknown>>) {
    const kind = raw?.kind === 'contractor' || raw?.kind === 'deal' ? raw.kind : null;
    const from = str(raw?.from, 300).toLowerCase();
    const to = kind === 'deal' ? (Number.isInteger(raw?.to) && (raw.to as number) > 0 ? raw.to : null) : str(raw?.to, 200).toLowerCase();
    if (!kind || !from || to === null || to === '') return error('Неверное сопоставление.', 400);
    items.push({ id: `${kind}_${safeKey(from)}`, record: { kind, from, to, confirmedBy: ctx.user?.email ?? '', confirmedAt: Date.now() } });
  }
  await db.tx.update(ALIASES, items);
  return json({ saved: items.length });
}

export async function deleteAlias(ctx: RouterContext) {
  const id = str(ctx.params.id, 40);
  if (!/^(contractor|deal)_[0-9a-f]{8}$/.test(id)) return error('Неверный идентификатор.', 400);
  const [ok] = await db.delete(ALIASES, [id]);
  return json({ deleted: Boolean(ok) });
}
