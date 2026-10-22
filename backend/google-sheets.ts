import { db, error, json, type RouterContext } from '@appdeploy/sdk';

/**
 * Google Таблицы как источник «Номеров заказов» и весов.
 * Сервер скачивает таблицу в формате .xlsx по ссылке (доступ «Все, у кого есть ссылка»),
 * разбор делает браузер тем же кодом, что и для загруженных файлов.
 */
const SOURCES = 'sources';
const KINDS = ['reference', 'weights'] as const;
type Kind = typeof KINDS[number];
/** Base64 grows the file by a third; keep the response under the 6 MB function limit. */
const MAX_BYTES = 4_000_000;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Spreadsheet / Drive file id from a docs.google.com or drive.google.com link. */
export function googleFileId(url: string): string | null {
  if (!/^https:\/\/(docs|drive)\.google\.com\//.test(url)) return null;
  const m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(url) ?? /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(url);
  return m ? m[1] : null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fileNameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf) {
    try { return decodeURIComponent(utf[1]); } catch { /* use plain name */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : fallback;
}

export async function fetchGoogleSheet(ctx: RouterContext) {
  const body = (ctx.body ?? {}) as { url?: unknown };
  const url = str(body.url, 600);
  const id = googleFileId(url);
  if (!id) return error('Нужна ссылка на Google Таблицу (docs.google.com/spreadsheets/d/…).', 400);
  // Native Google Sheet → export; an .xlsx stored on Drive → direct download.
  const candidates = [
    `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
    `https://drive.google.com/uc?export=download&id=${id}`,
  ];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || type.includes('text/html')) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) return error('Таблица больше 4 МБ — сократите её или загрузите файлом.', 413);
      // xlsx is a zip archive: it starts with «PK».
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) continue;
      const fileName = fileNameFrom(res.headers.get('content-disposition'), 'Google таблица.xlsx');
      return json({ fileName: /\.xls[xm]$/i.test(fileName) ? fileName : fileName + '.xlsx', base64: toBase64(bytes) });
    } catch (cause) {
      console.error('Google Sheets download failed', cause);
    }
  }
  return error('Не удалось скачать таблицу. Откройте доступ «Все, у кого есть ссылка» (просмотр) и проверьте ссылку.', 502);
}

export async function listSources() {
  const res = await db.list(SOURCES, { limit: 20 });
  return json({ sources: res.items.map(s => ({ kind: s.kind, url: s.url, updatedBy: s.updatedBy, updatedAt: s.updatedAt })) });
}

export async function saveSource(ctx: RouterContext) {
  const body = (ctx.body ?? {}) as { kind?: unknown; url?: unknown };
  const kind = KINDS.find(k => k === body.kind) as Kind | undefined;
  const url = str(body.url, 600);
  if (!kind) return error('Неизвестный источник.', 400);
  if (url && !googleFileId(url)) return error('Нужна ссылка на Google Таблицу.', 400);
  await db.tx.update(SOURCES, [{ id: `gsheet_${kind}`, record: { kind, url, updatedBy: ctx.user?.email ?? '', updatedAt: Date.now() } }]);
  return json({ saved: true });
}
