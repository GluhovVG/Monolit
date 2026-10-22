import { findColumn, lower, num, text, type Cell, type Sheet, type Workbook } from './sheet';

/**
 * «Закрытые сделки <Подразделение> <месяц>» — общий шаблон для всех подразделений:
 * колонки сделки (Заказчик, Товар, Сумма договора, Штрафы, Ссылка на сделку Б24, Шифр, Примечание)
 * и блоки подразделений (Комплектация, Переразмещения (частичные), Логистика до г.Самара, Логистика,
 * Проектирование, ОМТС). Каждый файл заполняет блоки своего подразделения; остальные блоки игнорируются.
 */

export type BlockColumns = {
  title: string;
  name: number;
  supplier: number;
  invoice: number;
  budget: number;
  fact: number;
  weight: number;
};

export type DepartmentMapping = {
  sheet: string;
  headerRow: number;
  customer: number;
  product: number;
  contract: number;
  fines: number;
  link: number;
  tank: number;
  note: number;
  /** Blocks read for this department. */
  blocks: BlockColumns[];
  source: 'rules' | 'ai';
};

export type DepartmentLine = {
  block: string;
  tank: string;
  name: string;
  supplier: string;
  invoiceRub: number | null;
  budgetRub: number | null;
  factRub: number | null;
  weightT: number | null;
  /** Text written instead of a number, e.g. «самовывоз». */
  note: string;
  sourceRow: number;
};

export type DepartmentDeal = {
  b24: number | null;
  customer: string;
  product: string;
  contractRub: number | null;
  finesRub: number | null;
  note: string;
  tanks: string[];
  lines: DepartmentLine[];
  sourceRow: number;
};

export type DepartmentFile = {
  department: string;
  period: string;
  fileName: string;
  mapping: DepartmentMapping;
  deals: DepartmentDeal[];
};

/** Blocks that belong to a department besides the block with its own name. */
const EXTRA_BLOCKS: Record<string, string[]> = {
  'комплектация': ['переразмещения', 'логистика до'],
};
export const REALLOCATION_BLOCK = 'Переразмещения (частичные)';

const MONTHS: Array<[RegExp, number]> = [
  [/^январ/, 1], [/^феврал/, 2], [/^март/, 3], [/^апрел/, 4], [/^ма[йя]/, 5], [/^июн/, 6],
  [/^июл/, 7], [/^август/, 8], [/^сентябр/, 9], [/^октябр/, 10], [/^ноябр/, 11], [/^декабр/, 12],
];

/** «Закрытые сделки Проектирование март [2026].xlsx» → department + 'YYYY-MM'. */
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

/** Б24 deal number from a CRM link (…/crm/deal/details/6940/) or a name starting with it ("7293_…"). */
export function b24FromDealRef(value: string): number | null {
  const link = /deal\/details\/(\d+)/i.exec(value);
  if (link) return Number(link[1]);
  const lead = /^\s*(\d{3,6})(?=[\s_\-.,]|$)/.exec(value);
  return lead ? Number(lead[1]) : null;
}

const norm = (s: string) => lower(s).replace(/[^а-яa-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function findHeaderRow(sheet: Sheet): number {
  for (let h = 0; h < Math.min(15, sheet.rows.length); h += 1) {
    const row = sheet.rows[h];
    if (findColumn(row, x => x.includes('ссылка на сделку')) >= 0 && findColumn(row, x => x === 'шифр') >= 0) return h;
  }
  return -1;
}

/** All blocks of the template: title in the header row, roles in the row below. */
function readBlocks(sheet: Sheet, h: number, firstCol: number): BlockColumns[] {
  const header = sheet.rows[h] ?? [];
  const sub = sheet.rows[h + 1] ?? [];
  const width = Math.max(header.length, sub.length);
  const starts: Array<{ col: number; title: string }> = [];
  for (let c = firstCol; c < width; c += 1) {
    const t = text(header[c]);
    if (t && (!starts.length || norm(starts[starts.length - 1].title) !== norm(t))) starts.push({ col: c, title: t });
  }
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].col : width;
    const role = (pred: (x: string) => boolean) => {
      for (let c = s.col; c < end; c += 1) if (pred(lower(sub[c]))) return c;
      return -1;
    };
    const block: BlockColumns = {
      title: s.title,
      name: role(x => x.startsWith('наименование')),
      supplier: role(x => x.includes('поставщик') || x.includes('поставшик') || x.includes('подрядчик') || x.includes('разработчик')),
      invoice: role(x => x.includes('сумма по счету')),
      budget: role(x => x.startsWith('бюджет')),
      fact: role(x => x.includes('фактическ') || x.startsWith('затраты')),
      weight: role(x => x.startsWith('вес')),
    };
    // Single-column block without sub-headers (e.g. «Логистика до г.Самара»): the column is the fact cost.
    if (end - s.col === 1 && block.fact < 0 && block.budget < 0) block.fact = s.col;
    return block;
  });
}

export function ownedBlocks(blocks: BlockColumns[], department: string): BlockColumns[] {
  const dep = norm(department);
  const extra = EXTRA_BLOCKS[dep] ?? [];
  const exact = blocks.filter(b => norm(b.title) === dep || extra.some(e => norm(b.title).startsWith(e)));
  if (exact.some(b => norm(b.title) === dep)) return exact;
  const stem = dep.slice(0, 6);
  return blocks.filter(b => stem && norm(b.title).replace(/ /g, '').includes(stem.replace(/ /g, '')));
}

/** Rule-based mapping of the shared template. Null when the layout is not recognised. */
export function detectDepartmentMapping(book: Workbook, department: string): DepartmentMapping | null {
  for (const sheet of book.sheets) {
    const h = findHeaderRow(sheet);
    if (h < 0) continue;
    const header = sheet.rows[h];
    const col = (pred: (x: string) => boolean) => findColumn(header, pred);
    const note = col(x => x.startsWith('примечание'));
    const tank = col(x => x === 'шифр');
    const firstBlock = Math.max(note, tank, col(x => x.includes('ссылка на сделку'))) + 1;
    const blocks = ownedBlocks(readBlocks(sheet, h, firstBlock), department)
      .filter(b => b.fact >= 0 || b.budget >= 0);
    if (!blocks.length) return null;
    return {
      sheet: sheet.name, headerRow: h,
      customer: col(x => x === 'заказчик'), product: col(x => x.startsWith('товар')),
      contract: col(x => x.startsWith('сумма договора')), fines: col(x => x.startsWith('штраф')),
      link: col(x => x.includes('ссылка на сделку')), tank, note, blocks, source: 'rules',
    };
  }
  return null;
}

const cellNum = (row: Cell[], i: number) => (i >= 0 ? num(row[i]) : null);
const cellText = (row: Cell[], i: number) => (i >= 0 ? text(row[i]) : '');

/** Reads deals (deal columns are merged across their rows, so values are carried forward). */
export function extractDepartmentDeals(book: Workbook, mapping: DepartmentMapping): DepartmentDeal[] {
  const sheet = book.sheets.find(x => x.name === mapping.sheet) ?? book.sheets[0];
  const deals: DepartmentDeal[] = [];
  let current: DepartmentDeal | null = null;
  let tank = '';
  // Data starts after the role row under the header.
  sheet.rows.slice(mapping.headerRow + 2).forEach((row, offset) => {
    if (!row) return;
    const sourceRow = mapping.headerRow + 3 + offset;
    const link = cellText(row, mapping.link);
    const customer = cellText(row, mapping.customer);
    if (link || customer) {
      current = {
        b24: b24FromDealRef(link) ?? b24FromDealRef(customer),
        customer, product: cellText(row, mapping.product),
        contractRub: cellNum(row, mapping.contract), finesRub: cellNum(row, mapping.fines),
        note: cellText(row, mapping.note), tanks: [], lines: [], sourceRow,
      };
      deals.push(current);
      tank = '';
    }
    if (!current) return;
    const deal: DepartmentDeal = current;
    const rowTank = cellText(row, mapping.tank);
    if (rowTank) {
      tank = rowTank;
      if (!deal.tanks.includes(rowTank)) deal.tanks.push(rowTank);
    }
    // Item and supplier of a row are written once (in the first block that has these columns);
    // blocks without them (e.g. «Переразмещения (частичные)») take them from the same row.
    const rowName = mapping.blocks.map(b => cellText(row, b.name)).find(Boolean) ?? '';
    const rowSupplier = mapping.blocks.map(b => cellText(row, b.supplier)).find(Boolean) ?? '';
    for (const b of mapping.blocks) {
      const moneyCols = [b.invoice, b.budget, b.fact, b.weight];
      const numbers = moneyCols.map(i => cellNum(row, i));
      const textNotes = moneyCols.map(i => (i >= 0 ? row[i] : null))
        .filter(v => typeof v === 'string' && num(v) === null && text(v)).map(v => text(v));
      // A line without any amount (only a name or a supplier) carries no cost.
      if (numbers.every(v => v === null) && !textNotes.length) continue;
      deal.lines.push({
        block: b.title, tank,
        name: (b.name >= 0 ? cellText(row, b.name) : '') || rowName,
        supplier: (b.supplier >= 0 ? cellText(row, b.supplier) : '') || rowSupplier,
        invoiceRub: numbers[0], budgetRub: numbers[1], factRub: numbers[2], weightT: numbers[3],
        note: textNotes.join('; '), sourceRow,
      });
    }
  });
  return deals;
}

/** Compact preview of a sheet for the AI mapper: first rows, cells truncated. */
export function sheetPreview(sheet: Sheet, rows = 14, maxCols = 70): string {
  return sheet.rows.slice(0, rows).map((row, r) =>
    `Строка ${r}: ` + (row ?? []).slice(0, maxCols)
      .map((cell, c) => (text(cell) ? `[${c}] ${text(cell).slice(0, 60)}` : ''))
      .filter(Boolean).join(' | ')
  ).join('\n');
}

/** AI proposal for an unrecognised layout: deal columns + one block of this department. */
export type AiMappingProposal = {
  sheet?: string; headerRow?: number; customer?: number; product?: number; contract?: number; fines?: number;
  link?: number; tank?: number; name?: number; supplier?: number; budget?: number; fact?: number; weight?: number;
};

/** Validates an AI proposal against the sheet bounds; data starts two rows below headerRow. */
export function sanitizeMapping(book: Workbook, raw: AiMappingProposal, department: string): DepartmentMapping | null {
  const sheet = book.sheets.find(x => x.name === raw.sheet) ?? book.sheets[0];
  if (!sheet) return null;
  const width = Math.max(0, ...sheet.rows.slice(0, 20).map(r => (r ? r.length : 0)));
  const idx = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < width ? v : -1);
  const headerRow = typeof raw.headerRow === 'number' && raw.headerRow >= 0 && raw.headerRow < 30 ? raw.headerRow : -1;
  const block: BlockColumns = {
    title: department, name: idx(raw.name), supplier: idx(raw.supplier), invoice: -1,
    budget: idx(raw.budget), fact: idx(raw.fact), weight: idx(raw.weight),
  };
  const m: DepartmentMapping = {
    sheet: sheet.name, headerRow, customer: idx(raw.customer), product: idx(raw.product),
    contract: idx(raw.contract), fines: idx(raw.fines), link: idx(raw.link), tank: idx(raw.tank), note: -1,
    blocks: [block], source: 'ai',
  };
  if (headerRow < 0 || (m.link < 0 && m.customer < 0) || (block.fact < 0 && block.budget < 0)) return null;
  return m;
}

/** Budget / fact totals of a deal's lines for one department, excluding the reallocation block. */
export function blockTotals(lines: readonly DepartmentLine[]) {
  const own = lines.filter(l => l.block !== REALLOCATION_BLOCK && !/переразмещ/i.test(l.block));
  const sum = (pick: (l: DepartmentLine) => number | null) => {
    const vals = own.map(pick).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) : null;
  };
  const budget = sum(l => l.budgetRub);
  const fact = sum(l => l.factRub);
  return { budget, fact, economy: budget !== null && fact !== null ? budget - fact : null };
}
