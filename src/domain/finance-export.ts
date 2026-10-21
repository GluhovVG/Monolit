import type { AccountingDeal } from '../data/management-2025';

/** Excel-compatible CSV: UTF-8 BOM, semicolon fields, safe text cells. */
export function buildAccountingCsv(deals: readonly AccountingDeal[], sheetName: string): string {
  const header = [
    'Период', 'Шифр сделки', 'Заказчик', 'Изделие',
    'Выручка план, ₽', 'Выручка факт, ₽',
    'Себестоимость план, ₽', 'Себестоимость факт, ₽',
    'Прибыль факт, ₽', 'Рентабельность продаж, %',
    'Вес факт, кг', 'Строка Excel', 'Статус сверки', 'Замечания',
  ];
  const lines: Array<Array<string | number>> = [
    header,
    ...deals.map(deal => [
      deal.period || 'Без периода', deal.id, deal.customer, deal.name,
      deal.plan, deal.revenue, deal.planCost, deal.cost,
      deal.revenue - deal.cost,
      deal.revenue ? Number((((deal.revenue - deal.cost) / deal.revenue) * 100).toFixed(2)) : '',
      deal.weightKg ?? '', sheetName + '!' + deal.sourceRow, deal.status, deal.issue,
    ]),
  ];
  const csvCell = (value: string | number): string => {
    const input = String(value);
    // Escape formula-like text. Numeric values are internally typed, not untrusted strings.
    const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(input) ? "'" + input : input;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + lines.map(row => row.map(csvCell).join(';')).join('\r\n');
}
