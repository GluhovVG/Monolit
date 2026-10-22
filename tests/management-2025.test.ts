import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dealsForPeriod, mapSourceRows, parseSourceRows, periods, sumKnown, SOURCE_SHA256,
} from '../src/data/management-2025.ts';
import { SOURCE_ROWS } from '../backend/source-2025.ts';

const accountingDeals = mapSourceRows(SOURCE_ROWS);
import { DEFAULT_GENERAL_PARAMETERS, checkFinancialRegister, financialTotals } from '../src/domain/financial-controls.ts';

describe('Imported management workbook 2025', () => {
  it('imports 91 distinct deal codes, 90 dated and 1 undated', () => {
    assert.equal(accountingDeals.length, 91);
    assert.equal(new Set(accountingDeals.map(deal => deal.id)).size, 91);
    assert.equal(dealsForPeriod(accountingDeals, '2025').length, 90);
    assert.equal(dealsForPeriod(accountingDeals, 'undated').length, 1);
    assert.equal(dealsForPeriod(accountingDeals, '2025-01').length, 3);
    assert.equal(dealsForPeriod(accountingDeals, '2025-12').length, 9);
    assert.equal(dealsForPeriod(accountingDeals, '2026-01').length, 0);
    assert.equal(periods.length, 14);
    assert.equal(SOURCE_SHA256.length, 64);
  });
  it('reconciles imported January and October totals to workbook cash values', () => {
    const jan = financialTotals(dealsForPeriod(accountingDeals, '2025-01'), DEFAULT_GENERAL_PARAMETERS);
    const oct = financialTotals(dealsForPeriod(accountingDeals, '2025-10'), DEFAULT_GENERAL_PARAMETERS);
    assert.ok(Math.abs(jan.revenue - 288474997.08) < 0.02);
    assert.ok(Math.abs(jan.cost - 217006288.14) < 0.02);
    assert.ok(Math.abs(oct.revenue - 280909501.54) < 0.02);
    assert.ok(Math.abs(oct.cost - 203245413.19) < 0.02);
  });
  it('excludes unassigned row 97 from the 2025 result', () => {
    const all = financialTotals(accountingDeals, DEFAULT_GENERAL_PARAMETERS);
    const assigned = financialTotals(dealsForPeriod(accountingDeals, '2025'), DEFAULT_GENERAL_PARAMETERS);
    assert.ok(Math.abs(all.revenue - assigned.revenue - 141764860.16) < 0.02);
    assert.equal(dealsForPeriod(accountingDeals, 'undated')[0].sourceRow, 97);
  });
  it('shows missing source values as null, not zero', () => {
    assert.deepEqual(sumKnown([null, null]), { sum: null, complete: false });
    assert.deepEqual(sumKnown([0, null]), { sum: 0, complete: false });
    assert.deepEqual(sumKnown([0, 10]), { sum: 10, complete: true });
    assert.deepEqual(sumKnown([]), { sum: null, complete: false });
  });
  it('does not classify an entire multi-block deal as one manufacturing block', () => {
    assert.ok(accountingDeals.every(item => item.block === 'Комплексная сделка'));
    assert.ok(accountingDeals.every(item => item.status !== 'Подтверждён'));
    const totals = financialTotals(dealsForPeriod(accountingDeals, '2025'), {
      ...DEFAULT_GENERAL_PARAMETERS,
      blocks: DEFAULT_GENERAL_PARAMETERS.blocks.map(block => ({ ...block, active: false })),
    });
    assert.equal(totals.count, 90); // Hiding detail cannot alter full-deal result.
    assert.equal(checkFinancialRegister(dealsForPeriod(accountingDeals, '2025'), DEFAULT_GENERAL_PARAMETERS).okToPublish, false);
  });
  it('retains provenance and flags known workbook arithmetic anomalies', () => {
    for (const row of [34, 51, 52]) assert.ok(accountingDeals.find(item => item.sourceRow === row)?.issue.includes('Выручка'));
    for (const row of [50, 80, 90, 91, 96]) assert.ok(accountingDeals.find(item => item.sourceRow === row)?.issue.includes('#DIV/0!'));
  });
  it('fails the readiness check for source arithmetic conflicts and missing periods', () => {
    const year = checkFinancialRegister(dealsForPeriod(accountingDeals, '2025'), DEFAULT_GENERAL_PARAMETERS);
    assert.equal(year.issues.filter(issue => issue.code === 'SOURCE_REVENUE_MISMATCH').length, 3);
    assert.equal(year.issues.filter(issue => issue.code === 'SOURCE_DIV_ZERO').length, 5);
    const missing = checkFinancialRegister(dealsForPeriod(accountingDeals, 'undated'), DEFAULT_GENERAL_PARAMETERS);
    assert.equal(missing.issues.filter(issue => issue.code === 'SOURCE_PERIOD_MISSING').length, 1);
    assert.equal(year.okToPublish, false);
  });
  it('accepts only a well-formed server payload', () => {
    assert.equal(parseSourceRows({ rows: SOURCE_ROWS }).length, 91);
    assert.throws(() => parseSourceRows({}));
    assert.throws(() => parseSourceRows({ rows: [[1, 2, 3]] }));
    assert.throws(() => parseSourceRows(null));
  });
});
