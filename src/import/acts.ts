/**
 * «Выпуск продукции» (общий выпуск по цехам): лист «Акты» — плоская таблица актов выпуска
 * «Период | Юр лицо | Подразделение | Шифр | Заказчик | Изделие | … | Тоннаж брутто (для выручки) | …», вес в кг.
 *
 * Книга большая (десятки листов, сводные таблицы, ~7 МБ), поэтому она не читается целиком:
 * из архива .xlsx распаковываются только список листов, общие строки и лист «Акты».
 * Модуль без зависимостей — один и тот же код работает в браузере (загрузка файла)
 * и на сервере (скачивание по ссылке Google). Копия: backend/acts.ts (должна совпадать байт в байт).
 */

/** Сгруппированная строка: месяц 'YYYY-MM', юр. лицо, подразделение (цех), шифр ОПП, тоннаж брутто для выручки, кг. */
export type ActTuple = [string, string, string, number | null, number];

export type ActsFile = {
  fileName: string;
  sheet: string;
  /** Группы по месяц | юр. лицо | цех | ОПП. */
  rows: ActTuple[];
  /** ОПП → заказчик (первое встретившееся имя). */
  customers: Record<string, string>;
  periods: string[];
  /** Число строк актов в листе. */
  actRows: number;
  notes: string[];
};

type Entry = { name: string; method: number; compSize: number; offset: number };

function zipEntries(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не похож на .xlsx (нет оглавления архива).');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Entry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { name, method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (DS) {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // Runtimes without DecompressionStream (older Node): the specifier is kept dynamic so the browser bundle ignores it.
  const specifier = 'node:zlib';
  const zlib = (await import(/* @vite-ignore */ specifier)) as { inflateRawSync(d: Uint8Array): Uint8Array };
  return new Uint8Array(zlib.inflateRawSync(data));
}

async function readEntry(bytes: Uint8Array, entries: Map<string, Entry>, name: string): Promise<string | null> {
  const e = entries.get(name);
  if (!e) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = bytes.subarray(start, start + e.compSize);
  const data = e.method === 0 ? raw : await inflateRaw(raw);
  return new TextDecoder().decode(data);
}

const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, c: string) => {
  const k = c.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Путь к XML листа с данным именем (без учёта регистра и пробелов по краям). */
async function sheetPath(bytes: Uint8Array, entries: Map<string, Entry>, wanted: string): Promise<{ path: string; name: string } | null> {
  const wb = await readEntry(bytes, entries, 'xl/workbook.xml');
  const rels = await readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return null;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(attr(m[0], 'name') ?? '');
    if (name.trim().toLowerCase() !== wanted) continue;
    const rid = attr(m[0], 'r:id');
    const rel = Array.from(rels.matchAll(/<Relationship\b[^>]*>/g)).map(r => r[0]).find(r => attr(r, 'Id') === rid);
    const target = rel ? attr(rel, 'Target') : null;
    if (!target) return null;
    return { path: target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''), name };
  }
  return null;
}

/** Есть ли в книге лист «Акты» — читается только оглавление и список листов. */
export async function hasActsSheet(bytes: Uint8Array): Promise<boolean> {
  try {
    return (await sheetPath(bytes, zipEntries(bytes), 'акты')) !== null;
  } catch {
    return false;
  }
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(Array.from(si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)).map(t => unescapeXml(t[1])).join(''));
  }
  return out;
}

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

type Val = string | number | null;

function* sheetRows(xml: string, strings: string[]): Generator<Val[]> {
  // Empty formatted rows are self-closing (<row r="9"/>): they must not swallow the text up to the next </row>.
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: Val[] = [];
    if (!row[1]) continue;
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = c[1];
      const body = c[2] ?? '';
      const ref = / r="([A-Z]+)\d+"/.exec(head)?.[1];
      const i = ref ? colIndex(ref) : cells.length;
      const type = / t="([^"]+)"/.exec(head)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value: Val = null;
      if (type === 's') value = v !== undefined ? strings[Number(v)] ?? null : null;
      else if (type === 'inlineStr') value = Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)).map(t => unescapeXml(t[1])).join('');
      else if (type === 'str') value = v !== undefined ? unescapeXml(v) : null;
      else if (type === 'e') value = null;
      else if (v !== undefined) value = Number(v);
      cells[i] = value;
    }
    yield cells;
  }
}

const low = (v: Val) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase() : '');
const txt = (v: Val) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());

/** 2026.01 → '2026-01'; 2026.1 (октябрь, ноль отброшен Excel) → '2026-10'; «2026.01» текстом — тоже. */
export function actPeriod(v: Val): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(',', '.')) : NaN;
  if (!Number.isFinite(n) || n < 2000 || n > 2100) return null;
  const year = Math.floor(n);
  const month = Math.round((n - year) * 100);
  return month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, '0')}` : null;
}

export async function readActs(bytes: Uint8Array, fileName: string): Promise<ActsFile> {
  const entries = zipEntries(bytes);
  const sheet = await sheetPath(bytes, entries, 'акты');
  if (!sheet) throw new Error('В книге нет листа «Акты».');
  const xml = await readEntry(bytes, entries, sheet.path);
  if (!xml) throw new Error('Лист «Акты» не найден в архиве.');
  const strings = sharedStrings(await readEntry(bytes, entries, 'xl/sharedStrings.xml'));
  let cols: { period: number; legal: number; dept: number; opp: number; customer: number; brutto: number } | null = null;
  const groups = new Map<string, ActTuple>();
  const customers: Record<string, string> = {};
  const notes: string[] = [];
  let actRows = 0;
  let skipped = 0;
  for (const row of sheetRows(xml, strings)) {
    if (!cols) {
      const find = (p: (x: string) => boolean) => row.findIndex(v => p(low(v)));
      const c = {
        period: find(x => x === 'период'), legal: find(x => x === 'юр лицо'), dept: find(x => x === 'подразделение'),
        opp: find(x => x === 'шифр'), customer: find(x => x === 'заказчик'), brutto: find(x => x.startsWith('тоннаж брутто (для выручки')),
      };
      if (c.period >= 0 && c.dept >= 0 && c.opp >= 0 && c.brutto >= 0) cols = c;
      continue;
    }
    const period = actPeriod(row[cols.period] ?? null);
    const kg = row[cols.brutto];
    if (!period) {
      // Итоговая строка листа (без периода) — не выпуск.
      if (typeof kg === 'number' && kg !== 0) skipped += 1;
      continue;
    }
    actRows += 1;
    if (typeof kg !== 'number' || !Number.isFinite(kg) || kg === 0) continue;
    const legal = cols.legal >= 0 ? txt(row[cols.legal] ?? null) : '';
    const dept = txt(row[cols.dept] ?? null);
    const rawOpp = row[cols.opp];
    const opp = typeof rawOpp === 'number' && Number.isInteger(rawOpp) && rawOpp > 0 ? rawOpp : /^\d{1,6}$/.test(txt(rawOpp ?? null)) ? Number(txt(rawOpp ?? null)) : null;
    const key = `${period}|${legal}|${dept}|${opp ?? ''}`;
    const g = groups.get(key) ?? [period, legal, dept, opp, 0];
    g[4] += kg;
    groups.set(key, g);
    const customer = cols.customer >= 0 ? txt(row[cols.customer] ?? null) : '';
    if (opp !== null && customer && !customers[opp]) customers[opp] = customer;
  }
  if (!cols) throw new Error('На листе «Акты» не найдены колонки «Период», «Подразделение», «Шифр», «Тоннаж брутто (для выручки)».');
  if (skipped) notes.push(`Пропущено строк с тоннажом без периода (итоги): ${skipped}.`);
  const rows = Array.from(groups.values()).map(g => [g[0], g[1], g[2], g[3], Math.round(g[4] * 10) / 10] as ActTuple)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || (a[3] ?? 1e9) - (b[3] ?? 1e9));
  return { fileName, sheet: sheet.name, rows, customers, periods: Array.from(new Set(rows.map(r => r[0]))).sort(), actRows, notes };
}
