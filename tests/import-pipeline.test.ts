import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFileKind } from '../src/import/detect.ts';
import { parseReference } from '../src/import/reference.ts';
import { parseRates } from '../src/import/rates.ts';
import { parseProduction } from '../src/import/production.ts';
import { b24FromDealRef, departmentFromFileName, detectDepartmentMapping, extractDepartmentDeals, sanitizeMapping } from '../src/import/department.ts';
import { b24FromTkpFileName, matchPositionOpp, parseTkp } from '../src/import/tkp.ts';
import { normalizeName, periodFromNumber } from '../src/import/sheet.ts';
import { computeMkLines } from '../src/domain/mk-production.ts';
import { consolidate, resolveTankOpp, sameContractor } from '../src/domain/consolidate.ts';
import { revenuePrices } from '../src/domain/revenue-prices.ts';
import { parseWeights } from '../src/import/weights.ts';
import type { Workbook } from '../src/import/sheet.ts';

const reference: Workbook = { fileName: 'Номера заказов.xlsx', sheets: [{ name: 'Текущие', rows: [
  ['заголовок'],
  ['Б24', 'Наименование', 'Товар', null, null, null, null, null, null, 'ШИФР\nТип - Объем', 'Заводской номер', null, null, 'Шифр для бухгалтерии (ОПП)'],
  [],
  [1001, 'ООО Альфа', 'РВС 1000', null, null, null, null, null, null, 'РВС-1000/1-Альфа', '№01/26', null, null, 501],
  [null, null, 'РВС 1000', null, null, null, null, null, null, 'РВС-1000/2-Альфа', '02/26', null, null, null],
  [null, null, 'РВС 500', null, null, null, null, null, null, 'РВС-500/1-Альфа', '03/26', null, null, 502],
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
// «Закрытые сделки» template: deal columns + department blocks (header row + role row). Synthetic data.
const templateHeader = [
  [null],
  [null, 'Заказчик', 'Товар ', 'Сумма договора, руб с НДС', 'Штрафы/удержания, руб. с НДС', 'Ссылка на сделку Б24', 'Шифр', 'Примечание',
    'Комплектация', null, null, null, null, null, 'Переразмещения (частичные)', null, 'Логистика до г.Самара', 'Логистика', null, null],
  [null, null, null, null, null, null, null, null, 'Наименование', 'Поставшик/ подрядчик', 'сумма по счету, руб с НДС', 'Бюджет, руб с НДС',
    'сумма фактических затрат, руб с НДС', '∆', 'Затраты , руб с ндс', 'Вес, тн', null, 'Бюджет, руб с НДС', 'сумма фактических затрат, руб с НДС', '∆'],
];
const dept: Workbook = { fileName: 'Закрытые сделки Комплектация февраль.xlsx', sheets: [{ name: 'Лист1', rows: [
  ...templateHeader,
  [null, 'ООО Альфа', 'РВС 1000 2шт, РВС 500', 5000000, 10000, 'https://crm.example/crm/deal/details/1001/', 'РВС-1000/1-Альфа №01/26', null,
    'метизы', 'Поставщик А', 40000, 50000, 40000, 10000, null, null, 2000, 'КИП', null, 120000],
  [null, null, null, null, null, null, null, null, 'прокладки', 'Поставщик Б', null, 20000, 15000, 5000],
  [null, null, null, null, null, null, 'РВС-500/1-Альфа №03/26', null, 'ступени', 'Промтех', null, null, null, null, 30000, 0.5],
  [null, 'Новая сделка без номера', 'РВС 50', 100000, null, null, null, null, 'КИП', 'Поставщик В', null, 1000, 800],
] }] };
const logistics: Workbook = { fileName: 'Закрытые сделки Логистика февраль.xlsx', sheets: [{ name: 'Лист1', rows: [
  ...templateHeader,
  [null, 'ООО Альфа', 'РВС 1000 2шт, РВС 500', 5000000, 10000, 'https://crm.example/crm/deal/details/1001/', null, null,
    null, null, null, null, null, null, null, null, null, 300000, 250000, 50000],
  [null, 'Новая сделка без номера', 'РВС 50', 100000, null, null, null, null, null, null, null, null, null, null, null, null, null, 'самовывоз'],
] }] };
// «Расчёт ТКП»: two positions (tank types) of deal 1001.
const tkpBook: Workbook = { fileName: '1001 Расчёт ТКП Альфа РВС 1000 2шт.xlsm', sheets: [{ name: 'Настройки', rows: [] }, { name: 'Расчёт ТКП', rows: [
  ['ЗАКАЗЧИК'], [], ['Объём поставки,кг'],
  ['Наименование позиций лота ', 'Раздел', 'Наименование', null, null, null, null, null, null, null, null, null, null, null, null,
    'Кол-во на поставку план, кг', null, 'Итого полная себестоимость план', null, null, null, null, null, null, null,
    'Конечная стоимость для продажи план', 'Конечная стоимость для продажи факт'],
  ['РВС- 1000м3', 'Металлоконструкции', 'РВС- 1000м3', null, null, null, null, null, null, null, null, null, null, null, null, 3000, null, 400000],
  [null, null, 'ИТОГО МК', null, null, null, null, null, null, null, null, null, null, null, null, 3000, null, 400000, null, null, null, null, null, null, null, 600000, 600000],
  [null, 'Доставка до клиента', 'ПЛ', null, null, null, null, null, null, null, null, null, null, null, null, null, null, 300000],
  ['Позиция №2'],
  ['РВС- 500м3', 'Металлоконструкции', 'РВС- 500м3'],
  [null, null, 'ИТОГО МК', null, null, null, null, null, null, null, null, null, null, null, null, 4000, null, 100000, null, null, null, null, null, null, null, 200000, 200000],
  ['Позиция №3'],
  [null, null, 'ИТОГО МК', null, null, null, null, null, null, null, null, null, null, null, null, 0, null, 0, null, null, null, null, null, null, null, 0, 0],
] }] };
const deptFiles = () => [dept, logistics].map(book => {
  const meta = departmentFromFileName(book.fileName, 2026)!;
  const mapping = detectDepartmentMapping(book, meta.department)!;
  return { ...meta, fileName: book.fileName, mapping, deals: extractDepartmentDeals(book, mapping) };
});

describe('import: file detection and parsing', () => {
  it('detects every kind by content or name', () => {
    assert.equal(detectFileKind(reference), 'reference');
    assert.equal(detectFileKind(rates), 'rates');
    assert.equal(detectFileKind(own), 'prod_own');
    assert.equal(detectFileKind(ext), 'prod_ext');
    assert.equal(detectFileKind(dept), 'department');
    assert.equal(detectFileKind(tkpBook), 'tkp');
    assert.equal(detectFileKind({ fileName: 'x.xlsx', sheets: [{ name: 'a', rows: [['что-то']] }] }), 'unknown');
  });
  it('carries deal number and ОПП of the same tank type forward; strips № from factory numbers', () => {
    const rows = parseReference(reference);
    assert.deepEqual(rows.map(r => [r.b24, r.opp, r.factoryNo]), [[1001, 501, '01/26'], [1001, 501, '02/26'], [1001, 502, '03/26'], [1002, null, '']]);
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
  it('drops order subtotal lines whose merged order name spilled into «Месяц» / «Цех»', () => {
    const spilled: Workbook = { fileName: 'Выпуск СЗ.xlsx', sheets: [{ name: 'Лист_1', rows: [
      ...header('СЗ по месяцам'),
      ['Шифр', 'Заказчик', null, null, 'Заказ', null, 'Юрлицо', 'Месяц'],
      [688, 'Альфа', null, null, 'РВС-200-Альфа/25 (688)', null, 'РВС-200-Альфа/25 (688)', 'РВС-200-Альфа/25 (688)', 19.12, 19, 2800000, 2800000],
      [688, 'Альфа', null, null, 'РВС-200-Альфа/25 (688)', null, 'СЗ КВОиТ', 2026.01, 7.848, 7.8, 476330, 476330],
      [688, 'Альфа', null, null, 'РВС-200-Альфа/25 (688)', null, 'СЗ КВОиТ', 2026.03, 11.272, 11.2, 912261, 912261],
    ] }] };
    const rows = parseProduction(spilled).rows;
    assert.equal(rows.length, 2);
    assert.equal(Math.round(rows.reduce((s, r) => s + r.outputT, 0) * 1000), 19120);
    const extSpilled: Workbook = { fileName: 'Выпуск сторонние.xlsx', sheets: [{ name: 'Лист_1', rows: [
      ...header('заказы-сторонние цеха'),
      ['Шифр', 'Заказчик', null, null, 'Заказ', null, null, 'Цех'],
      [688, 'Альфа', null, null, 'РВС-200-Альфа/25 (688)', null, null, 'РВС-200-Альфа/25 (688)', 0.52, null, 0, 0],
      [688, 'Альфа', null, null, 'РВС-200-Альфа/25 (688)', null, null, 'Промтех', 0.52, null, 0, 0],
    ] }] };
    assert.deepEqual(parseProduction(extSpilled).rows.map(r => r.workshop), ['Промтех']);
  });
  it('parses department file name and the blocks owned by the department', () => {
    assert.deepEqual(departmentFromFileName('Закрытые сделки Проектирование февраль.xlsx', 2026), { department: 'Проектирование', period: '2026-02' });
    assert.deepEqual(departmentFromFileName('Закрытые сделки СМР октябрь 2025.xlsx', 2026), { department: 'СМР', period: '2025-10' });
    assert.equal(departmentFromFileName('Отчёт.xlsx', 2026), null);
    const m = detectDepartmentMapping(dept, 'Комплектация')!;
    assert.deepEqual(m.blocks.map(b => b.title), ['Комплектация', 'Переразмещения (частичные)', 'Логистика до г.Самара']);
    const deals = extractDepartmentDeals(dept, m);
    assert.equal(deals.length, 2);
    assert.equal(deals[0].b24, 1001);
    assert.equal(deals[0].contractRub, 5000000);
    // «Логистика» columns belong to another department and are ignored here.
    assert.ok(!deals[0].lines.some(l => l.block === 'Логистика'));
    const realloc = deals[0].lines.find(l => l.block.startsWith('Переразмещения'))!;
    assert.deepEqual([realloc.name, realloc.supplier, realloc.factRub, realloc.tank], ['ступени', 'Промтех', 30000, 'РВС-500/1-Альфа №03/26']);
    // Tank cell is carried down to the next lines of the same deal.
    assert.equal(deals[0].lines.find(l => l.name === 'прокладки')!.tank, 'РВС-1000/1-Альфа №01/26');
    assert.equal(b24FromDealRef('https://crm.example/crm/deal/details/6940/'), 6940);
    assert.equal(b24FromDealRef('7293_Полиметалл'), 7293);
    assert.equal(b24FromDealRef('Полиметалл 2026'), null);
    const lm = detectDepartmentMapping(logistics, 'Логистика')!;
    const ld = extractDepartmentDeals(logistics, lm);
    assert.equal(ld[1].lines[0].note, 'самовывоз');
    assert.equal(ld[1].lines[0].budgetRub, null);
  });
  it('rejects AI mappings that point outside the sheet', () => {
    assert.equal(sanitizeMapping(dept, { headerRow: 1, link: 5, budget: 99, fact: 99 }, 'Комплектация'), null);
    assert.ok(sanitizeMapping(dept, { headerRow: 1, link: 5, tank: 6, budget: 11, fact: 12 }, 'Комплектация'));
  });
  it('reads MK plan of every ТКП position and matches positions to ОПП', () => {
    const t = parseTkp(tkpBook);
    assert.equal(t.b24, 1001);
    assert.deepEqual(t.positions.map(p => [p.name, p.weightPlanKg, p.mkCostPlan, p.mkValuePlan]), [['РВС- 1000м3', 3000, 400000, 600000], ['РВС- 500м3', 4000, 100000, 200000]]);
    assert.equal(b24FromTkpFileName('ТКП 8559 РВС 2000 3,1.xlsm'), 8559);
    const ref = parseReference(reference).filter(r => r.b24 === 1001);
    assert.equal(matchPositionOpp('РВС- 1 000м3 №3', ref).opp, 501);
    const marks = [{ b24: 1, client: '', tankCode: 'РВС-200/E-811/1', factoryNo: '', opp: 767, sheet: '' }, { b24: 1, client: '', tankCode: 'РВС-200/Е-819/2', factoryNo: '', opp: 766, sheet: '' }];
    assert.equal(matchPositionOpp('РВС- 200м3 Е-811/1, Е-811/2', marks).opp, 767);
    assert.deepEqual(matchPositionOpp('РВС- 200м3', marks), { opp: null, candidates: [766, 767] });
  });
  it('resolves tank text of a line to one ОПП, also for two tanks of the same type', () => {
    const ref = [
      { b24: 6, client: '', tankCode: 'РГС-25/407.1-Е-01-Алроса', factoryNo: '132/25', opp: 681, sheet: '' },
      { b24: 6, client: '', tankCode: 'РГС-16/406-РГСН-1 - Алроса', factoryNo: '133/25', opp: 682, sheet: '' },
      { b24: 6, client: '', tankCode: 'РГС-16/406-РГСН-2 - Алроса', factoryNo: '134/25', opp: 682, sheet: '' },
    ];
    assert.equal(resolveTankOpp('РГС-25/407.1-Е-01-Алроса №132/25', ref), 681);
    assert.equal(resolveTankOpp('РГС-16/406-РГСН-1 - Алроса №133/25 и РГС-16/406-РГСН-2 - Алроса №134/25', ref), 682);
    assert.equal(resolveTankOpp('РГС-25/407.1-Е-01-Алроса №132/25 и РГС-16/406-РГСН-1 №133/25', ref), null);
    assert.equal(resolveTankOpp('', ref), null);
    assert.ok(sameContractor('ООО «Промтех»', 'ПромТех'));
    assert.ok(!sameContractor('БКК', 'ФлоуТэк'));
  });
});

describe('MK production cost', () => {
  it('metal + output × 1000 × monthly coefficient / contractor rate', () => {
    const { lines, issues, missingContractors } = computeMkLines(parseProduction(own).rows, parseProduction(ext).rows, parseRates(rates));
    const jan = lines.find(l => l.month === '2026-01')!;
    assert.equal(jan.workRub, 2 * 1000 * 50);
    assert.equal(jan.totalRub, 200000 + 100000);
    const opora = lines.find(l => l.workshop.includes('Опора'))!;
    assert.equal(opora.workRub, 1.5 * 1000 * 40);
    const stock = lines.find(l => l.workshop.includes('Склад'))!;
    assert.equal(stock.workRub, 0);
    assert.equal(stock.rate, 0);
    // A contractor without a rate is listed for matching, but is not a warning: its cost comes from reallocations.
    assert.deepEqual(missingContractors, ['Промтех']);
    assert.ok(!issues.some(i => i.message.includes('Промтех') || i.message.includes('Склад')));
  });
  it('uses a confirmed alias for a contractor without an exact rate', () => {
    const { lines } = computeMkLines([], parseProduction(ext).rows, parseRates(rates), { 'промтех': 'опора' });
    assert.equal(lines.find(l => l.workshop === 'Промтех')!.workRub, 0.5 * 1000 * 40);
  });
});

describe('register by ОПП (sheet «Сделки»)', () => {
  const data = () => ({
    reference: parseReference(reference), rates: parseRates(rates),
    prodOwn: parseProduction(own).rows, prodExt: parseProduction(ext).rows,
    departments: deptFiles(), tkp: [parseTkp(tkpBook)], dealAliases: {} as Record<string, number>, contractorAliases: {},
  });
  it('one row per ОПП with revenue = MK value (ТКП) + block budgets and cost = MK + block facts + fines', () => {
    const c = consolidate(data());
    const r501 = c.rows.find(r => r.opp === 501)!;
    const r502 = c.rows.find(r => r.opp === 502)!;
    assert.equal(r501.b24, 1001);
    assert.deepEqual(r501.tanks, ['РВС-1000/1-Альфа №01/26', 'РВС-1000/2-Альфа №02/26']);
    assert.equal(r501.share, 0.75); // 600 000 / (600 000 + 200 000) of MK value
    assert.equal(r501.blocks.supply.plan, 70000);
    assert.equal(r501.blocks.supply.fact, 40000 + 15000 + 2000); // + «Логистика до г.Самара»
    assert.equal(r501.blocks.delivery.plan, 300000 * 0.75); // deal-level line, no tank
    assert.equal(r501.revenuePlan, 600000 + 70000 + 225000);
    assert.equal(r501.revenueFact, r501.revenuePlan);
    assert.equal(r501.costPlan, 400000 + 70000 + 225000);
    // Own plant: write-off 200 000 + 100 000; work 2 t × 1000 × 50 + 1 t × 1000 × 47,5.
    assert.equal(r501.mk!.costRub, 300000 + 100000 + 47500);
    assert.equal(r501.costFact, 447500 + 57000 + 250000 * 0.75 + 10000 * 0.75);
    assert.equal(r501.profitFact, r501.revenueFact! - r501.costFact!);
    assert.equal(r501.weightPlanKg, 3000);
    assert.equal(r501.weightFactKg, 3000);
    assert.equal(r501.priceKg, 200);
    // Contractor without a rate (Промтех): its cost is the reallocation from Комплектация.
    assert.equal(r502.mk!.ext.workRub, 1.5 * 1000 * 40);
    assert.equal(r502.mk!.ext.reallocationRub, 30000);
    assert.equal(r502.mk!.costRub, 1000 + 60000 + 30000);
    assert.equal(r502.blocks.supply.plan, null);
    assert.ok(!r502.issues.some(i => i.code === 'MK_NO_RATE'));
    assert.ok(r501.issues.some(i => i.code === 'REVENUE_VS_CONTRACT'));
    assert.deepEqual(c.missingBlocks, ['Документация', 'СМР']);
  });
  it('lists deals without Б24 and maps them through a confirmed alias', () => {
    assert.deepEqual(consolidate(data()).unmatchedDealNames, ['Новая сделка без номера РВС 50']);
    const c = consolidate({ ...data(), dealAliases: { 'новая сделка без номера рвс 50': 1002 } });
    const row = c.rows.find(r => r.b24 === 1002)!;
    assert.equal(row.opp, null);
    assert.ok(row.issues.some(i => i.code === 'NO_OPP'));
    assert.equal(row.blocks.supply.fact, 800);
    assert.equal(c.unmatchedDealNames.length, 0);
  });
  it('flags a deal closed twice by the same department and production codes not in the reference', () => {
    const files = deptFiles();
    const c = consolidate({ ...data(), departments: [...files, { ...files[0], period: '2026-03' }] });
    assert.ok(c.rows.find(r => r.opp === 501)!.issues.some(i => i.code === 'DUPLICATE_BLOCK'));
    assert.deepEqual(c.production.map(p => p.opp).sort(), [501, 502]);
    assert.ok(c.production.every(p => p.finished));
  });
});

describe('prices for revenue (MK value / weight)', () => {
  const weightsBook = (header: string, value: number): Workbook => ({ fileName: 'Веса.xlsx', sheets: [{ name: 'Веса', rows: [
    ['Шифр для бухгалтерии (ОПП)', 'Заказчик', header], [501, 'Альфа', value], [501, 'Альфа', value],
  ] }] });
  it('reads weights by ОПП in kg or tonnes and sums tanks of one code', () => {
    assert.equal(detectFileKind(weightsBook('Вес, кг', 1500)), 'weights');
    assert.deepEqual(parseWeights(weightsBook('Вес, кг', 1500)).byOpp, { '501': 3000 });
    assert.deepEqual(parseWeights(weightsBook('Вес, т', 1.5)).byOpp, { '501': 3000 });
    const guessed = parseWeights(weightsBook('Вес', 1.5));
    assert.equal(guessed.unit, 'т');
    assert.equal(guessed.unitFromHeader, false);
  });
  it('price per tonne uses the weights file first and the ТКП plan weight otherwise', () => {
    const ref = parseReference(reference);
    const t = parseTkp(tkpBook);
    const withFile = revenuePrices([t], ref, parseWeights(weightsBook('Вес, кг', 1250)));
    const r501 = withFile.find(r => r.opp === 501)!;
    assert.equal(r501.weightSource, 'weights');
    assert.equal(r501.weightKg, 2500);
    assert.equal(r501.pricePerT, 600000 / 2.5);
    assert.deepEqual(r501.tanks, ['РВС-1000/1-Альфа №01/26', 'РВС-1000/2-Альфа №02/26']);
    assert.equal(r501.customer, 'ООО Альфа');
    const r502 = withFile.find(r => r.opp === 502)!;
    assert.equal(r502.weightSource, 'tkp');
    assert.equal(r502.pricePerT, 200000 / 4);
    const noFile = revenuePrices([t], ref, null);
    assert.equal(noFile.find(r => r.opp === 501)!.pricePerT, 600000 / 3);
  });
});

describe('automatic checks, month close and summaries', () => {
  it('flags loss, cost overrun and weight deviation; skips missing values', async () => {
    const { rowChecks } = await import('../src/domain/checks.ts');
    const base = { opp: 1, revenueFact: 100, costPlan: 80, costFact: 120, profitFact: -20, weightPlanKg: 1000, weightFactKg: 1200 };
    assert.deepEqual(rowChecks(base).map(i => i.code), ['LOSS', 'COST_OVER_PLAN', 'WEIGHT_DEVIATION']);
    assert.deepEqual(rowChecks({ ...base, profitFact: 20, costFact: 82, weightFactKg: 1050 }), []);
    assert.deepEqual(rowChecks({ ...base, costPlan: null, weightPlanKg: null, profitFact: null }), []);
  });
  it('marks a price far from the median of all codes', async () => {
    const { priceOutliers } = await import('../src/domain/checks.ts');
    const row = (key: string, pricePerT: number) => ({ key, pricePerT } as unknown as import('../src/domain/revenue-prices.ts').PriceRow);
    const out = priceOutliers([row('a', 100000), row('b', 110000), row('c', 120000), row('d', 1200000)]);
    assert.deepEqual(Array.from(out.keys()), ['d']);
  });
  it('month checklist lists missing department files and summaries add sums first', async () => {
    const { closeChecklist } = await import('../src/domain/close-checklist.ts');
    const { summarize } = await import('../src/domain/summary.ts');
    const data = {
      reference: parseReference(reference), rates: parseRates(rates),
      prodOwn: parseProduction(own).rows, prodExt: parseProduction(ext).rows,
      departments: deptFiles(), tkp: [parseTkp(tkpBook)], dealAliases: {}, contractorAliases: {},
    };
    const c = consolidate(data);
    const items = closeChecklist(data, c, '2026-02');
    assert.equal(items.find(i => i.label.startsWith('Документация'))!.state, 'missing');
    assert.equal(items.find(i => i.label.startsWith('Комплектация'))!.state, 'ok');
    const [line] = summarize(c.rows.filter(r => r.b24 === 1001), () => 'all');
    const rev = c.rows.filter(r => r.b24 === 1001).reduce((s, r) => s + (r.revenueFact ?? 0), 0);
    assert.equal(line.revenueFact, rev);
    assert.equal(line.margin, line.profitFact! / line.revenueFact!);
  });
});

describe('weights file «Веса» in blocks by ОПП', () => {
  it('takes «ВСЕГО» of each block and sums blocks of one code; notes a block without total', () => {
    const book: Workbook = { fileName: 'Веса.xlsx', sheets: [{ name: '2026', rows: [
      [null, 'Наименование', 'Чистый вес (по КМД, без напл.мет.) за общ.кол-во комплектов, кг.', 'Грязный вес, кг.'],
      [501, 'Альфа', 'РВС-1000', '2шт', null, null, '№01/26, №02/26', 2000],
      ['МК', 'Стенка', 1500, 1600],
      ['ПОДРЯД', 'Ступени', 500],
      [null, 'ИТОГО (без ПОДРЯДА):', 1500, 1600],
      [null, 'ВСЕГО:', 2000],
      [501, 'Альфа', 'РВС-1000', '1шт', null, null, '№03/26', 1100],
      ['МК', 'Стенка', 1100],
      [null, 'ВСЕГО:', 1100],
      [502, 'Альфа', 'РВС-500', '1шт', null, null, '№04/26'],
      ['МК', 'Стенка', 700],
    ] }] };
    assert.equal(detectFileKind(book), 'weights');
    const w = parseWeights(book);
    assert.deepEqual(w.byOpp, { '501': 3100 });
    assert.equal(w.rows, 2);
    assert.ok(w.notes!.some(n => n.includes('502')));
  });
});

describe('financial result by output (monthly)', () => {
  it('revenue = output × price per tonne; processing = output × 1000 × month coefficient', async () => {
    const { outputFinres, outputTotals } = await import('../src/domain/output-finres.ts');
    const ref = parseReference(reference);
    const prices = revenuePrices([parseTkp(tkpBook)], ref, null); // 501: 600 000 ₽ / 3 т = 200 000 ₽/т
    const rows = outputFinres(parseProduction(own).rows, prices, parseRates(rates), ref);
    const jan = rows.find(r => r.month === '2026-01' && r.opp === 501)!;
    assert.equal(jan.outputT, 2);
    assert.equal(jan.revenue, 2 * 200000);
    assert.equal(jan.writeOffRub, 200000);
    assert.equal(jan.processingRub, 2 * 1000 * 50);
    assert.equal(jan.result, 400000 - 200000 - 100000);
    const oct = rows.find(r => r.month === '2026-10')!;
    assert.equal(oct.processingRub, 1 * 1000 * 47.5);
    // No price → revenue and result are not calculated (null), not zero.
    const noPrice = outputFinres(parseProduction(own).rows, [], parseRates(rates), ref);
    assert.equal(noPrice[0].revenue, null);
    assert.equal(noPrice[0].result, null);
    assert.ok(noPrice[0].issue.includes('нет цены'));
    const t = outputTotals(rows);
    assert.equal(t.outputT, 3);
    assert.equal(t.margin, t.result! / t.revenue!);
  });
});
