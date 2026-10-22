import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAccountingCsv } from '../src/domain/finance-export.ts';
import { dealsForPeriod, mapSourceRows } from '../src/data/management-2025.ts';
import { SOURCE_ROWS } from '../backend/source-2025.ts';

const accountingDeals = mapSourceRows(SOURCE_ROWS);

describe('Accounting export contract', () => {
  it('exports the exact selected period with header and source row references', () => {
    const jan = dealsForPeriod(accountingDeals, '2025-01');
    const csv = buildAccountingCsv(jan, 'Сделки');
    assert.ok(csv.startsWith('\uFEFF'));
    assert.equal(csv.split('\r\n').length, 4);
    assert.ok(csv.includes('Сделки!7'));
    assert.ok(!csv.includes('Сделки!10'));
  });
  it('protects text from spreadsheet formula injection', () => {
    const malicious = { ...accountingDeals[0], customer: '=HYPERLINK("https://example.invalid","x")' };
    const csv = buildAccountingCsv([malicious], 'Сделки');
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(csv.includes('""https://example.invalid""'));
  });
  it('does not export a false 0% for a zero-revenue deal', () => {
    const deal = { ...accountingDeals[0], revenue: 0 };
    const csv = buildAccountingCsv([deal], 'Сделки');
    const row = csv.split('\r\n')[1].split(';');
    assert.equal(row[9], '""');
  });
});
