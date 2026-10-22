import { db, error, json, storage, type RouterContext } from '@appdeploy/sdk';

/**
 * Исходные файлы загрузок: хранятся в хранилище приложения, чтобы из любой цифры можно было
 * открыть файл-источник (ТКП, файл подразделения, выпуск, расценки, веса, справочник).
 * Для таблиц из Google открывается сама ссылка (sourceUrl в записи загрузки).
 */
const UPLOADS = 'uploads';
/** Base64 of a ~4 MB file: stays under the 6 MB request limit of the function. */
const MAX_BASE64_CHARS = 5_600_000;
export const UPLOAD_ID = /^(reference|rates|prod_own|prod_ext|weights|acts|dept_[0-9a-f]{8}|tkp_\d{3,7})$/;

const CONTENT_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
};

/** Путь хранит исходное имя файла, чтобы файл открывался/скачивался под своим именем. */
const pathOf = (id: string, fileName: string) => `sources/${id}/${fileName.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`;

export async function saveSourceFile(ctx: RouterContext) {
  const id = String(ctx.params.id ?? '');
  if (!UPLOAD_ID.test(id)) return error('Неверный идентификатор.', 400);
  const body = (ctx.body ?? {}) as { fileName?: unknown; base64?: unknown };
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim().slice(0, 200) : '';
  const base64 = typeof body.base64 === 'string' ? body.base64 : '';
  if (!fileName || !base64) return error('Нет файла.', 400);
  if (base64.length > MAX_BASE64_CHARS) return error('Файл больше 4 МБ — сохранены только данные, без копии файла.', 413);
  const ext = (/\.([a-z]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  const path = pathOf(id, fileName);
  const [prev] = await db.get<{ filePath?: string }>(UPLOADS, [id]);
  if (prev?.filePath && prev.filePath !== path) await deleteSourceFile(prev.filePath);
  const [ok] = await storage.write([{ path, content: base64, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }]);
  if (!ok) return error('Не удалось сохранить файл.', 500);
  const [patched] = await db.tx.update(UPLOADS, [{ id, record: { filePath: path, fileExt: ext } }], { patch: true });
  return json({ saved: Boolean(patched) });
}

/** Ссылка на исходный файл: ссылка Google или временная (15 минут) ссылка на копию в хранилище. */
export async function openSourceFile(ctx: RouterContext) {
  const id = String(ctx.params.id ?? '');
  if (!UPLOAD_ID.test(id)) return error('Неверный идентификатор.', 400);
  const [record] = await db.get<{ fileName?: string; sourceUrl?: string; filePath?: string }>(UPLOADS, [id]);
  if (!record) return error('Загрузка не найдена.', 404);
  if (record.sourceUrl) return json({ url: record.sourceUrl, fileName: record.fileName ?? '' });
  if (!record.filePath) return error('Копии файла нет: он загружен до появления хранения файлов. Загрузите файл заново.', 404);
  const [link] = await storage.url([record.filePath]);
  return json({ url: link?.url ?? '', fileName: record.fileName ?? '' });
}

export async function deleteSourceFile(path: string) {
  try {
    await storage.delete([path]);
  } catch (cause) {
    console.error('Source file delete failed', cause);
  }
}
