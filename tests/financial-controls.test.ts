import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_GENERAL_PARAMETERS, checkFinancialRegister, effectiveSourceValue,
  financialTotals, isMaterialDeviation, validateGeneralParameters,
  type FinancialDeal,
} from '../src/domain/financial-controls.ts';

const deal: FinancialDeal = { id: '1', name: 'Сделка', block: 'МК', revenue: 100_000, cost: 70_000, plan: 100_000, status: 'Подтверждён' };
const params = () => ({ ...DEFAULT_GENERAL_PARAMETERS, blocks: DEFAULT_GENERAL_PARAMETERS.blocks.map(block => ({ ...block })) });

describe('Financial control and common parameters (CashFlow pattern)', () => {
  it('has reproducible profit and sales margin', () => {
    assert.deepEqual(financialTotals([deal], params()), { revenue: 100_000, cost: 70_000, plan: 100_000, profit: 30_000, margin: 30, count: 1 });
  });
  it('treats zero revenue as unavailable margin and not zero percent', () => {
    const totals = financialTotals([{ ...deal, revenue: 0, cost: 0 }], params());
    assert.equal(totals.margin, null);
  });
  it('keeps inactive and excluded blocks out of totals', () => {
    const p = params();
    p.blocks[0].includeInTotals = false;
    assert.equal(financialTotals([deal], p).count, 0);
    p.blocks[0].includeInTotals = true;
    p.blocks[0].active = false;
    assert.equal(financialTotals([deal], p).revenue, 0);
  });
  it('rejects NaN before aggregating and marks it a blocker', () => {
    const faulty = { ...deal, cost: Number.NaN };
    assert.throws(() => financialTotals([faulty], params()), /сумм/);
    assert.ok(checkFinancialRegister([faulty], params()).issues.some(item => item.code === 'INVALID_AMOUNT'));
  });
  it('detects duplicate IDs and missing required fields', () => {
    const result = checkFinancialRegister([deal, { ...deal, name: '' }], params());
    assert.ok(result.issues.some(issue => issue.code === 'DUPLICATE_ID'));
    assert.ok(result.issues.some(issue => issue.code === 'REQUIRED_FIELD'));
    assert.equal(result.okToPublish, false);
  });
  it('requires administrator confirmation for required blocks', () => {
    const result = checkFinancialRegister([{ ...deal, status: 'На проверке' }], params());
    assert.ok(result.issues.some(issue => issue.code === 'NOT_CONFIRMED' && issue.level === 'blocker'));
  });
  it('treats monetary or percentage change as material', () => {
    assert.equal(isMaterialDeviation(100_001, 100_000, params()), false);
    assert.equal(isMaterialDeviation(103_000, 100_000, params()), true);
    assert.equal(isMaterialDeviation(50001, 0, params()), true);
    assert.equal(isMaterialDeviation(49999, 0, params()), false);
  });
  it('fails closed on invalid common parameters', () => {
    assert.ok(validateGeneralParameters({ ...params(), materialityRub: 0 }).length);
    assert.equal(checkFinancialRegister([deal], { ...params(), materialityPercent: Number.NaN }).okToPublish, false);
  });
  it('distinguishes missing, zero, carried forward and date-only source values', () => {
    const source = { code: 'RESERVE', active: true, required: true, valuePolicy: 'carry_forward' as const };
    const values = [{ code: 'RESERVE', period: '2026-09', amount: 0 }, { code: 'RESERVE', period: '2026-10', amount: 150 }];
    assert.equal(effectiveSourceValue(source, values, '2026-08').amount, null);
    assert.deepEqual(effectiveSourceValue(source, values, '2026-09'), { amount: 0, sourcePeriod: '2026-09', carriedForward: false });
    assert.deepEqual(effectiveSourceValue(source, values, '2026-11'), { amount: 150, sourcePeriod: '2026-10', carriedForward: true });
    assert.equal(effectiveSourceValue({ ...source, valuePolicy: 'daily' }, values, '2026-11').amount, null);
  });
});
