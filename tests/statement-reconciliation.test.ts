import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statementFinanceConflict } from '../src/domain/statement-reconciliation.ts';

describe('Deterministic reconciliation (CashFlow vps-migration)', () => {
  const zero = { openingBalance: 0, closingBalance: 0, credits: 0, debits: 0, externalIn: 0, internalIn: 0, internalOut: 0, payments: 0 };
  it('accepts valid zero and movement cases', () => {
    assert.equal(statementFinanceConflict(zero), '');
    assert.equal(statementFinanceConflict({ ...zero, openingBalance: 100, credits: 80, debits: 30, closingBalance: 150, externalIn: 30, internalIn: 50, internalOut: 20, payments: 10 }), '');
  });
  it('reports a balance mismatch', () => {
    assert.match(statementFinanceConflict({ ...zero, closingBalance: 10 }), /остатк/i);
  });
  it('reports credit classification mismatch', () => {
    assert.match(statementFinanceConflict({ ...zero, credits: 5, debits: 5, externalIn: 2 }), /поступлен/i);
  });
  it('reports debit classification mismatch', () => {
    assert.match(statementFinanceConflict({ ...zero, debits: 5, credits: 5, externalIn: 5, payments: 2 }), /списан/i);
  });
  it('rejects non-finite monetary values despite good metadata', () => {
    assert.match(statementFinanceConflict({ ...zero, openingBalance: Number.POSITIVE_INFINITY }), /некорректн/i);
  });
});
