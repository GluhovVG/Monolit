/** Minimal workbook model shared by all import parsers (independent of the XLSX library). */
export type Cell = string | number | boolean | Date | null;
export type Sheet = { name: string; rows: Cell[][] };
export type Workbook = { fileName: string; sheets: Sheet[] };

export const text = (value: Cell | undefined): string =>
  value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value).trim();

export const lower = (value: Cell | undefined): string => text(value).toLowerCase().replace(/ё/g, 'е');

/** Finite number or null. Accepts numeric strings with spaces / comma decimals. */
export function num(value: Cell | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s| /g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Positive integer code (e.g. «Шифр для бухгалтерии»), otherwise null. */
export function code(value: Cell | undefined): number | null {
  const parsed = num(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Excel period written as a number: 2025.01 → '2025-01', 2025.1 → '2025-10', 2025.12 → '2025-12'. */
export function periodFromNumber(value: Cell | undefined): string | null {
  const parsed = num(value);
  if (parsed === null) return null;
  const year = Math.floor(parsed);
  const month = Math.round((parsed - year) * 100);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Index of the first column whose header satisfies the predicate. */
export function findColumn(row: Cell[] | undefined, predicate: (header: string) => boolean): number {
  if (!row) return -1;
  return row.findIndex(cell => predicate(lower(cell)));
}

/** Contractor / workshop name normalisation for rate lookup. */
export function normalizeName(value: Cell | undefined): string {
  return lower(value)
    .replace(/подрядчик/g, ' ')
    .replace(/[«»"'“”]/g, ' ')
    .replace(/(^|\s)(ооо|зао|оао|пао|ао|ип)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
