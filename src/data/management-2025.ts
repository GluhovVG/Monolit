import type { SourceRow } from './source-row';

export type { SourceRow };

export const SOURCE_SHA256 = 'f31eab000f3132223754e5e34d7f0e8aab4e28af42c3b3de44fec01ddb0e86f7';
export const SOURCE_NAME = 'Управленческий учет 2025 (2)(1).xlsx';
export const SOURCE_SHEET = 'Сделки';
export const BLOCK_NAMES = ['МК', 'Документация', 'Комплектация', 'Логистика', 'СМР'] as const;
export type BlockName = typeof BLOCK_NAMES[number];
export type BlockCosts = Record<BlockName, number | null>;
export type AccountingDeal = {
  id: string;
  name: string;
  customer: string;
  block: 'Комплексная сделка';
  period: string | null;
  sourceRow: number;
  revenue: number;
  cost: number;
  plan: number;
  planCost: number;
  weightKg: number | null;
  blockCosts: BlockCosts;
  fines: number | null;
  status: 'Подтверждён' | 'На проверке' | 'Предварительный';
  issue: string;
};

// Row layout: see ./source-row.ts. The data itself lives only on the server.
const SOURCE_ERROR_ROWS = new Set([50, 80, 90, 91, 96]);
const SOURCE_REVENUE_CONFLICT_ROWS = new Set([34, 51, 52]);

/** Maps raw rows received from GET /api/deals into typed deals. */
export function mapSourceRows(rows: readonly SourceRow[]): AccountingDeal[] {
  return rows.map(row => {
    const [sourceRow, id, month, customer, name, plan, revenue, planCost, cost,
      weightKg, , mkCost, docs, supply, delivery, smr, fines] = row;
    const issue = [
      month === 0 ? 'В исходном файле отсутствует период.' : '',
      SOURCE_ERROR_ROWS.has(sourceRow) ? 'В исходном XLSX есть #DIV/0! в цене за кг.' : '',
      SOURCE_REVENUE_CONFLICT_ROWS.has(sourceRow) ? 'Выручка не совпадает с суммой компонентов в исходном XLSX.' : '',
      'Источник Excel, первичные документы ещё не сверены.',
    ].filter(Boolean).join(' ');
    return {
      id, name, customer, block: 'Комплексная сделка',
      period: month > 0 ? `2025-${String(month).padStart(2, '0')}` : null,
      sourceRow, plan, revenue, planCost, cost, weightKg,
      blockCosts: {
        'МК': mkCost, 'Документация': docs, 'Комплектация': supply,
        'Логистика': delivery, 'СМР': smr,
      },
      fines, status: 'На проверке' as const, issue,
    };
  });
}

/** Rejects a malformed server payload instead of rendering partial numbers. */
export function parseSourceRows(payload: unknown): SourceRow[] {
  const rows = (payload as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) throw new Error('Сервер вернул данные в неверном формате.');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 17 || typeof row[0] !== 'number' || typeof row[1] !== 'string') {
      throw new Error('Сервер вернул строку источника в неверном формате.');
    }
  }
  return rows as SourceRow[];
}

export const periods = [
  { value: '2025', label: 'Весь 2025 год' },
  ...Array.from({ length: 12 }, (_, index) => ({
    value: `2025-${String(index + 1).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2025, index, 1))),
  })),
  { value: 'undated', label: 'Без периода — на проверке' },
] as const;

export function dealsForPeriod(all: readonly AccountingDeal[], period: string): AccountingDeal[] {
  if (period === '2025') return all.filter(item => item.period?.startsWith('2025-'));
  if (period === 'undated') return all.filter(item => item.period === null);
  if (!/^2025-(0[1-9]|1[0-2])$/.test(period)) return [];
  return all.filter(item => item.period === period);
}

/** Never report a cash amount for a source with missing values. */
export function sumKnown(items: readonly (number | null)[]): { sum: number | null; complete: boolean } {
  if (!items.length || items.every(value => value === null)) return { sum: null, complete: false };
  return {
    sum: items.reduce<number>((total, value) => total + (value ?? 0), 0),
    complete: items.every(value => value !== null),
  };
}
