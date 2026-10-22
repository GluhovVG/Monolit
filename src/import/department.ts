import { findColumn, lower, num, text, type Cell, type Sheet, type Workbook } from './sheet';

/** Column indices (0-based, -1 = absent) of a department results file. */
export type DepartmentMapping = {
  sheet: string;
  headerRow: number;
  deal: number;
  revenuePlan: number;
  revenueFact: number;
  costPlan: number;
  costFact: number;
  profitPlan: number;
  profitFact: number;
  source: 'rules' | 'ai' | 'manual';
};

export type DepartmentDeal = {
  /** Б24 deal number taken from the beginning of the deal name ("7293_Полиметалл…"). */
  b24: number | null;
  name: string;
  revenuePlan: number | null;
  revenueFact: number | null;
  costPlan: number | null;
  costFact: number | null;
  profitPlan: number | null;
  profitFact: number | null;
  sourceRow: number;
};

export type DepartmentFile = {
  department: string;
  period: string;
  fileName: string;
  mapping: DepartmentMapping;
  deals: DepartmentDeal[];
};

const MONTHS: Array<[RegExp, number]> = [
  [/^январ/, 1], [/^феврал/, 2], [/^март/, 3], [/^апрел/, 4], [/^ма[йя]/, 5], [/^июн/, 6],
  [/^июл/, 7], [/^август/, 8], [/^сентябр/, 9], [/^октябр/, 10], [/^ноябр/, 11], [/^декабр/, 12],
];

/** «Закрытые сделки Проектирование февраль [2026].xlsx» → department + 'YYYY-MM'. */
export function departmentFromFileName(fileName: string, fallbackYear: number): { department: string; period: string } | null {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const match = /закрытые\s+сделки\s+(.+)$/i.exec(base);
  if (!match) return null;
  const words = match[1].split(' ');
  let year = fallbackYear;
  if (/^\d{4}$/.test(words[words.length - 1] ?? '')) year = Number(words.pop());
  const monthWord = (words.pop() ?? '').toLowerCase().replace(/ё/g, 'е');
  const month = MONTHS.find(([re]) => re.test(monthWord))?.[1];
  const department = words.join(' ').trim();
  if (!month || !department) return null;
  return { department, period: `${year}-${String(month).padStart(2, '0')}` };
}

export function isDepartmentFileName(fileName: string): boolean {
  return /закрытые\s+сделки/i.test(fileName.replace(/_/g, ' '));
}

/** Deal number at the start of the name: "7293_Полиметалл" / "7293 Полиметалл" / "7293-…". */
export function b24FromDealName(name: string): number | null {
  const m = /^\s*(\d{3,6})(?=[\s_\-.,]|$)/.exec(name);
  return m ? Number(m[1]) : null;
}

const stem = (department: string) => lower(department).replace(/[^а-яa-z]/g, '').slice(0, 6);

/** Rule-based column detection. Returns null when revenue/cost cannot be found reliably. */
export function detectDepartmentMapping(book: Workbook, department: string): DepartmentMapping | null {
  const s = stem(department);
  for (const sheet of book.sheets) {
    for (let h = 0; h < Math.min(15, sheet.rows.length); h += 1) {
      const header = sheet.rows[h] ?? [];
      const metric = (kind: string, fact: boolean) => {
        const cands = header
          .map((cell, i) => ({ i, h: lower(cell) }))
          .filter(x => x.h.includes(kind) && !x.h.includes('за 1 кг') && !x.h.includes('%') && !x.h.includes('факт-план'));
        const scoped = s ? cands.filter(x => x.h.replace(/[^а-яa-z]/g, '').includes(s)) : [];
        const pool = scoped.length ? scoped : cands.length <= 3 ? cands : [];
        const want = pool.filter(x => (fact ? x.h.includes('факт') : x.h.includes('план')));
        if (want.length) return want[0].i;
        const unmarked = pool.filter(x => !x.h.includes('факт') && !x.h.includes('план'));
        return fact && unmarked.length ? unmarked[0].i : -1;
      };
      const revenueFact = metric('выручк', true);
      const costFact = metric('себест', true);
      if (revenueFact < 0 || costFact < 0) continue;
      let deal = findColumn(header, x => x.includes('сделк') || x === 'наименование' || x.includes('проект') && !x.includes('выручк'));
      if (deal < 0 || deal === revenueFact) deal = 0;
      return {
        sheet: sheet.name, headerRow: h, deal,
        revenuePlan: metric('выручк', false), revenueFact,
        costPlan: metric('себест', false), costFact,
        profitPlan: metric('прибыл', false) >= 0 ? metric('прибыл', false) : metric('пртбыл', false),
        profitFact: metric('прибыл', true),
        source: 'rules',
      };
    }
  }
  return null;
}

/** Compact preview of a sheet for the AI column mapper: first rows, cells truncated. */
export function sheetPreview(sheet: Sheet, rows = 14, maxCols = 70): string {
  return sheet.rows.slice(0, rows).map((row, r) =>
    `Строка ${r}: ` + (row ?? []).slice(0, maxCols)
      .map((cell, c) => (text(cell) ? `[${c}] ${text(cell).slice(0, 60)}` : ''))
      .filter(Boolean).join(' | ')
  ).join('\n');
}

const value = (row: Cell[], i: number) => (i >= 0 ? num(row[i]) : null);

export function extractDepartmentDeals(book: Workbook, mapping: DepartmentMapping): DepartmentDeal[] {
  const sheet = book.sheets.find(x => x.name === mapping.sheet) ?? book.sheets[0];
  const deals: DepartmentDeal[] = [];
  sheet.rows.slice(mapping.headerRow + 1).forEach((row, offset) => {
    if (!row) return;
    const name = text(row[mapping.deal]);
    if (!name || /итого|всего/i.test(name)) return;
    const revenuePlan = value(row, mapping.revenuePlan);
    const revenueFact = value(row, mapping.revenueFact);
    const costPlan = value(row, mapping.costPlan);
    const costFact = value(row, mapping.costFact);
    if ([revenuePlan, revenueFact, costPlan, costFact].every(v => v === null)) return;
    const profitPlan = value(row, mapping.profitPlan)
      ?? (revenuePlan !== null && costPlan !== null ? revenuePlan - costPlan : null);
    const profitFact = value(row, mapping.profitFact)
      ?? (revenueFact !== null && costFact !== null ? revenueFact - costFact : null);
    deals.push({
      b24: b24FromDealName(name), name, revenuePlan, revenueFact, costPlan, costFact,
      profitPlan, profitFact, sourceRow: mapping.headerRow + 2 + offset,
    });
  });
  return deals;
}

/** Validates a mapping proposed by AI against the sheet bounds. */
export function sanitizeMapping(book: Workbook, raw: Partial<DepartmentMapping>, source: DepartmentMapping['source']): DepartmentMapping | null {
  const sheet = book.sheets.find(x => x.name === raw.sheet) ?? book.sheets[0];
  if (!sheet) return null;
  const width = Math.max(0, ...sheet.rows.slice(0, 20).map(r => (r ? r.length : 0)));
  const idx = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < width ? v : -1);
  const headerRow = typeof raw.headerRow === 'number' && raw.headerRow >= 0 && raw.headerRow < 30 ? raw.headerRow : -1;
  const m: DepartmentMapping = {
    sheet: sheet.name, headerRow, deal: idx(raw.deal),
    revenuePlan: idx(raw.revenuePlan), revenueFact: idx(raw.revenueFact),
    costPlan: idx(raw.costPlan), costFact: idx(raw.costFact),
    profitPlan: idx(raw.profitPlan), profitFact: idx(raw.profitFact), source,
  };
  if (m.headerRow < 0 || m.deal < 0 || (m.revenueFact < 0 && m.revenuePlan < 0) || (m.costFact < 0 && m.costPlan < 0)) return null;
  return m;
}
