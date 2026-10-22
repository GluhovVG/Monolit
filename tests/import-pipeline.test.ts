import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFileKind } from '../src/import/detect.ts';
import { parseReference } from '../src/import/reference.ts';
import { parseRates } from '../src/import/rates.ts';
import { parseProduction } from '../src/import/production.ts';
import { b24FromDealName, departmentFromFileName, detectDepartmentMapping, extractDepartmentDeals, sanitizeMapping } from '../src/import/department.ts';
import { normalizeName, periodFromNumber } from '../src/import/sheet.ts';
import { computeMkLines } from '../src/domain/mk-production.ts';
import { consolidate } from '../src/domain/consolidate.ts';
import type { Workbook } from '../src/import/sheet.ts';

const reference: Workbook = { fileName: 'Номера заказов.xlsx', sheets: [{ name: 'Текущие', rows: [
  ['заголовок'],
  ['Б24', 'Наименование', 'Товар', null, null, null, null, null, null, 'ШИФР\nТип - Объем', null, null, null, 'Шифр для бухгалтерии (ОПП)'],
  [],
  [1001, 'ООО Альфа', 'РВС 1000', null, null, null, null, null, null, 'РВС-1000/1-Альфа', null, null, null, 501],
  [null, null, 'РВС 1000', null, null, null, null, null, null, 'РВС-1000/2-Альфа', null, null, null, 502],
  [1002, 'ООО Бета', 'РВС 500', null, null, null, null, null, null, 'РВС-500/1-Бета', null, null, null, 'без шифра'],
] }] };
const rates: Workbook = { fileName: 'Расценки.xlsx', sheets: [{ name: 'Расценки', rows: [
  [null, 'Затраты СЗ без металла ', null, null, 'Наименование подрядчика', 'стоимость кг'],
  ['период', 'К/ты по мес', null, null, 'подрядчик МеталлСтрой', 41],
  [2026.01, 50, null, null, 'ЗАО Металлстрой ', 41],
  [2026.1, 47.5, null, null, ' подрядчик Опора', 40],
] }] };
const header = (detail: string) => [
  [null], ['Отчет по выпуску ' + detail + ' для финслужбы'], [null], [null, null, null, 'Начало периода: 01.10.2023 0:00:00'],
  [null, null, null, 'Конец периода: 19.10.2026 23:59:59'], [null], [null], [null], [null],
  ['Шифр', 'Заказчик', null, null, 'Заказ', null, null, null, 'Выпуск брутто', 'Списание вес (металл)', 'Сумма всего с НДС', 'Сумма металл с НДС'],
];
const own: Workbook = { fileName: 'Выпуск СЗ.xlsx', sheets: [{ name: 'Лист_1', rows: [
  ...header('СЗ по месяцам'),
  ['Шифр', 'Заказчик', null, null, 'Заказ', null, 'Юрлицо', 'Месяц'],
  [501, 'Альфа', null, null, 'РВС-1000 (501)', null, null, null, 3, 3.2, 300000, 300000],
  [501, 'Альфа', null, null, 'РВС-1000 (501)', null, 'СЗ КВОиТ', 2026.01, 2, 2.1, 200000, 200000],
  [501, 'Альфа', null, null, 'РВС-1000 (501)', null, 'СЗ КВОиТ', 2026.1, 1, 1.1, 100000, 100000],
  ['Итого', null, null, null, null, null, null, null, 3, 3.2, 300000, 300000],
] }] };
const ext: Workbook = { fileName: 'Выпуск сторонние.xlsx', sheets: [{ name: 'Лист_1', rows: [
  ...header('заказы-сторонние цеха'),
  ['Шифр', 'Заказчик', null, null, 'Заказ', null, null, 'Цех'],
  [502, 'Альфа', null, null, 'РВС-1000 (502)', null, null, null, 4, 4, 1000, 1000],
  [502, 'Альфа', null, null, 'РВС-1000 (502)', null, null, ' подрядчик Опора', 1.5, 1.6, 1000, 1000],
  [502, 'Альфа', null, null, 'РВС-1000 (502)', null, null, '  Склад готовой продукции', 2, null, null, null],
  [502, 'Альфа', null, null, 'РВС-1000 (502)', null, null, 'Промтех', 0.5, null, null, null],
] }] };
const dept: Workbook = { fileName: 'Закрытые сделки Проектирование февраль.xlsx', sheets: [{ name: 'Лист1', rows: [
  ['СДЕЛКИ', 'Выручка от МК ФАКТ', 'Выручка от Проектирования ФАКТ', 'Себестоимость Проектирования ФАКТ', 'Прибыль от Проектирования ФАКТ'],
  ['1001_Альфа_РВС', 999, 500000, 300000, 200000],
  ['Февраль ИТОГО', 999, 500000, 300000, 200000],
  ['Новая сделка без номера', 0, 100, 40, 60],
] }] };

describe('import: file detection and parsing', () => {
  it('detects every kind by content or name', () => {
    assert.equal(detectFileKind(reference), 'reference');
    assert.equal(detectFileKind(rates), 'rates');
    assert.equal(detectFileKind(own), 'prod_own');
    assert.equal(detectFileKind(ext), 'prod_ext');
    assert.equal(detectFileKind(dept), 'department');
    assert.equal(detectFileKind({ fileName: 'x.xlsx', sheets: [{ name: 'a', rows: [['что-то']] }] }), 'unknown');
  });
  it('carries deal number forward to following tank lines', () => {
    const rows = parseReference(reference);
    assert.deepEqual(rows.map(r => [r.b24, r.opp]), [[1001, 501], [1001, 502], [1002, null]]);
  });
  it('reads monthly coefficients (2026.1 = October) and contractor rates', () => {
    const r = parseRates(rates);
    assert.deepEqual(r.ownByMonth, { '2026-01': 50, '2026-10': 47.5 });
    assert.equal(r.contractor['металлстрой'], 41);
    assert.equal(r.contractor['опора'], 40);
    assert.equal(periodFromNumber(2025.12), '2025-12');
    assert.equal(normalizeName('ООО "Строймет"'), 'строймет');
  });
  it('keeps detail lines only and skips order subtotals and totals', () => {
    assert.equal(parseProduction(own).rows.length, 2);
    assert.equal(parseProduction(ext).rows.length, 3);
    assert.equal(parseProduction(own).periodTo, '19.10.2026');
  });
  it('parses department file name and columns of that department', () => {
    assert.deepEqual(departmentFromFileName('Закрытые сделки Проектирование февраль.xlsx', 2026), { department: 'Проектирование', period: '2026-02' });
    assert.deepEqual(departmentFromFileName('Закрытые сделки СМР октябрь 2025.xlsx', 2026), { department: 'СМР', period: '2025-10' });
    assert.equal(departmentFromFileName('Отчёт.xlsx', 2026), null);
    const m = detectDepartmentMapping(dept, 'Проектирование')!;
    assert.equal(m.revenueFact, 2);
    const deals = extractDepartmentDeals(dept, m);
    assert.equal(deals.length, 2);
    assert.equal(deals[0].b24, 1001);
    assert.equal(b24FromDealName('7293_Полиметалл'), 7293);
    assert.equal(b24FromDealName('Полиметалл 2026'), null);
  });
  it('rejects AI mappings that point outside the sheet', () => {
    assert.equal(sanitizeMapping(dept, { headerRow: 0, deal: 0, revenueFact: 99, costFact: 3 }, 'ai'), null);
    assert.ok(sanitizeMapping(dept, { headerRow: 0, deal: 0, revenueFact: 2, costFact: 3 }, 'ai'));
  });
});

describe('MK production cost', () => {
  it('metal + output × 1000 × monthly coefficient / contractor rate', () => {
    const { lines, issues } = computeMkLines(parseProduction(own).rows, parseProduction(ext).rows, parseRates(rates));
    const jan = lines.find(l => l.month === '2026-01')!;
    assert.equal(jan.workRub, 2 * 1000 * 50);
    assert.equal(jan.totalRub, 200000 + 100000);
    const opora = lines.find(l => l.workshop.includes('Опора'))!;
    assert.equal(opora.workRub, 1.5 * 1000 * 40);
    const stock = lines.find(l => l.workshop.includes('Склад'))!;
    assert.equal(stock.workRub, 0);
    assert.equal(stock.rate, 0);
    assert.ok(issues.some(i => i.message.includes('Промтех')));
    assert.ok(!issues.some(i => i.message.includes('Склад')));
  });
  it('uses a confirmed alias for a contractor without an exact rate', () => {
    const { lines } = computeMkLines([], parseProduction(ext).rows, parseRates(rates), { 'промтех': 'опора' });
    assert.equal(lines.find(l => l.workshop === 'Промтех')!.workRub, 0.5 * 1000 * 40);
  });
});

describe('consolidated deals', () => {
  it('joins department blocks, accounting codes and MK production by Б24', () => {
    const meta = departmentFromFileName(dept.fileName, 2026)!;
    const m = detectDepartmentMapping(dept, meta.department)!;
    const c = consolidate({
      reference: parseReference(reference), rates: parseRates(rates),
      prodOwn: parseProduction(own).rows, prodExt: parseProduction(ext).rows,
      departments: [{ ...meta, fileName: dept.fileName, mapping: m, deals: extractDepartmentDeals(dept, m) }],
      dealAliases: {}, contractorAliases: {},
    });
    const alfa = c.deals.find(d => d.b24 === 1001)!;
    assert.deepEqual(alfa.opps, [501, 502]);
    assert.equal(alfa.blocks[0].profitFact, 200000);
    assert.ok(alfa.mk);
    assert.equal(alfa.mk!.metalRub, 300000 + 1000);
    assert.deepEqual(c.unmatchedDealNames, ['Новая сделка без номера']);
    assert.ok(c.productionDeals.some(d => d.b24 === 1001));
  });
  it('maps a deal without a number through a confirmed alias', () => {
    const meta = departmentFromFileName(dept.fileName, 2026)!;
    const m = detectDepartmentMapping(dept, meta.department)!;
    const c = consolidate({
      reference: parseReference(reference), rates: null, prodOwn: [], prodExt: [],
      departments: [{ ...meta, fileName: dept.fileName, mapping: m, deals: extractDepartmentDeals(dept, m) }],
      dealAliases: { 'новая сделка без номера': 1002 }, contractorAliases: {},
    });
    assert.ok(c.deals.some(d => d.b24 === 1002));
    assert.equal(c.unmatchedDealNames.length, 0);
  });
});
