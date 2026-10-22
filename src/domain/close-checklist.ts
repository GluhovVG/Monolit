import { BLOCKS, blockOfDepartment, type Consolidation, type WorkspaceData } from './consolidate';

/** Чек-лист закрытия месяца: что загружено и что мешает считать месяц закрытым. */
export type CheckItem = { label: string; state: 'ok' | 'warn' | 'missing'; detail: string };

export function closeChecklist(data: WorkspaceData, c: Consolidation, period: string): CheckItem[] {
  const items: CheckItem[] = [];
  const file = (label: string, ok: boolean, detail: string) => items.push({ label, state: ok ? 'ok' : 'missing', detail: ok ? detail : 'не загружен' });
  file('Номера заказов', Boolean(data.reference?.length), `${data.reference?.length ?? 0} баков`);
  file('Расценки', Boolean(data.rates), `${Object.keys(data.rates?.ownByMonth ?? {}).length} мес. коэффициентов СЗ`);
  file('Выпуск СЗ', Boolean(data.prodOwn?.length), `${data.prodOwn?.length ?? 0} строк`);
  file('Выпуск сторонних цехов', Boolean(data.prodExt?.length), `${data.prodExt?.length ?? 0} строк`);

  for (const b of BLOCKS) {
    const files = data.departments.filter(f => f.period === period && blockOfDepartment(f.department) === b.key);
    items.push({
      label: `${b.label}: закрытые сделки`,
      state: files.length ? 'ok' : 'missing',
      detail: files.length ? files.map(f => `${f.fileName} (${f.deals.length} сд.)`).join('; ') : 'файла за месяц нет',
    });
  }

  const rows = c.rows.filter(r => r.period === period);
  const count = (code: string) => rows.filter(r => r.issues.some(i => i.code === code)).length;
  const noTkp = count('NO_TKP');
  const noProd = count('NO_PRODUCTION');
  const blockers = rows.filter(r => r.issues.some(i => i.level === 'blocker')).length;
  items.push({ label: 'Шифров ОПП за месяц', state: rows.length ? 'ok' : 'missing', detail: String(rows.length) });
  items.push({ label: '«Расчёт ТКП» по сделкам', state: noTkp ? 'warn' : 'ok', detail: noTkp ? `нет ТКП у ${noTkp} шифров` : 'есть у всех' });
  items.push({ label: 'Выпуск МК по шифрам', state: noProd ? 'warn' : 'ok', detail: noProd ? `нет выпуска у ${noProd} шифров` : 'есть у всех' });
  items.push({ label: 'Блокирующие замечания', state: blockers ? 'warn' : 'ok', detail: blockers ? `${blockers} шифров` : 'нет' });
  return items;
}
