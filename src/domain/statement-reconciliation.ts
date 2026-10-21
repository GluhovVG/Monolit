/**
 * CashFlow vps-migration arithmetic reconciliation adapted for future bank
 * sources in MONOLITH. This function validates monetary fields only.
 * "movement-only" files must be handled separately and never establish balance.
 */
export type StatementAmounts = {
  openingBalance: number; closingBalance: number;
  credits: number; debits: number;
  externalIn: number; internalIn: number;
  internalOut: number; payments: number;
};
export function statementFinanceConflict(amounts: StatementAmounts): string {
  const values = [
    amounts.openingBalance, amounts.closingBalance, amounts.credits, amounts.debits,
    amounts.externalIn, amounts.internalIn, amounts.internalOut, amounts.payments,
  ];
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    return 'В выписке есть некорректные суммы. Требуется проверка.';
  }
  const equal = (a: number, b: number) => Math.abs(a - b) < 0.02;
  if (!equal(amounts.openingBalance + amounts.credits - amounts.debits, amounts.closingBalance)) {
    return 'Контроль остатка не сходится: начало + кредит − дебет ≠ конец.';
  }
  if (!equal(amounts.externalIn + amounts.internalIn, amounts.credits)) {
    return 'Сумма поступлений не совпадает с кредитовым оборотом.';
  }
  if (!equal(amounts.internalOut + amounts.payments, amounts.debits)) {
    return 'Сумма списаний не совпадает с дебетовым оборотом.';
  }
  return '';
}
