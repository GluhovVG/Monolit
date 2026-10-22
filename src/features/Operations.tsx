import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@appdeploy/client';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, ChevronRight, Download, Info, Link2, RefreshCw, Send, Trash2, Upload, X } from 'lucide-react';
import {
  BLOCKS, consolidate, dealNameKey, ratio, registerTotals,
  type Consolidation, type DealIssue, type OppMk, type OppRow, type ProductionOpp, type WorkspaceData,
} from '../domain/consolidate';
import type { MkLine } from '../domain/mk-production';
import { outputKgByOpp, revenuePrices, type PriceRow } from '../domain/revenue-prices';
import { externalReference, outputFinres, outputTotals, type OutputRow } from '../domain/output-finres';
import {
  blockTotals, departmentFromFileName, detectDepartmentMapping, extractDepartmentDeals, sanitizeMapping, sheetPreview,
  type AiMappingProposal, type DepartmentDeal, type DepartmentMapping,
} from '../import/department';
import { detectFileKind, FILE_KIND_LABELS, type FileKind } from '../import/detect';
import { parseProduction } from '../import/production';
import { parseRates } from '../import/rates';
import { parseReference } from '../import/reference';
import { normalizeName, type Workbook } from '../import/sheet';
import { parseTkp, type TkpFile } from '../import/tkp';
import { parseWeights, type WeightsFile } from '../import/weights';
import { hasActsSheet, readActs, type ActsFile } from '../import/acts';
import { outputByWorkshops, workshopTotals, WORKSHOP_GROUP_LABELS, type WorkshopGroup, type WorkshopRow } from '../domain/output-workshops';
import { readWorkbook, readWorkbookBuffer } from '../import/xlsx-reader';
import { downloadCsv, downloadXlsx, type Matrix } from './table-export';
import { closeChecklist } from '../domain/close-checklist';
import { customerKey, summarize, type SummaryLine } from '../domain/summary';
import { SourceProvider, useSource, type SourceRef } from './source-link';
import { dealsWithoutTkp } from '../domain/no-tkp';
import { buildAiContext, loadWorkspace, packProduction, packReference, type Alias, type SheetSource, type UploadMeta } from './workspace';

export type OperationsPage = 'uploads' | 'register' | 'prices' | 'output' | 'notkp' | 'production' | 'assistant';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : rub.format(n));
const kg = (n: number | null | undefined) => (n === null || n === undefined ? '—' : rub.format(n));
const tonnes = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n) + ' т';
const pct = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n * 100) + '%');
const num1 = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n));
const delta = (fact: number | null, plan: number | null) => (fact === null || plan === null ? null : fact - plan);
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const monthLabel = (period: string | null) => {
  if (!period) return '—';
  const [y, m] = period.split('-').map(Number);
  return y && m ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1))) : period;
};
const neg = (n: number | null) => (n !== null && n < 0 ? 'negative' : undefined);

/** Upload-based financial workspace: files, register by ОПП, MK production, AI. */
export function Operations({ page }: { page: OperationsPage }) {
  const [state, setState] = useState<{ data: WorkspaceData; uploads: UploadMeta[]; aliases: Alias[]; weights: WeightsFile | null; acts: ActsFile | null; sources: SheetSource[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const reload = async () => {
    try {
      setState(await loadWorkspace());
      setLoadError('');
    } catch (cause) {
      setLoadError(errorText(cause, 'Не удалось загрузить данные.'));
    }
  };
  useEffect(() => { void reload(); }, []);
  const consolidation = useMemo(() => (state ? consolidate(state.data) : null), [state]);

  if (loadError) {
    return <div className="panel"><p role="alert" className="login-error">{loadError}</p>
      <button className="btn-primary" onClick={() => void reload()}>Повторить</button></div>;
  }
  if (!state || !consolidation) return <p role="status">Загружаем данные…</p>;
  return <SourceProvider uploads={state.uploads}>{renderPage()}</SourceProvider>;

  function renderPage() {
  if (!state || !consolidation) return null;
  if (page === 'uploads') return <UploadsPage uploads={state.uploads} aliases={state.aliases} sources={state.sources} onChanged={reload} />;
  if (page === 'prices') return <PricesPage data={state.data} weights={state.weights} />;
  if (page === 'output') return <OutputPage data={state.data} weights={state.weights} acts={state.acts} />;
  if (page === 'notkp') return <NoTkpPage data={state.data} c={consolidation} />;
  if (page === 'register') return <RegisterPage c={consolidation} data={state.data} onChanged={reload} />;
  if (page === 'production') return <ProductionPage c={consolidation} data={state.data} onChanged={reload} />;
  return <AssistantPage c={consolidation} />;
  }
}

function Heading({ eyebrow, title, text, actions }: { eyebrow: string; title: string; text: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

/* ───────────────────────── Uploads ───────────────────────── */

type Pending = {
  id: string;
  fileName: string;
  status: 'reading' | 'ready' | 'ai' | 'needs_input' | 'error' | 'saving' | 'saved';
  kind: FileKind;
  book?: Workbook;
  summary: string;
  issues: string[];
  payload?: unknown;
  rowCount?: number;
  /** Department name; for «Расчёт ТКП» — the Б24 deal number. */
  department: string;
  period: string;
  mapping?: DepartmentMapping;
  aiNote?: string;
  preview?: DepartmentDeal[];
  tkp?: TkpFile;
  /** Исходный файл: после сохранения данных его копия кладётся в хранилище (для открытия из цифр). */
  file?: File;
  error?: string;
};

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function prepareActs(acts: ActsFile, base: Pending): Pending {
  const t = acts.rows.reduce((s, r) => s + r[4], 0) / 1000;
  const p = acts.periods;
  return {
    ...base, kind: 'acts', status: acts.rows.length ? 'ready' : 'error', payload: acts, rowCount: acts.actRows, issues: acts.notes,
    summary: `${acts.actRows} актов, ${p[0] ?? '—'} … ${p[p.length - 1] ?? '—'}, выпуск ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(t)} т (брутто для выручки)`,
    error: acts.rows.length ? undefined : 'На листе «Акты» нет выпуска.',
  };
}

function prepare(book: Workbook, kind: FileKind, base: Pending): Pending {
  if (kind === 'reference') {
    const rows = parseReference(book);
    const deals = new Set(rows.map(r => r.b24).filter(x => x !== null)).size;
    const opps = new Set(rows.map(r => r.opp).filter(x => x !== null)).size;
    return { ...base, status: rows.length ? 'ready' : 'error', payload: { rows: packReference(rows) }, rowCount: rows.length,
      summary: `${rows.length} баков: ${deals} сделок Б24, ${opps} шифров для бухгалтерии`, error: rows.length ? undefined : 'Не найдено строк с шифрами.' };
  }
  if (kind === 'rates') {
    const rates = parseRates(book);
    const months = Object.keys(rates.ownByMonth).sort();
    return { ...base, status: 'ready', payload: rates, rowCount: months.length,
      summary: `Коэффициенты СЗ: ${months.length} мес. (${months[0] ?? '—'} – ${months[months.length - 1] ?? '—'}); расценки подрядчиков: ${Object.keys(rates.contractor).length}`,
      issues: rates.conflicts };
  }
  if (kind === 'prod_own' || kind === 'prod_ext') {
    const report = parseProduction(book);
    const t = report.rows.reduce((s, r) => s + r.outputT, 0);
    return { ...base, status: 'ready', payload: { rows: packProduction(report.rows), periodFrom: report.periodFrom, periodTo: report.periodTo },
      rowCount: report.rows.length,
      summary: `${report.rows.length} строк выпуска, ${tonnes(t)}, период ${report.periodFrom} – ${report.periodTo}`,
      issues: report.rows.some(r => r.opp === null) ? ['Есть строки без шифра — они не попадут в сделки.'] : [] };
  }
  if (kind === 'weights') {
    const w = parseWeights(book);
    const n = Object.keys(w.byOpp).length;
    return { ...base, status: n ? 'ready' : 'error', payload: w, rowCount: n,
      summary: `Веса по ${n} шифрам ОПП (единица: ${w.unit}${w.unitFromHeader ? '' : ', определена по величине чисел — проверьте'})`,
      issues: w.notes ?? [], error: n ? undefined : 'Не найдено строк с шифром ОПП и весом.' };
  }
  if (kind === 'tkp') {
    const tkp = parseTkp(book);
    return applyTkp({ ...base, tkp, department: tkp.b24 !== null ? String(tkp.b24) : '' });
  }
  if (kind === 'department') {
    const meta = departmentFromFileName(book.fileName, new Date().getFullYear());
    const next = { ...base, department: meta?.department ?? '', period: meta?.period ?? '' };
    return applyMapping(next, book, next.department ? detectDepartmentMapping(book, next.department) : null);
  }
  return { ...base, status: 'error', error: 'Тип файла не распознан. Файлы подразделений должны называться «Закрытые сделки <Подразделение> <месяц>», ТКП — содержать лист «Расчёт ТКП».' };
}

function applyTkp(p: Pending): Pending {
  const tkp = p.tkp!;
  if (!/^\d{3,7}$/.test(p.department)) return { ...p, status: 'needs_input', summary: 'Укажите номер сделки Б24 — в названии файла его не нашли.' };
  const payload: TkpFile = { ...tkp, b24: Number(p.department) };
  const value = tkp.positions.reduce((s, x) => s + (x.mkValuePlan ?? 0), 0);
  return {
    ...p, payload, rowCount: tkp.positions.length, status: tkp.positions.length ? 'ready' : 'error',
    summary: `Сделка ${p.department}: ${tkp.positions.length} позиций, стоимость МК план ${money(value)} ₽`,
    error: tkp.positions.length ? undefined : 'В «Расчёте ТКП» нет заполненных позиций МК.',
  };
}

function applyMapping(p: Pending, book: Workbook, mapping: DepartmentMapping | null, aiNote?: string): Pending {
  if (!p.department || !/^\d{4}-\d{2}$/.test(p.period)) {
    return { ...p, status: 'needs_input', mapping: mapping ?? undefined, summary: 'Укажите подразделение и месяц.' };
  }
  if (!mapping) return { ...p, status: 'ai', summary: 'Колонки не распознаны правилами — подбираем с помощью ИИ…' };
  const deals = extractDepartmentDeals(book, mapping);
  const payload = { department: p.department, period: p.period, fileName: p.fileName, mapping, deals };
  return {
    ...p, status: deals.length ? 'ready' : 'error', mapping, aiNote, preview: deals.slice(0, 8), payload, rowCount: deals.length,
    summary: `${p.department}, ${monthLabel(p.period)}: ${deals.length} сделок, из них со ссылкой Б24: ${deals.filter(d => d.b24 !== null).length}; блоки: ${mapping.blocks.map(b => b.title).join(', ')}`,
    error: deals.length ? undefined : 'Не найдено строк сделок.',
  };
}

async function aiMap(p: Pending): Promise<Pending> {
  if (!p.book) return p;
  try {
    const res = await api.post('/api/ai/map-columns', {
      fileName: p.fileName, department: p.department,
      sheets: p.book.sheets.slice(0, 4).map(s => ({ name: s.name, preview: sheetPreview(s) })),
    });
    const raw = (res.data as { mapping?: AiMappingProposal & { explanation?: string; confidence?: number } }).mapping ?? {};
    const mapping = sanitizeMapping(p.book, raw, p.department);
    if (!mapping) return { ...p, status: 'error', error: 'ИИ не нашёл колонки бюджета и факта подразделения. Пришлите пример файла — добавим правило.' };
    const note = `ИИ: ${raw.explanation ?? ''} (уверенность ${Math.round((raw.confidence ?? 0) * 100)}%). Проверьте предпросмотр перед сохранением.`;
    return applyMapping(p, p.book, mapping, note);
  } catch (cause) {
    return { ...p, status: 'error', error: errorText(cause, 'ИИ недоступен.') };
  }
}

function UploadsPage({ uploads, aliases, sources, onChanged }: { uploads: UploadMeta[]; aliases: Alias[]; sources: SheetSource[]; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const update = (id: string, patch: Partial<Pending> | ((p: Pending) => Pending)) =>
    setPending(list => list.map(p => (p.id === id ? (typeof patch === 'function' ? patch(p) : { ...p, ...patch }) : p)));

  const addFiles = async (files: FileList | File[]) => {
    const items = Array.from(files).map((file, i) => ({
      file,
      base: { id: `${Date.now()}-${i}-${file.name}`, fileName: file.name, status: 'reading' as const, kind: 'unknown' as FileKind,
        summary: 'Читаем файл…', issues: [], department: '', period: '' },
    }));
    setPending(list => [...items.map(x => x.base), ...list]);
    for (const { file, base } of items) {
      try {
        // «Выпуск продукции» (~7 МБ, десятки листов): читается только лист «Акты», без разбора всей книги.
        const bytes = /\.xlsx$/i.test(file.name) ? new Uint8Array(await file.arrayBuffer()) : null;
        if (bytes && await hasActsSheet(bytes)) {
          update(base.id, prepareActs(await readActs(bytes, file.name), { ...base, kind: 'acts', file }));
          continue;
        }
        const book = await readWorkbook(file);
        const kind = detectFileKind(book);
        let next = prepare(book, kind, { ...base, book, kind, file });
        // ТКП workbooks are large; only the parsed positions are kept.
        if (kind === 'tkp') next = { ...next, book: undefined };
        update(base.id, next);
        if (next.status === 'ai') {
          next = await aiMap(next);
          update(base.id, next);
        }
      } catch (cause) {
        update(base.id, { status: 'error', error: errorText(cause, 'Не удалось прочитать файл.') });
      }
    }
  };

  const save = async (p: Pending) => {
    if (p.status !== 'ready' || !p.payload) return;
    update(p.id, { status: 'saving' });
    try {
      const res = await api.post('/api/uploads', { kind: p.kind, fileName: p.fileName, department: p.department, period: p.period, payload: p.payload, rowCount: p.rowCount });
      const id = String((res.data as { id?: string }).id ?? '');
      let note = '';
      if (id && p.file) {
        if (p.file.size > 4 * 1024 * 1024) note = 'Копия файла не сохранена: файл больше 4 МБ.';
        else {
          try {
            await api.post('/api/uploads/' + encodeURIComponent(id) + '/file', { fileName: p.fileName, base64: await fileToBase64(p.file) });
          } catch (cause) {
            note = 'Данные сохранены, копия файла — нет: ' + errorText(cause, 'ошибка хранилища.');
          }
        }
      }
      update(p.id, { status: 'saved', book: undefined, file: undefined, issues: note ? [...p.issues, note] : p.issues });
    } catch (cause) {
      update(p.id, { status: 'error', error: errorText(cause, 'Не удалось сохранить.') });
    }
  };
  const saveAll = async () => {
    for (const p of pending.filter(x => x.status === 'ready')) await save(p);
    await onChanged();
  };
  const edit = (p: Pending, patch: { department?: string; period?: string }) => {
    const next = { ...p, ...patch };
    if (p.kind === 'tkp') { update(p.id, applyTkp(next)); return; }
    if (!p.book) return;
    const mapping = next.mapping?.source === 'ai' ? next.mapping : next.department ? detectDepartmentMapping(p.book, next.department) : null;
    const prepared = applyMapping(next, p.book, mapping, next.aiNote);
    update(p.id, prepared);
    if (prepared.status === 'ai') void aiMap(prepared).then(r => update(p.id, r));
  };
  const remove = async (id: string) => {
    await api.delete('/api/uploads/' + encodeURIComponent(id));
    await onChanged();
  };
  const removeAlias = async (id: string) => {
    await api.delete('/api/aliases/' + encodeURIComponent(id));
    await onChanged();
  };
  const ready = pending.filter(p => p.status === 'ready').length;
  const uploadLabel = (u: UploadMeta) => (u.kind === 'department' ? `${u.department}, ${monthLabel(u.period)}` : u.kind === 'tkp' ? `сделка ${u.department}` : u.sourceUrl ? 'Google Таблица' : '—');

  return (
    <>
      <Heading eyebrow="ИСТОЧНИКИ ДАННЫХ" title="Загрузка файлов"
        text="Можно выбрать сразу несколько файлов. Тип определяется автоматически; новый файл того же типа (того же подразделения и месяца, той же сделки для ТКП) заменяет прежний." />
      <label
        className={'upload-drop' + (drag ? ' upload-drop-active' : '')}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
      >
        <Upload size={22} />
        <strong>Перетащите файлы .xlsx / .xlsm сюда или нажмите, чтобы выбрать</strong>
        <small>Закрытые сделки по подразделениям · Расчёт ТКП · Номера заказов · Расценки · Выпуск СЗ · Выпуск сторонних цехов · Выпуск продукции (лист «Акты»)</small>
        <input type="file" accept=".xlsx,.xlsm" multiple hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      </label>

      <GoogleSheetsPanel sources={sources} onChanged={onChanged} />

      {pending.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div><h2>Новые файлы</h2><p>Проверьте распознавание и сохраните.</p></div>
            <button className="btn-primary" disabled={!ready} onClick={() => void saveAll()}>Сохранить готовые ({ready})</button>
          </div>
          {pending.map(p => (
            <div className="upload-card" key={p.id}>
              <div className="upload-card-head">
                <strong>{p.fileName}</strong>
                <span className={'status ' + (p.status === 'saved' ? 'status-ok' : p.status === 'error' ? 'status-danger' : p.status === 'ready' ? 'status-review' : 'status-prelim')}>
                  {p.status === 'reading' ? 'Читаем' : p.status === 'ai' ? 'ИИ подбирает колонки' : p.status === 'saving' ? 'Сохраняем'
                    : p.status === 'saved' ? 'Сохранён' : p.status === 'error' ? 'Ошибка' : p.status === 'needs_input' ? 'Нужны данные' : FILE_KIND_LABELS[p.kind]}
                </span>
                <button className="icon-btn" aria-label="Убрать из списка" onClick={() => setPending(list => list.filter(x => x.id !== p.id))}><X size={16} /></button>
              </div>
              <p>{p.error ? <span className="login-error">{p.error}</span> : p.summary}</p>
              {p.kind === 'department' && p.status !== 'saved' && (
                <div className="filters">
                  <label>Подразделение <input value={p.department} onChange={e => edit(p, { department: e.target.value })} /></label>
                  <label>Месяц <input type="month" value={p.period} onChange={e => edit(p, { period: e.target.value })} /></label>
                </div>
              )}
              {p.kind === 'tkp' && p.status !== 'saved' && (
                <div className="filters">
                  <label>Сделка Б24 <input inputMode="numeric" value={p.department} onChange={e => edit(p, { department: e.target.value.replace(/\D/g, '') })} /></label>
                </div>
              )}
              {p.aiNote && <p className="ai-note"><BrainCircuit size={15} /> {p.aiNote}</p>}
              {p.issues.map(i => <p key={i} className="login-error"><AlertTriangle size={14} /> {i}</p>)}
              {p.preview && p.preview.length > 0 && (
                <div className="table-wrap"><table>
                  <thead><tr><th>Б24</th><th>Заказчик / товар</th><th>Сумма договора</th><th>Баки</th><th>Строк</th><th>Бюджет</th><th>Факт</th></tr></thead>
                  <tbody>{p.preview.map(d => { const t = blockTotals(d.lines); return (
                    <tr key={d.sourceRow}><td>{d.b24 ?? '—'}</td><td>{d.customer}<small>{d.product}</small></td><td>{money(d.contractRub)}</td>
                      <td><small>{d.tanks.join('; ') || '—'}</small></td><td>{d.lines.length}</td><td>{money(t.budget)}</td><td>{money(t.fact)}</td></tr>
                  ); })}</tbody>
                </table></div>
              )}
              {p.kind === 'tkp' && p.tkp && p.tkp.positions.length > 0 && (
                <div className="table-wrap"><table>
                  <thead><tr><th>Позиция</th><th>Вес МК план, кг</th><th>Себестоимость МК план</th><th>Стоимость МК план</th><th>Стоимость МК факт</th></tr></thead>
                  <tbody>{p.tkp.positions.map(x => (
                    <tr key={x.sourceRow}><td>{x.name}</td><td>{kg(x.weightPlanKg)}</td><td>{money(x.mkCostPlan)}</td><td>{money(x.mkValuePlan)}</td><td>{money(x.mkValueFact)}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
              {p.status === 'ready' && <button className="btn-secondary" onClick={() => void save(p).then(onChanged)}>Сохранить</button>}
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading"><div><h2>Загруженные данные</h2><p>Текущие версии, по которым считаются сделки.</p></div></div>
        {uploads.length === 0 ? <p>Пока ничего не загружено.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Тип</th><th>Файл</th><th>Подразделение / месяц / сделка</th><th>Строк</th><th>Загрузил</th><th></th></tr></thead>
            <tbody>{[...uploads].sort((a, b) => a.kind.localeCompare(b.kind) || a.period.localeCompare(b.period) || a.department.localeCompare(b.department)).map(u => (
              <tr key={u.id}>
                <td>{FILE_KIND_LABELS[u.kind]}</td><td>{u.fileName}</td>
                <td>{uploadLabel(u)}</td>
                <td>{u.rowCount ?? '—'}</td>
                <td>{u.uploadedBy}<small>{new Date(u.uploadedAt).toLocaleString('ru-RU')}</small></td>
                <td><button className="icon-btn" aria-label={'Удалить ' + u.fileName} onClick={() => void remove(u.id)}><Trash2 size={16} /></button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {aliases.length > 0 && (
        <section className="panel">
          <div className="panel-heading"><div><h2>Подтверждённые сопоставления</h2><p>Применяются при каждом расчёте.</p></div></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Тип</th><th>Из файла</th><th>Сопоставлено с</th><th>Подтвердил</th><th></th></tr></thead>
            <tbody>{aliases.map(a => (
              <tr key={a.id}><td>{a.kind === 'deal' ? 'Сделка → Б24' : 'Цех → расценка'}</td><td>{a.from}</td><td>{String(a.to)}</td><td>{a.confirmedBy}</td>
                <td><button className="icon-btn" aria-label="Удалить сопоставление" onClick={() => void removeAlias(a.id)}><Trash2 size={16} /></button></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

/* ───────────────────────── AI matching ───────────────────────── */

type Proposal = { item: string; candidate: string | null; confidence: number; reason: string; accept: boolean };

function MatchReview({ kind, items, candidates, toAlias, onSaved, title }: {
  kind: 'contractor' | 'deal';
  items: string[];
  candidates: string[];
  toAlias: (item: string, candidate: string) => { from: string; to: string | number } | null;
  onSaved: () => Promise<void>;
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const run = async () => {
    setBusy(true);
    setMessage('');
    try {
      const res = await api.post('/api/ai/match', { kind, items: items.slice(0, 40), candidates });
      const matches = (res.data as { matches?: Omit<Proposal, 'accept'>[] }).matches ?? [];
      setProposals(matches.map(m => ({ ...m, candidate: m.candidate || null, accept: Boolean(m.candidate) && m.confidence >= 0.7 })));
      if (!matches.some(m => m.candidate)) setMessage('ИИ не нашёл уверенных совпадений.');
    } catch (cause) {
      setMessage(errorText(cause, 'ИИ недоступен.'));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    const aliases = proposals.filter(p => p.accept && p.candidate)
      .map(p => toAlias(p.item, p.candidate!)).filter((x): x is { from: string; to: string | number } => Boolean(x))
      .map(a => ({ kind, ...a }));
    if (!aliases.length) return;
    setBusy(true);
    try {
      await api.post('/api/aliases', { aliases });
      setProposals([]);
      setMessage(`Сохранено сопоставлений: ${aliases.length}.`);
      await onSaved();
    } catch (cause) {
      setMessage(errorText(cause, 'Не удалось сохранить.'));
    } finally {
      setBusy(false);
    }
  };
  if (!items.length) return null;
  return (
    <section className="panel ai-panel">
      <div className="panel-heading">
        <div><h2>{title}</h2><p>{items.length} без точного совпадения. ИИ предложит пары — применяются только отмеченные вами.</p></div>
        <button className="btn-primary" disabled={busy || !candidates.length} onClick={() => void run()}>
          <BrainCircuit size={16} /> {busy ? 'ИИ думает…' : 'Подобрать с ИИ'}
        </button>
      </div>
      {!candidates.length && <p>Нет списка для сопоставления: загрузите {kind === 'deal' ? '«Номера заказов»' : '«Расценки»'}.</p>}
      {message && <p role="status">{message}</p>}
      {proposals.length > 0 && (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th></th><th>Из файла</th><th>Предложение ИИ</th><th>Уверенность</th><th>Почему</th></tr></thead>
            <tbody>{proposals.map((p, i) => (
              <tr key={p.item}>
                <td><input type="checkbox" aria-label={'Принять ' + p.item} disabled={!p.candidate} checked={p.accept}
                  onChange={e => setProposals(list => list.map((x, j) => (j === i ? { ...x, accept: e.target.checked } : x)))} /></td>
                <td>{p.item}</td><td>{p.candidate ?? '— нет совпадения'}</td><td>{Math.round(p.confidence * 100)}%</td><td>{p.reason}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <button className="btn-primary" disabled={busy || !proposals.some(p => p.accept)} onClick={() => void confirm()}>
            <CheckCircle2 size={16} /> Подтвердить отмеченные
          </button>
        </>
      )}
    </section>
  );
}

/* ───────────────────────── Register (like sheet «Сделки») ───────────────────────── */

function IssueList({ issues }: { issues: DealIssue[] }) {
  if (!issues.length) return null;
  return <div className="checklist">{issues.map((i, k) => (
    <div key={k} className={i.level === 'blocker' ? 'login-error' : ''}>
      {i.level === 'info' ? <Info size={14} /> : <AlertTriangle size={14} />} {i.message}
    </div>
  ))}</div>;
}

function MkLines({ lines }: { lines: MkLine[] }) {
  if (!lines.length) return <p>Выпуска МК по шифру нет.</p>;
  return (
    <div className="table-wrap"><table className="mk-lines">
      <thead><tr><th>Источник</th><th>Месяц / цех</th><th>Заказ</th><th>Выпуск</th><th>Списание (с НДС)</th><th>Руб/кг</th><th>Работа</th><th>Итого</th></tr></thead>
      <tbody>{lines.map((l, k) => (
        <tr key={k}>
          <td>{l.source === 'own' ? 'Завод (СЗ)' : 'Сторонний'}</td><td>{l.source === 'own' ? monthLabel(l.month) : l.workshop}</td><td><small>{l.order}</small></td>
          <td>{tonnes(l.outputT)}</td><td>{money(l.metalRub)}</td>
          <td>{l.rate === null ? (l.source === 'own' ? <span className="login-error">нет</span> : '—') : num1(l.rate)}</td>
          <td>{money(l.workRub)}</td><td>{money(l.totalRub)}{l.note && <small>{l.note}</small>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function MkSummary({ mk }: { mk: OppMk }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th></th><th>Всего затраты</th><th>Списание (металл, с НДС)</th><th>Работа / без сырья</th><th>Частичное переразмещение</th><th>Выпуск, кг</th></tr></thead>
      <tbody>
        <tr><td>Завод (СЗ)</td><td>{money(mk.own.totalRub)}</td><td>{money(mk.own.writeOffRub)}</td><td>{money(mk.own.workRub)}</td><td>—</td><td>{kg(mk.own.outputKg)}</td></tr>
        <tr><td>Сторонние</td><td>{money(mk.ext.totalRub)}</td><td>{money(mk.ext.writeOffRub)}</td><td>{money(mk.ext.workRub)}</td><td>{money(mk.ext.reallocationRub)}</td><td>{kg(mk.ext.outputKg)}</td></tr>
        <tr className="total-row"><td>Себестоимость МК</td><td>{money(mk.costRub)}</td><td>{money(mk.own.writeOffRub + mk.ext.writeOffRub)}</td><td>{money(mk.own.workRub + mk.ext.workRub)}</td><td>{money(mk.ext.reallocationRub)}</td><td>{kg(mk.outputKg)}</td></tr>
      </tbody>
    </table></div>
  );
}

function RowDetails({ r }: { r: OppRow }) {
  const src = useSource();
  const blockLines = BLOCKS.flatMap(b => r.blocks[b.key].lines.map(l => ({ ...l, label: b.label })))
    .concat(r.omts.lines.map(l => ({ ...l, label: 'ОМТС (справочно)' })));
  return (
    <div className="row-details">
      <p><b>Баки ({r.tanks.length}):</b> {r.tanks.join('; ') || '—'}</p>
      {r.share < 1 && <p><small>Доля строки в общих суммах сделки: {pct(r.share)} (по стоимости МК из ТКП, иначе по выпуску или числу баков).</small></p>}
      <h3>План МК из «Расчёта ТКП»</h3>
      {r.tkp.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Позиция ТКП</th><th>Вес план, кг</th><th>Себестоимость МК план</th><th>Стоимость МК план</th><th>Стоимость МК факт</th></tr></thead>
          <tbody>{r.tkp.map(p => (
            <tr key={p.sourceRow} {...src(tkpSrc(r.b24))}><td>{p.name}</td><td>{kg(p.weightPlanKg)}</td><td>{money(p.mkCostPlan)}</td><td>{money(p.mkValuePlan)}</td><td>{money(p.mkValueFact)}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p>Нет позиций ТКП для этого шифра.</p>}
      <h3>Блоки подразделений</h3>
      {blockLines.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Блок</th><th>Строка файла</th><th>Бак</th><th>Наименование</th><th>Поставщик</th><th>Выручка (бюджет)</th><th>Себестоимость (факт)</th><th>Доля</th><th>Источник</th></tr></thead>
          <tbody>{blockLines.map((l, k) => (
            <tr key={k} {...src({ kind: 'department', fileName: l.fileName })}>
              <td>{l.label}</td><td>{l.block}</td><td><small>{l.tank || '—'}</small></td><td>{l.name || '—'}{l.note && <small>{l.note}</small>}</td><td>{l.supplier || '—'}</td>
              <td>{money(l.budgetRub === null ? null : l.budgetRub * l.share)}</td><td>{money(l.factRub === null ? null : l.factRub * l.share)}</td>
              <td>{l.by === 'tank' ? 'по баку' : pct(l.share)}</td><td><small>{l.fileName}, стр. {l.sourceRow}</small></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p>Строк блоков нет.</p>}
      <h3>Производство МК</h3>
      {r.mk ? <MkSummary mk={r.mk} /> : <p>Выпуска МК по шифру нет.</p>}
      {r.mk && r.mk.reallocations.length > 0 && (
        <p><small>Переразмещения из Комплектации, учтённые как работа подрядчиков: {r.mk.reallocations.map(x => `${x.name || '—'} / ${x.supplier || '—'} — ${money((x.factRub ?? 0) * x.share)}`).join('; ')}.</small></p>
      )}
      {r.mk && <details><summary>Строки отчётов о выпуске ({r.mk.lines.length})</summary><MkLines lines={r.mk.lines} /></details>}
      <IssueList issues={r.issues} />
    </div>
  );
}

/** Таблица реестра для выгрузки: те же колонки и числа, что на экране. */
function registerMatrix(rows: OppRow[]): Matrix {
  const head = ['Месяц', 'Шифр ОПП', 'Заказчик', 'Изделие (баки)', 'Б24', 'Выручка план', 'Выручка факт', 'Полная с-ть план', 'Полная с-ть факт',
    'Маржа план', 'Маржа факт', 'Вес план, кг', 'Вес факт, кг', 'Стоимость МК план', 'Стоимость МК факт', 'Цена за 1 кг', 'Себестоимость МК план',
    'Себестоимость МК факт', 'Затраты завода', 'Металл (завод)', 'Без сырья (завод)', 'Выпуск завода, кг', 'Затраты сторонние', 'Металл (сторонние)',
    'Работа сторонних по расценке', 'Частичное переразмещение (услуги)', 'Выпуск сторонних, кг', 'Маржа МК план', 'Маржа МК факт',
    ...BLOCKS.flatMap(b => [`${b.label} выручка (бюджет)`, `${b.label} себестоимость (факт)`]), 'БГ/штрафы', 'Замечания'];
  return { head, rows: rows.map(r => [
    r.period, r.opp, r.customer, r.tanks.join('; '), r.b24, r.revenuePlan, r.revenueFact, r.costPlan, r.costFact, r.profitPlan, r.profitFact,
    r.weightPlanKg, r.weightFactKg, r.mkValuePlan, r.mkValueFact, r.priceKg, r.mkCostPlan, r.mk?.costRub ?? null,
    r.mk?.own.totalRub ?? null, r.mk?.own.writeOffRub ?? null, r.mk?.own.workRub ?? null, r.mk?.own.outputKg ?? null,
    r.mk?.ext.totalRub ?? null, r.mk?.ext.writeOffRub ?? null, r.mk?.ext.workRub ?? null, r.mk?.ext.reallocationRub ?? null, r.mk?.ext.outputKg ?? null,
    r.mkProfitPlan, r.mkProfitFact, ...BLOCKS.flatMap(b => [r.blocks[b.key].plan, r.blocks[b.key].fact]), r.finesRub,
    r.issues.map(i => i.message).join(' | '),
  ]), widths: [10, 9, 28, 40, 8] };
}

/** Чек-лист закрытия месяца: выбранный месяц или последний загруженный. */
function ClosePanel({ c, data, period }: { c: Consolidation; data: WorkspaceData; period: string | null }) {
  if (!period) return null;
  const items = closeChecklist(data, c, period);
  const problems = items.filter(i => i.state !== 'ok').length;
  return (
    <details className="panel">
      <summary><b>Закрытие месяца: {monthLabel(period)}</b> — {problems ? `требует внимания: ${problems}` : 'всё загружено'}</summary>
      <div className="checklist">{items.map(i => (
        <div key={i.label} className={i.state === 'missing' ? 'login-error' : ''}>
          {i.state === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} <b>{i.label}</b> — {i.detail}
        </div>
      ))}</div>
    </details>
  );
}

function SummaryTable({ title, lines }: { title: string; lines: SummaryLine[] }) {
  return (
    <div className="table-wrap"><table className="register-table">
      <thead><tr><th>{title}</th><th>Шифров</th><th>Выручка факт</th><th>Себестоимость факт</th><th>Маржа факт</th><th>Рент.</th><th>Вес факт, кг</th></tr></thead>
      <tbody>{lines.map(l => (
        <tr key={l.key}><td>{l.key}</td><td>{l.rows}</td><td>{money(l.revenueFact)}</td><td>{money(l.costFact)}</td>
          <td className={neg(l.profitFact)}>{money(l.profitFact)}</td><td className={neg(l.profitFact)}>{pct(l.margin)}</td><td>{kg(l.weightFactKg)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

/** Свод по месяцам и заказчикам (по строкам, которые сейчас видны в реестре). */
function SummaryPanel({ rows }: { rows: OppRow[] }) {
  const byMonth = useMemo(() => summarize(rows, r => r.period ?? '').sort((a, b) => a.key.localeCompare(b.key))
    .map(l => ({ ...l, key: l.key ? monthLabel(l.key) : 'Без месяца' })), [rows]);
  const byCustomer = useMemo(() => summarize(rows, r => customerKey(r.customer)).sort((a, b) => (b.revenueFact ?? 0) - (a.revenueFact ?? 0)), [rows]);
  if (!rows.length) return null;
  return (
    <details className="panel">
      <summary><b>Сводка по месяцам и заказчикам</b></summary>
      <SummaryTable title="Месяц" lines={byMonth} />
      <SummaryTable title="Заказчик" lines={byCustomer} />
    </details>
  );
}

function PF({ plan, fact, inverse, planSrc, factSrc }: { plan: number | null; fact: number | null; inverse?: boolean; planSrc?: SourceRef | null; factSrc?: SourceRef | null }) {
  const src = useSource();
  const d = delta(fact, plan);
  const bad = d !== null && (inverse ? d > 0 : d < 0);
  return <><td {...src(planSrc)}>{money(plan)}</td><td {...src(factSrc)}>{money(fact)}</td><td className={bad ? 'negative' : undefined}>{money(d)}</td></>;
}

/** Ссылки на файлы-источники цифр строки реестра. */
const tkpSrc = (b24: number | null): SourceRef | null => (b24 !== null ? { kind: 'tkp', b24 } : null);
const deptSrc = (lines: ReadonlyArray<{ fileName: string }>): SourceRef | null => (lines[0] ? { kind: 'department', fileName: lines[0].fileName } : null);

function RegisterPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
  const src = useSource();
  const [period, setPeriod] = useState('all');
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const visible = c.rows.filter(r => (period === 'all' || r.period === period)
    && (!onlyIssues || r.issues.some(i => i.level !== 'info'))
    && `${r.opp ?? ''} ${r.b24 ?? ''} ${r.customer} ${r.product} ${r.tanks.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const t = registerTotals(visible);
  const refCandidates = useMemo(() => {
    const byB24 = new Map<number, { client: string; tanks: string[] }>();
    for (const r of data.reference ?? []) {
      if (r.b24 === null) continue;
      const x = byB24.get(r.b24) ?? { client: r.client, tanks: [] };
      if (r.tankCode && x.tanks.length < 3) x.tanks.push(r.tankCode);
      byB24.set(r.b24, x);
    }
    return Array.from(byB24.entries()).map(([b24, x]) => `${b24} — ${x.client} — ${x.tanks.join(', ')}`);
  }, [data.reference]);
  const colSpan = 33 + BLOCKS.length * 2;

  return (
    <>
      <Heading eyebrow="РЕЕСТР СДЕЛОК" title="Сделки по шифрам ОПП"
        text="Как лист «Сделки»: строка — шифр для бухгалтерии (ОПП), т.е. тип баков сделки. Бюджеты и факт — из файлов подразделений, план МК — из «Расчёта ТКП», себестоимость МК — из выпуска и «Расценок»."
        actions={<>
          <button className="btn-secondary" disabled={!visible.length} onClick={() => void downloadXlsx(registerMatrix(visible), 'Сделки по ОПП', 'MONOLITH-Sdelki-po-OPP.xlsx')}><Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={!visible.length} onClick={() => downloadCsv(registerMatrix(visible), 'MONOLITH-Sdelki-po-OPP.csv')}><Download size={16} /> CSV</button>
        </>} />
      {!data.departments.length && <div className="bottom-note">Файлы подразделений ещё не загружены — откройте «Загрузка файлов».</div>}
      {c.missingBlocks.length > 0 && data.departments.length > 0 && (
        <div className="bottom-note">Нет файлов подразделений для блоков: {c.missingBlocks.join(', ')} — эти блоки показаны как «—».</div>
      )}
      <div className="kpi-grid">
        <div className="kpi-card"><span>Выручка факт</span><strong className="kpi-value">{money(t.revenueFact)}</strong><small>план {money(t.revenuePlan)}</small></div>
        <div className="kpi-card"><span>Полная себестоимость факт</span><strong className="kpi-value">{money(t.costFact)}</strong><small>план {money(t.costPlan)}</small></div>
        <div className="kpi-card"><span>Маржа факт</span><strong className={'kpi-value ' + (neg(t.profitFact) ?? '')}>{money(t.profitFact)}</strong><small>рентабельность {pct(ratio(t.profitFact, t.revenueFact))}</small></div>
        <div className="kpi-card"><span>Вес факт</span><strong className="kpi-value">{kg(t.weightFactKg)} кг</strong><small>план {kg(t.weightPlanKg)} кг</small></div>
      </div>
      <SummaryPanel rows={visible} />
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск: ОПП, Б24, заказчик, шифр бака" aria-label="Поиск" /></div>
        <select value={period} onChange={e => setPeriod(e.target.value)} aria-label="Месяц">
          <option value="all">Все месяцы</option>
          {c.periods.map(p => <option key={p} value={p}>{monthLabel(p)}</option>)}
        </select>
        <label className="check-label"><input type="checkbox" checked={onlyIssues} onChange={e => setOnlyIssues(e.target.checked)} /> Только с замечаниями</label>
        <span className="result-count">{visible.length} стр.</span>
      </div>
      <div className="table-wrap register-wrap"><table className="register-table">
        <thead>
          <tr>
            <th rowSpan={2}></th><th rowSpan={2}>Месяц</th><th rowSpan={2}>Шифр ОПП</th><th rowSpan={2}>Заказчик</th><th rowSpan={2}>Изделие (ШИФР баков)</th><th rowSpan={2}>Б24</th>
            <th colSpan={3}>Выручка</th><th colSpan={3}>Полная себестоимость</th><th colSpan={3}>Маржа</th><th rowSpan={2}>Рент.</th>
            <th colSpan={2}>Вес, кг</th><th colSpan={2}>Стоимость МК</th><th rowSpan={2}>Цена за 1 кг</th><th colSpan={3}>Себестоимость МК</th>
            <th colSpan={3}>Завод (СЗ)</th><th colSpan={3}>Сторонние</th><th rowSpan={2}>Маржа МК факт</th>
            {BLOCKS.map(b => <th key={b.key} colSpan={2}>{b.label}</th>)}<th rowSpan={2}>БГ / штрафы</th><th rowSpan={2}>Замеч.</th>
          </tr>
          <tr>
            <th>План</th><th>Факт</th><th>∆</th><th>План</th><th>Факт</th><th>∆</th><th>План</th><th>Факт</th><th>∆</th>
            <th>План</th><th>Факт</th><th>План</th><th>Факт</th><th>План</th><th>Факт</th><th>∆</th>
            <th>Всего</th><th>Металл</th><th>Выпуск, кг</th><th>Всего</th><th>Металл</th><th>Работа + перераз.</th>
            {BLOCKS.map(b => <Fragment key={b.key}><th title="Бюджет, руб с НДС">Выручка</th><th title="Сумма фактических затрат, руб с НДС">Себест.</th></Fragment>)}
          </tr>
        </thead>
        <tbody>
          <tr className="total-row">
            <td></td><td colSpan={5}>Итоги ({visible.length})</td>
            <PF plan={t.revenuePlan} fact={t.revenueFact} /><PF plan={t.costPlan} fact={t.costFact} inverse /><PF plan={t.profitPlan} fact={t.profitFact} />
            <td>{pct(ratio(t.profitFact, t.revenueFact))}</td><td>{kg(t.weightPlanKg)}</td><td>{kg(t.weightFactKg)}</td>
            <td>—</td><td>{money(t.mkValueFact)}</td><td>{num1(ratio(t.mkValueFact, t.weightFactKg))}</td>
            <PF plan={t.mkCostPlan} fact={t.mkCostFact} inverse />
            <td colSpan={6}></td><td>{money(delta(t.mkValueFact, t.mkCostFact))}</td>
            {BLOCKS.map(b => <Fragment key={b.key}><td>{money(t.blocks[b.key].plan)}</td><td>{money(t.blocks[b.key].fact)}</td></Fragment>)}
            <td>{money(t.fines)}</td><td></td>
          </tr>
          {visible.map(r => {
            const isOpen = open === r.key;
            const level = r.issues.some(i => i.level === 'blocker') ? 'status-danger' : r.issues.some(i => i.level === 'warning') ? 'status-review' : '';
            const toggle = () => setOpen(isOpen ? null : r.key);
            return (
              <Fragment key={r.key}>
                <tr tabIndex={0} role="button" aria-expanded={isOpen} onClick={toggle}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                  <td>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                  <td>{monthLabel(r.period)}</td><td><strong>{r.opp ?? '—'}</strong></td><td>{r.customer}</td>
                  <td className="tanks-cell"><small>{r.tanks.join('; ') || r.product}</small></td><td>{r.b24 ?? '—'}</td>
                  <PF plan={r.revenuePlan} fact={r.revenueFact} planSrc={tkpSrc(r.b24)} factSrc={tkpSrc(r.b24)} />
                  <PF plan={r.costPlan} fact={r.costFact} inverse planSrc={tkpSrc(r.b24)} factSrc={{ kind: 'prod_own' }} />
                  <PF plan={r.profitPlan} fact={r.profitFact} />
                  <td className={neg(r.profitFact)}>{pct(ratio(r.profitFact, r.revenueFact))}</td>
                  <td {...src(tkpSrc(r.b24))}>{kg(r.weightPlanKg)}</td><td {...src({ kind: 'prod_own' })}>{kg(r.weightFactKg)}</td>
                  <td {...src(tkpSrc(r.b24))}>{money(r.mkValuePlan)}</td><td {...src(tkpSrc(r.b24))}>{money(r.mkValueFact)}</td><td>{num1(r.priceKg)}</td>
                  <PF plan={r.mkCostPlan} fact={r.mk?.costRub ?? null} inverse planSrc={tkpSrc(r.b24)} factSrc={{ kind: 'prod_own' }} />
                  <td {...src({ kind: 'prod_own' })}>{money(r.mk?.own.totalRub)}</td><td {...src({ kind: 'prod_own' })}>{money(r.mk?.own.writeOffRub)}</td><td {...src({ kind: 'prod_own' })}>{kg(r.mk?.own.outputKg)}</td>
                  <td {...src({ kind: 'prod_ext' })}>{money(r.mk?.ext.totalRub)}</td><td {...src({ kind: 'prod_ext' })}>{money(r.mk?.ext.writeOffRub)}</td><td {...src(r.mk?.reallocations.length ? { kind: 'department', fileName: r.mk.reallocations[0].fileName } : { kind: 'prod_ext' })}>{money(r.mk ? r.mk.ext.workRub + r.mk.ext.reallocationRub : null)}</td>
                  <td className={neg(r.mkProfitFact)}>{money(r.mkProfitFact)}</td>
                  {BLOCKS.map(b => <Fragment key={b.key}><td {...src(deptSrc(r.blocks[b.key].lines))}>{money(r.blocks[b.key].plan)}</td><td {...src(deptSrc(r.blocks[b.key].lines))}>{money(r.blocks[b.key].fact)}</td></Fragment>)}
                  <td>{money(r.finesRub)}</td>
                  <td>{level ? <span className={'status ' + level}>{r.issues.filter(i => i.level !== 'info').length}</span> : '—'}</td>
                </tr>
                {isOpen && <tr className="details-row"><td colSpan={colSpan}><RowDetails r={r} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table></div>
      <p className="register-note"><small>Блоки подразделений: выручка = «Бюджет, руб с НДС», себестоимость = «Сумма фактических затрат, руб с НДС»; «Переразмещения (частичные)» Комплектации — затраты сторонних подрядчиков без расценки, они входят в себестоимость МК. Выручка = стоимость МК (ТКП) + бюджеты блоков. Полная себестоимость факт = себестоимость МК + факт блоков + БГ/штрафы.
        Себестоимость МК = списание «Сумма всего с НДС» + выпуск × коэффициент (завод — коэффициент месяца, подрядчик — расценка; без расценки — «Переразмещения (частичные)»).
        Суммы сделки без привязки к баку распределяются по шифрам пропорционально стоимости МК из ТКП. ОМТС — справочно, в себестоимость не входит.</small></p>
      <MatchReview kind="deal" title="Сделки без ссылки на Б24" items={c.unmatchedDealNames} candidates={refCandidates} onSaved={onChanged}
        toAlias={(item, candidate) => { const b24 = Number(/^\s*(\d+)/.exec(candidate)?.[1]); return b24 ? { from: dealNameKey(item), to: b24 } : null; }} />
      <ClosePanel c={c} data={data} period={period === 'all' ? c.periods[c.periods.length - 1] ?? null : period} />
    </>
  );
}

/* ───────────────────────── Production ───────────────────────── */

function ProductionPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
  const src = useSource();
  const [open, setOpen] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'finished' | 'all'>('finished');
  const rows: ProductionOpp[] = c.production.filter(p => (scope === 'all' || p.finished)
    && `${p.opp} ${p.b24 ?? ''} ${p.customer} ${p.tanks.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const sum = (f: (p: ProductionOpp) => number) => rows.reduce((s, p) => s + f(p), 0);
  const rateLabels = Object.values(data.rates?.contractorLabels ?? {});
  return (
    <>
      <Heading eyebrow="СЕБЕСТОИМОСТЬ МК" title="Производство МК"
        text="По каждому шифру ОПП: завод — списание «Сумма всего с НДС» + выпуск (т × 1000) × коэффициент месяца; сторонние — списание + выпуск × расценка подрядчика, без расценки — «Переразмещения (частичные)» из Комплектации." />
      <div className="kpi-grid">
        <div className="kpi-card"><span>Выпуск</span><strong className="kpi-value">{kg(sum(p => p.mk.outputKg))} кг</strong></div>
        <div className="kpi-card"><span>Завод (СЗ)</span><strong className="kpi-value">{money(sum(p => p.mk.own.totalRub))}</strong></div>
        <div className="kpi-card"><span>Сторонние</span><strong className="kpi-value">{money(sum(p => p.mk.ext.totalRub))}</strong></div>
        <div className="kpi-card"><span>Себестоимость МК</span><strong className="kpi-value">{money(sum(p => p.mk.costRub))}</strong></div>
      </div>
      {(c.globalIssues.length > 0 || c.unfinishedOpps.length > 0) && (
        <section className="panel"><div className="panel-heading"><div><h2>Замечания по расчёту</h2></div></div>
          <div className="checklist">{c.globalIssues.map((i, k) => (
            <div key={k} className={i.level === 'blocker' ? 'login-error' : ''}><AlertTriangle size={14} /> {i.message}</div>
          ))}</div>
          {c.unfinishedOpps.length > 0 && <p><Info size={14} /> Незавершённое производство — шифры из отчётов о выпуске, которых ещё нет в «Номерах заказов» (в сделки не входят): {c.unfinishedOpps.join(', ')}.</p>}
        </section>
      )}
      {c.missingContractors.length > 0 && (
        <details className="panel">
          <summary>Сопоставить названия цехов с «Расценками» (если подрядчик записан по-разному)</summary>
          <MatchReview kind="contractor" title="Цеха без точного совпадения с «Расценками»" items={c.missingContractors} candidates={rateLabels} onSaved={onChanged}
            toAlias={(item, candidate) => ({ from: normalizeName(item), to: normalizeName(candidate) })} />
        </details>
      )}
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск: ОПП, Б24, заказчик, бак" aria-label="Поиск" /></div>
        <select value={scope} onChange={e => setScope(e.target.value as 'finished' | 'all')} aria-label="Какие шифры показать">
          <option value="finished">Завершённое (есть в «Номерах заказов»)</option>
          <option value="all">Все шифры, включая незавершённое</option>
        </select>
        <span className="result-count">{rows.length} шифров</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th></th><th>ОПП</th><th>Б24 / заказчик</th><th>Завод, кг</th><th>Завод, ₽</th><th>Сторонние, кг</th><th>Сторонние, ₽</th><th>Себестоимость МК</th><th>₽/кг</th></tr></thead>
        <tbody>{rows.map(p => (
          <Fragment key={p.opp}>
            <tr tabIndex={0} role="button" aria-expanded={open === p.opp} onClick={() => setOpen(open === p.opp ? null : p.opp)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === p.opp ? null : p.opp); } }}>
              <td>{open === p.opp ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
              <td><strong>{p.opp}</strong>{!p.finished && <small>незавершённое</small>}</td>
              <td>{p.b24 ?? '—'}<small>{p.customer}</small></td>
              <td {...src({ kind: 'prod_own' })}>{kg(p.mk.own.outputKg)}</td><td {...src({ kind: 'prod_own' })}>{money(p.mk.own.totalRub)}</td><td {...src({ kind: 'prod_ext' })}>{kg(p.mk.ext.outputKg)}</td><td {...src({ kind: 'prod_ext' })}>{money(p.mk.ext.totalRub)}</td>
              <td>{money(p.mk.costRub)}</td><td>{num1(ratio(p.mk.costRub, p.mk.outputKg))}</td>
            </tr>
            {open === p.opp && <tr className="details-row"><td colSpan={9}>
              <p><b>Баки:</b> {p.tanks.join('; ') || '—'}</p>
              <MkSummary mk={p.mk} /><MkLines lines={p.mk.lines} />
            </td></tr>}
          </Fragment>
        ))}</tbody>
      </table></div>
    </>
  );
}

/* ───────────────────────── Assistant ───────────────────────── */

type Finding = { dealKey: string; severity: string; title: string; explanation: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string };

function AssistantPage({ c }: { c: Consolidation }) {
  const context = useMemo(() => buildAiContext(c), [c]);
  const deterministic = useMemo(() => c.rows.flatMap(r => r.issues.filter(i => i.level !== 'info').map(i => `${r.key}: ${i.message}`))
    .concat(c.globalIssues.map(i => i.message)), [c]);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const hasData = c.rows.length > 0 || c.production.length > 0;
  const nameOf = (key: string) => {
    const r = c.rows.find(x => x.key === key);
    return r ? `ОПП ${r.opp ?? '—'} · Б24 ${r.b24 ?? '—'} · ${r.customer}` : key;
  };

  const review = async () => {
    setReviewBusy(true);
    setReviewError('');
    try {
      const res = await api.post('/api/ai/review-deals', { summary: context, deterministic: deterministic.slice(0, 80).join('\n') });
      setFindings((res.data as { findings?: Finding[] }).findings ?? []);
    } catch (cause) {
      setReviewError(errorText(cause, 'ИИ недоступен.'));
    } finally {
      setReviewBusy(false);
    }
  };
  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    const next: ChatMessage[] = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setQuestion('');
    setChatBusy(true);
    try {
      const res = await api.post('/api/ai/chat', { messages: next, context });
      setMessages([...next, { role: 'assistant', content: String((res.data as { answer?: string }).answer ?? '') }]);
    } catch (cause) {
      setMessages([...next, { role: 'assistant', content: 'Ошибка: ' + errorText(cause, 'ИИ недоступен.') }]);
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <>
      <Heading eyebrow="ИИ-ПОМОЩНИК" title="Проверка и вопросы по данным"
        text="Сначала работают обязательные проверки системы, затем ИИ ищет аномалии и отвечает на вопросы. Числа считает система, решения принимает администратор." />
      <section className="panel">
        <div className="panel-heading">
          <div><h2>Проверка результатов</h2><p>Системой найдено замечаний: {deterministic.length}.</p></div>
          <button className="btn-primary" disabled={reviewBusy || !hasData} onClick={() => void review()}>
            <BrainCircuit size={16} /> {reviewBusy ? 'ИИ проверяет…' : 'Проверить с ИИ'}
          </button>
        </div>
        {!hasData && <p>Загрузите файлы, чтобы было что проверять.</p>}
        {reviewError && <p role="alert" className="login-error">{reviewError}</p>}
        {findings && (findings.length === 0 ? <p>ИИ не нашёл дополнительных аномалий.</p> : (
          <div className="issue-list">{findings.map((f, k) => (
            <div className="issue-card" key={k}>
              <div className={'issue-symbol ' + (f.severity === 'critical_conflict' ? 'danger' : f.severity === 'likely_error' ? 'warning' : 'info')}><AlertTriangle size={17} /></div>
              <div><strong>{f.title}</strong><p>{nameOf(f.dealKey)} — {f.explanation}</p></div>
              <span className={'status ' + (f.severity === 'critical_conflict' ? 'status-danger' : f.severity === 'likely_error' ? 'status-review' : 'status-prelim')}>
                {f.severity === 'critical_conflict' ? 'Критично' : f.severity === 'likely_error' ? 'Вероятная ошибка' : 'Обратить внимание'}
              </span>
            </div>
          ))}</div>
        ))}
        {findings && <small>Замечания ИИ — подсказки, а не подтверждённые факты.</small>}
      </section>
      <section className="panel ai-panel">
        <div className="panel-heading"><div><h2>Вопросы по данным</h2><p>Например: «Какие шифры убыточны в сентябре?», «Где факт себестоимости МК сильно выше плана?»</p></div></div>
        <div className="chat-log" aria-live="polite">
          {messages.map((m, k) => <div key={k} className={'chat-msg ' + m.role}>{m.content}</div>)}
          {chatBusy && <div className="chat-msg assistant">Думаю…</div>}
        </div>
        <div className="chat-input">
          <textarea rows={2} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ваш вопрос" aria-label="Вопрос"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
          <button className="btn-primary" disabled={chatBusy || !question.trim() || !hasData} onClick={() => void ask()} aria-label="Отправить"><Send size={16} /></button>
        </div>
        <small>ИИ видит только сводку реестра из загруженных файлов.</small>
      </section>
    </>
  );
}

/* ───────────────────────── Google Sheets sources ───────────────────────── */

const SHEET_KINDS: Array<{ kind: SheetSource['kind']; label: string }> = [
  { kind: 'reference', label: 'Номера заказов' },
  { kind: 'weights', label: 'Веса по шифрам ОПП' },
  { kind: 'acts', label: 'Выпуск продукции по цехам (лист «Акты», кг)' },
];

const base64ToBuffer = (b64: string): ArrayBuffer => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/** Reads «Номера заказов» / веса straight from a Google Sheet link and saves them like an uploaded file. */
function GoogleSheetsPanel({ sources, onChanged }: { sources: SheetSource[]; onChanged: () => Promise<void> }) {
  const [urls, setUrls] = useState<Record<string, string>>(() => Object.fromEntries(sources.map(s => [s.kind, s.url])));
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = async (kind: SheetSource['kind']) => {
    const url = (urls[kind] ?? '').trim();
    if (!url) return;
    setBusy(kind);
    setStatus(s => ({ ...s, [kind]: 'Скачиваем таблицу…' }));
    try {
      await api.post('/api/sources', { kind, url });
      if (kind === 'acts') {
        // Файл большой: лист «Акты» читает сервер и возвращает только свёртку.
        const res = await api.post('/api/gsheet/acts', { url });
        const acts = (res.data as { acts: ActsFile }).acts;
        const p = prepareActs(acts, { id: kind, fileName: acts.fileName, status: 'reading', kind, summary: '', issues: [], department: '', period: '' });
        if (p.status !== 'ready') throw new Error(p.error ?? 'Лист «Акты» пуст.');
        await api.post('/api/uploads', { kind, fileName: 'Google: ' + acts.fileName, department: '', period: '', payload: acts, rowCount: p.rowCount, sourceUrl: url });
        setStatus(s => ({ ...s, [kind]: 'Загружено: ' + p.summary }));
        await onChanged();
        return;
      }
      const res = await api.post('/api/gsheet', { url });
      const { fileName, base64 } = res.data as { fileName: string; base64: string };
      const book = await readWorkbookBuffer(base64ToBuffer(base64), fileName);
      const p = prepare(book, kind, { id: kind, fileName, status: 'reading', kind, summary: '', issues: [], department: '', period: '' });
      if (p.status !== 'ready' || !p.payload) throw new Error(p.error ?? 'Таблица не распознана как «' + SHEET_KINDS.find(k => k.kind === kind)!.label + '».');
      await api.post('/api/uploads', { kind, fileName: 'Google: ' + fileName, department: '', period: '', payload: p.payload, rowCount: p.rowCount, sourceUrl: url });
      setStatus(s => ({ ...s, [kind]: 'Загружено: ' + p.summary }));
      await onChanged();
    } catch (cause) {
      setStatus(s => ({ ...s, [kind]: 'Ошибка: ' + errorText(cause, 'не удалось загрузить таблицу.') }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2><Link2 size={16} /> Google Таблицы</h2>
        <p>Ссылка сохраняется; кнопка «Обновить» заново читает таблицу. Нужен доступ «Все, у кого есть ссылка» (просмотр).</p></div></div>
      {SHEET_KINDS.map(({ kind, label }) => {
        const saved = sources.find(s => s.kind === kind);
        return (
          <div className="filters" key={kind}>
            <label style={{ flex: 1 }}>{label}
              <input value={urls[kind] ?? ''} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={e => setUrls(u => ({ ...u, [kind]: e.target.value }))} />
            </label>
            <button className="btn-secondary" disabled={busy !== null || !(urls[kind] ?? '').trim()} onClick={() => void load(kind)}>
              <RefreshCw size={15} /> {busy === kind ? 'Загружаем…' : saved?.url ? 'Обновить' : 'Загрузить'}
            </button>
            {status[kind] && <small>{status[kind]}</small>}
            {!status[kind] && saved?.updatedAt ? <small>ссылка сохранена {new Date(saved.updatedAt).toLocaleString('ru-RU')}</small> : null}
          </div>
        );
      })}
    </section>
  );
}

/* ───────────────────────── Prices for revenue ───────────────────────── */

const weightSourceLabel = (r: PriceRow) => (r.weightSource === 'weights' ? 'файл весов' : r.weightSource === 'tkp' ? 'ТКП' : r.weightSource === 'output' ? 'выпуск (больше плана)' : '');

/** Таблица цен для выгрузки. */
function pricesMatrix(rows: PriceRow[]): Matrix {
  return {
    head: ['Шифр ОПП', 'Заказчик', 'РВС', 'Б24', 'Стоимость МК, ₽', 'Вес в расчёте, т', 'Источник веса', 'Плановый вес, т', 'Выпуск, т', 'Цена, ₽/т', 'Замечание'],
    rows: rows.map(r => [r.opp, r.customer, r.tanks.join('; '), r.b24, r.mkValue, r.weightKg === null ? null : r.weightKg / 1000,
      weightSourceLabel(r), r.planWeightKg === null ? null : r.planWeightKg / 1000, r.outputKg === null ? null : r.outputKg / 1000, r.pricePerT, r.issue]),
    widths: [10, 30, 45, 8, 16, 12, 14, 12, 12, 14, 50],
  };
}

function PricesPage({ data, weights }: { data: WorkspaceData; weights: WeightsFile | null }) {
  const src = useSource();
  const [search, setSearch] = useState('');
  const all = useMemo(() => revenuePrices(data.tkp, data.reference ?? [], weights, outputKgByOpp([...(data.prodOwn ?? []), ...(data.prodExt ?? [])])), [data, weights]);
  const rows = all.filter(r => `${r.opp ?? ''} ${r.b24 ?? ''} ${r.customer} ${r.tanks.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const value = rows.reduce((s, r) => s + (r.mkValue ?? 0), 0);
  const weightKg = rows.reduce((s, r) => s + (r.weightKg ?? 0), 0);
  const tonne = (kgValue: number | null) => (kgValue === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(kgValue / 1000));
  return (
    <>
      <Heading eyebrow="ВЫРУЧКА МК" title="Расчёт цен для выручки"
        text="Цена за тонну = стоимость МК из «Расчёта ТКП» / вес. Вес берётся из файла весов (или Google Таблицы весов) по шифру ОПП, если шифра там нет — плановый вес из ТКП. Если общий выпуск по шифру больше планового веса — берётся вес выпуска. Позиции ТКП сопоставляются с шифрами через «Номера заказов»."
        actions={<>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => void downloadXlsx(pricesMatrix(rows), 'Цены для выручки', 'MONOLITH-Ceny-dlya-vyruchki.xlsx')}><Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => downloadCsv(pricesMatrix(rows), 'MONOLITH-Ceny-dlya-vyruchki.csv')}><Download size={16} /> CSV</button>
        </>} />
      {!data.tkp.length && <div className="bottom-note">Загрузите файлы «Расчёт ТКП» — откройте «Загрузка файлов».</div>}
      {!data.reference && <div className="bottom-note">Не загружены «Номера заказов»: позиции ТКП нельзя сопоставить с шифрами ОПП.</div>}
      {!weights && data.tkp.length > 0 && <div className="bottom-note">Файл весов не загружен — для всех шифров используется плановый вес из ТКП.</div>}
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск: ОПП, Б24, заказчик, РВС" aria-label="Поиск" /></div>
        <span className="result-count">{rows.length} шифров</span>
      </div>
      <div className="table-wrap"><table className="register-table">
        <thead><tr><th>Шифр ОПП</th><th>Заказчик</th><th>РВС</th><th>Б24</th><th>Стоимость МК, ₽</th><th>Вес, т</th><th>Цена, ₽/т</th></tr></thead>
        <tbody>
          <tr className="total-row"><td colSpan={4}>Итого</td><td>{money(value)}</td><td>{tonne(weightKg)}</td><td>{money(weightKg ? value / (weightKg / 1000) : null)}</td></tr>
          {rows.map(r => (
            <tr key={r.key}>
              <td><strong>{r.opp ?? '—'}</strong></td><td>{r.customer || '—'}</td>
              <td className="tanks-cell"><small>{r.tanks.join('; ')}</small>{r.issue && <small className="login-error">{r.issue}</small>}</td>
              <td>{r.b24 ?? '—'}</td><td {...src(tkpSrc(r.b24))}>{money(r.mkValue)}</td>
              <td {...src(r.weightSource === 'weights' ? { kind: 'weights' } : r.weightSource === 'output' ? { kind: 'prod_own' } : tkpSrc(r.b24))}>{tonne(r.weightKg)}<small>{weightSourceLabel(r)}{r.weightSource === 'output' && r.planWeightKg !== null ? ` · план ${tonne(r.planWeightKg)} т` : ''}</small></td>
              <td {...src(tkpSrc(r.b24))}><strong>{money(r.pricePerT)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  );
}

/* ───────────────────────── Financial result by output ───────────────────────── */

const t3 = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n));

function outputMatrix(rows: OutputRow[]): Matrix {
  return {
    head: ['Месяц', 'Шифр ОПП', 'Заказчик', 'РВС', 'Выпуск, т', 'Цена, ₽/т', 'Выручка по выпуску, ₽', 'Списание металла, т',
      'Списание металла (сумма с НДС), ₽', 'Коэффициент СЗ, ₽/кг', 'Переработка (без металла), ₽', 'Финрез, ₽', 'Рентабельность', 'Замечание'],
    rows: rows.map(r => [r.month, r.opp, r.customer, r.tanks.join('; '), r.outputT, r.pricePerT, r.revenue, r.metalT, r.writeOffRub,
      r.coef, r.processingRub, r.result, r.margin, r.issue]),
    widths: [10, 9, 28, 40, 10, 12, 16, 12, 18, 10, 16, 16, 10, 40],
  };
}

function OutputTotalsRow({ label, rows }: { label: string; rows: OutputRow[] }) {
  const t = outputTotals(rows);
  return (
    <tr className="total-row">
      <td colSpan={4}>{label}{t.incomplete ? <small>не рассчитано строк: {t.incomplete}</small> : null}</td>
      <td>{t3(t.outputT)}</td><td>{money(t.revenue !== null && t.outputT ? t.revenue / t.outputT : null)}</td><td>{money(t.revenue)}</td>
      <td>{t3(t.metalT)}</td><td>{money(t.writeOffRub)}</td><td></td><td>{money(t.processingRub)}</td>
      <td className={neg(t.result)}>{money(t.result)}</td><td className={neg(t.result)}>{pct(t.margin)}</td>
    </tr>
  );
}

/** Финрез по выпуску: по общему выпуску по цехам («Выпуск продукции», лист «Акты»), а пока он не загружен — по «Выпуску СЗ». */
function OutputPage({ data, weights, acts }: { data: WorkspaceData; weights: WeightsFile | null; acts: ActsFile | null }) {
  return acts ? <WorkshopOutputPage data={data} weights={weights} acts={acts} /> : <OwnOutputPage data={data} weights={weights} />;
}

const tByGroup = (g: WorkshopGroup) => (g === 'own' ? 0 : g === 'ext_our_metal' ? 1 : 2);

function workshopMatrix(rows: WorkshopRow[]): Matrix {
  return {
    head: ['Месяц', 'Юр лицо', 'Группа', 'Цех', 'Шифр ОПП', 'Б24', 'Заказчик', 'Выпуск брутто, т', 'Цена, ₽/т', 'Выручка по выпуску, ₽',
      'Металл, ₽ с НДС', 'Металл — оценка', 'Коэф./расценка, ₽/кг', 'Переработка, ₽', 'Финрез, ₽', 'Рентабельность', 'Замечание'],
    rows: rows.map(r => [r.month, r.legal, WORKSHOP_GROUP_LABELS[r.group], r.workshop, r.opp, r.b24, r.customer, r.outputT, r.pricePerT, r.revenue,
      r.metalRub, r.metalEstimated ? 'да' : '', r.rate, r.processingRub, r.result, r.margin, r.issue]),
    widths: [10, 16, 26, 22, 9, 8, 30, 12, 12, 16, 16, 8, 10, 16, 16, 10, 40],
  };
}

function WorkshopOutputPage({ data, weights, acts }: { data: WorkspaceData; weights: WeightsFile | null; acts: ActsFile }) {
  const src = useSource();
  const prices = useMemo(() => revenuePrices(data.tkp, data.reference ?? [], weights, outputKgByOpp([...(data.prodOwn ?? []), ...(data.prodExt ?? [])])), [data, weights]);
  const all = useMemo(() => outputByWorkshops(acts, data.prodOwn ?? [], data.prodExt ?? [], prices, data.rates, data.reference ?? [], data.contractorAliases),
    [acts, data, prices]);
  const months = acts.periods;
  const [month, setMonth] = useState('');
  const [group, setGroup] = useState<'all' | WorkshopGroup>('all');
  const [workshop, setWorkshop] = useState('');
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [search, setSearch] = useState('');
  const current = month || months[months.length - 1] || 'all';
  const inMonth = all.filter(r => (current === 'all' || r.month === current) && (group === 'all' || r.group === group));
  const workshops = Array.from(new Set(inMonth.map(r => r.workshop))).sort((a, b) => a.localeCompare(b, 'ru'));
  const rows = inMonth.filter(r => (!workshop || r.workshop === workshop) && (!onlyPriced || r.pricePerT !== null)
    && `${r.opp ?? ''} ${r.customer} ${r.workshop}`.toLowerCase().includes(search.toLowerCase()));
  const t = workshopTotals(rows);
  const byShop = new Map<string, WorkshopRow[]>();
  for (const r of rows) byShop.set(`${r.group}|${r.workshop}`, [...(byShop.get(`${r.group}|${r.workshop}`) ?? []), r]);
  const shops = Array.from(byShop.entries()).map(([k, list]) => ({ k, group: list[0].group, workshop: list[0].workshop, list, t: workshopTotals(list) }))
    .sort((a, b) => tByGroup(a.group) - tByGroup(b.group) || (b.t.outputT ?? 0) - (a.t.outputT ?? 0));
  const actsSrc: SourceRef = { kind: 'acts' };
  const totalCells = (x: ReturnType<typeof workshopTotals>) => (<>
    <td>{t3(x.outputT)}</td><td>{money(x.revenue)}</td><td>{money(x.metalRub)}</td><td>{money(x.processingRub)}</td>
    <td className={neg(x.result)}>{money(x.result)}</td><td className={neg(x.result)}>{pct(x.margin)}</td>
  </>);
  return (
    <>
      <Heading eyebrow="ФИНРЕЗ ПО ВЫПУСКУ" title="Финрез по выпуску по цехам"
        text="Выпуск — «Выпуск продукции», лист «Акты»: тоннаж брутто для выручки, кг → т. Выручка = выпуск × цена за тонну из «Расчёта цен для выручки». Завод: металл — «Сумма всего с НДС» из «Выпуска СЗ» (по шифру за месяц, распределена по цехам пропорционально выпуску), переработка = выпуск × коэффициент месяца. Сторонние из нашего металла: переработка = выпуск × расценка подрядчика, металл — оценка по «Выпуску сторонних цехов». Сторонние на своём металле — только выручка: их затраты в «Переразмещениях» Комплектации."
        actions={<>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => void downloadXlsx(workshopMatrix(rows), 'Финрез по цехам', 'MONOLITH-Finrez-po-cekham.xlsx')}><Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => downloadCsv(workshopMatrix(rows), 'MONOLITH-Finrez-po-cekham.csv')}><Download size={16} /> CSV</button>
        </>} />
      {!data.rates && <div className="bottom-note">Не загружены «Расценки»: переработка не рассчитывается.</div>}
      {!data.prodOwn?.length && <div className="bottom-note">Не загружен «Выпуск СЗ по месяцам»: металл завода не рассчитывается.</div>}
      <div className="kpi-grid">
        <div className="kpi-card"><span>Выпуск брутто</span><strong className="kpi-value">{t3(t.outputT)} т</strong></div>
        <div className="kpi-card"><span>Выручка по выпуску</span><strong className="kpi-value">{money(t.revenue)}</strong></div>
        <div className="kpi-card"><span>Металл + переработка</span><strong className="kpi-value">{money((t.metalRub ?? 0) + (t.processingRub ?? 0))}</strong></div>
        <div className="kpi-card"><span>Финрез</span><strong className={'kpi-value ' + (neg(t.result) ?? '')}>{money(t.result)}</strong><small>рентабельность {pct(t.margin)}</small></div>
      </div>
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск: ОПП, заказчик, цех" aria-label="Поиск" /></div>
        <select value={current} onChange={e => setMonth(e.target.value)} aria-label="Месяц выпуска">
          <option value="all">Все месяцы</option>
          {[...months].reverse().map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <select value={group} onChange={e => { setGroup(e.target.value as 'all' | WorkshopGroup); setWorkshop(''); }} aria-label="Группа цехов">
          <option value="all">Все цеха</option>
          {(Object.keys(WORKSHOP_GROUP_LABELS) as WorkshopGroup[]).map(g => <option key={g} value={g}>{WORKSHOP_GROUP_LABELS[g]}</option>)}
        </select>
        <select value={workshop} onChange={e => setWorkshop(e.target.value)} aria-label="Цех">
          <option value="">Любой цех</option>
          {workshops.map(w => <option key={w} value={w}>{w}</option>)}
        </select>
        <label className="check-label"><input type="checkbox" checked={onlyPriced} onChange={e => setOnlyPriced(e.target.checked)} /> Только шифры с ценой</label>
        <span className="result-count">{rows.length} стр.</span>
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h2>По цехам</h2><p>{current === 'all' ? 'Все месяцы' : monthLabel(current)}. Финрез и рентабельность — по строкам, где рассчитаны и выручка, и затраты.</p></div></div>
        <div className="table-wrap"><table className="register-table">
          <thead><tr><th>Группа</th><th>Цех</th><th>Выпуск, т</th><th>Выручка</th><th>Металл, ₽</th><th>Переработка</th><th>Финрез</th><th>Рент.</th></tr></thead>
          <tbody>
            <tr className="total-row"><td colSpan={2}>Итого{t.incomplete ? <small> не рассчитано строк: {t.incomplete}</small> : null}</td>{totalCells(t)}</tr>
            {shops.map(s => (
              <tr key={s.k} className="row-clickable" onClick={() => setWorkshop(s.workshop === workshop ? '' : s.workshop)}>
                <td><small>{WORKSHOP_GROUP_LABELS[s.group]}</small></td><td><strong>{s.workshop || '—'}</strong></td>{totalCells(s.t)}
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
      <div className="table-wrap register-wrap"><table className="register-table">
        <thead><tr>
          <th>Месяц</th><th>Цех</th><th>Шифр ОПП</th><th>Заказчик</th><th>Выпуск, т</th><th>Цена, ₽/т</th><th>Выручка</th>
          <th>Металл, ₽ с НДС</th><th>Коэф./расценка, ₽/кг</th><th>Переработка</th><th>Финрез</th><th>Рент.</th>
        </tr></thead>
        <tbody>
          {rows.slice(0, 1500).map(r => (
            <tr key={r.key}>
              <td>{monthLabel(r.month)}</td><td><small>{r.workshop}</small></td><td><strong>{r.opp ?? '—'}</strong></td>
              <td className="tanks-cell">{r.customer || '—'}{r.issue && <small className="login-error">{r.issue}</small>}</td>
              <td {...src(actsSrc)}>{t3(r.outputT)}</td><td {...src(tkpSrc(r.b24))}>{money(r.pricePerT)}</td><td {...src(tkpSrc(r.b24))}>{money(r.revenue)}</td>
              <td {...src(r.group === 'own' ? { kind: 'prod_own' } : { kind: 'prod_ext' })}>{money(r.metalRub)}{r.metalEstimated && r.metalRub !== null ? <small>оценка</small> : null}</td>
              <td {...src(r.rate !== null ? { kind: 'rates' } : null)}>{r.rate === null ? '—' : num1(r.rate)}</td><td {...src(r.rate !== null ? { kind: 'rates' } : null)}>{money(r.processingRub)}</td>
              <td className={neg(r.result)}>{money(r.result)}</td><td className={neg(r.result)}>{pct(r.margin)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {rows.length > 1500 && <p className="register-note"><small>Показаны первые 1500 строк; полностью — в выгрузке Excel.</small></p>}
      <p className="register-note"><small>Источник выпуска: {acts.fileName}, лист «{acts.sheet}», {acts.actRows} актов. Выпуск — «Тоннаж брутто (для выручки)». «Металл — оценка»: выпуск × средняя сумма списания на тонну по шифру из «Выпуска сторонних цехов».</small></p>
    </>
  );
}

/** Финрез по выпуску завода по месяцам (пока не загружен «Выпуск продукции»): цены из «Расчёта цен для выручки» × вес выпуска по шифрам. */
function OwnOutputPage({ data, weights }: { data: WorkspaceData; weights: WeightsFile | null }) {
  const src = useSource();
  const prices = useMemo(() => revenuePrices(data.tkp, data.reference ?? [], weights, outputKgByOpp([...(data.prodOwn ?? []), ...(data.prodExt ?? [])])), [data, weights]);
  const all = useMemo(() => outputFinres(data.prodOwn ?? [], prices, data.rates, data.reference ?? []), [data, prices]);
  const months = useMemo(() => Array.from(new Set(all.map(r => r.month).filter((m): m is string => m !== null))).sort(), [all]);
  const [month, setMonth] = useState<string>('');
  const [onlyPriced, setOnlyPriced] = useState(true);
  const [search, setSearch] = useState('');
  const current = month || months[months.length - 1] || 'all';
  const rows = all.filter(r => (current === 'all' || r.month === current) && (!onlyPriced || r.pricePerT !== null)
    && `${r.opp ?? ''} ${r.customer} ${r.tanks.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const byMonth = current === 'all' ? months.map(m => ({ m, list: rows.filter(r => r.month === m) })).filter(x => x.list.length) : [];
  const t = outputTotals(rows);
  return (
    <>
      <Heading eyebrow="ФИНРЕЗ ПО ВЫПУСКУ" title="Финрез по выпуску"
        text="Выручка по выпуску = выпуск завода за месяц, т × цена за тонну из «Расчёта цен для выручки». Списание металла — вес и «Сумма всего с НДС» из отчёта о выпуске. Переработка (затраты без металла) = выпуск × 1000 × коэффициент месяца из «Расценок»."
        actions={<>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => void downloadXlsx(outputMatrix(rows), 'Финрез по выпуску', 'MONOLITH-Finrez-po-vypusku.xlsx')}><Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => downloadCsv(outputMatrix(rows), 'MONOLITH-Finrez-po-vypusku.csv')}><Download size={16} /> CSV</button>
        </>} />
      {!data.prodOwn?.length && <div className="bottom-note">Загрузите «Выпуск СЗ по месяцам».</div>}
      {!data.rates && <div className="bottom-note">Не загружены «Расценки»: переработка не рассчитывается.</div>}
      {!data.tkp.length && <div className="bottom-note">Нет «Расчётов ТКП»: цены за тонну неизвестны, выручка не рассчитывается.</div>}
      <div className="kpi-grid">
        <div className="kpi-card"><span>Выпуск</span><strong className="kpi-value">{t3(t.outputT)} т</strong></div>
        <div className="kpi-card"><span>Выручка по выпуску</span><strong className="kpi-value">{money(t.revenue)}</strong></div>
        <div className="kpi-card"><span>Металл + переработка</span><strong className="kpi-value">{money((t.writeOffRub ?? 0) + (t.processingRub ?? 0))}</strong></div>
        <div className="kpi-card"><span>Финрез</span><strong className={'kpi-value ' + (neg(t.result) ?? '')}>{money(t.result)}</strong><small>рентабельность {pct(t.margin)}</small></div>
      </div>
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск: ОПП, заказчик, РВС" aria-label="Поиск" /></div>
        <select value={current} onChange={e => setMonth(e.target.value)} aria-label="Месяц выпуска">
          <option value="all">Все месяцы</option>
          {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <label className="check-label"><input type="checkbox" checked={onlyPriced} onChange={e => setOnlyPriced(e.target.checked)} /> Только шифры с ценой</label>
        <span className="result-count">{rows.length} стр.</span>
      </div>
      <div className="table-wrap register-wrap"><table className="register-table">
        <thead><tr>
          <th>Месяц</th><th>Шифр ОПП</th><th>Заказчик</th><th>РВС</th><th>Выпуск, т</th><th>Цена, ₽/т</th><th>Выручка по выпуску</th>
          <th>Металл, т</th><th>Металл, ₽ с НДС</th><th>Коэф. СЗ, ₽/кг</th><th>Переработка</th><th>Финрез</th><th>Рент.</th>
        </tr></thead>
        <tbody>
          <OutputTotalsRow label={`Итого (${rows.length})`} rows={rows} />
          {(byMonth.length ? byMonth : [{ m: current, list: rows }]).map(({ m, list }) => (
            <Fragment key={m}>
              {byMonth.length > 0 && <OutputTotalsRow label={monthLabel(m)} rows={list} />}
              {list.map(r => (
                <tr key={r.key}>
                  <td>{monthLabel(r.month)}</td><td><strong>{r.opp ?? '—'}</strong></td><td>{r.customer || '—'}</td>
                  <td className="tanks-cell"><small>{r.tanks.join('; ')}</small>{r.issue && <small className="login-error">{r.issue}</small>}</td>
                  <td {...src({ kind: 'prod_own' })}>{t3(r.outputT)}</td><td {...src(tkpSrc(r.b24))}>{money(r.pricePerT)}</td><td {...src(tkpSrc(r.b24))}>{money(r.revenue)}</td>
                  <td {...src({ kind: 'prod_own' })}>{t3(r.metalT)}</td><td {...src({ kind: 'prod_own' })}>{money(r.writeOffRub)}</td><td {...src({ kind: 'rates' })}>{r.coef === null ? '—' : num1(r.coef)}</td><td {...src({ kind: 'rates' })}>{money(r.processingRub)}</td>
                  <td className={neg(r.result)}>{money(r.result)}</td><td className={neg(r.result)}>{pct(r.margin)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table></div>
      <p className="register-note"><small>Считается выпуск собственного завода (отчёт «Выпуск СЗ по месяцам»). Выпуск сторонних цехов в отчёте без месяца, поэтому сюда не входит. Строки без цены или коэффициента не попадают в финрез и рентабельность итога.</small></p>
      <ExternalReference data={data} prices={prices} />
    </>
  );
}

/** Справочно: выпуск сторонних цехов × цена за тонну. В финрез не входит — для финреза будет отдельный источник выпуска. */
function ExternalReference({ data, prices }: { data: WorkspaceData; prices: PriceRow[] }) {
  const src = useSource();
  const rows = useMemo(() => externalReference(data.prodExt ?? [], prices, data.reference ?? []), [data, prices]);
  if (!rows.length) return null;
  const totalT = rows.reduce((s, r) => s + r.outputT, 0);
  const priced = rows.filter(r => r.revenue !== null);
  const totalRev = priced.reduce((s, r) => s + (r.revenue as number), 0);
  const matrix: Matrix = {
    head: ['ОПП', 'Б24', 'Заказчик', 'Цеха', 'Выпуск, т', 'Цена, ₽/т', 'Выручка справочно, ₽'],
    rows: rows.map(r => [r.opp, r.b24, r.customer, r.workshops.join(', '), r.outputT, r.pricePerT, r.revenue]),
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div><h2>Справочно: выпуск сторонних цехов</h2><p>Не входит в итоги финреза.</p></div>
        <div>
          <button className="btn-secondary" onClick={() => void downloadXlsx(matrix, 'Сторонние справочно', 'MONOLITH-Vypusk-storonnie.xlsx')}><Download size={16} /> Excel</button>
        </div>
      </div>
      <p className="register-note"><small>Выручка = выпуск сторонних цехов (все месяцы) × цена за тонну. В итоги финреза не входит. Для финреза по сторонним будет отдельный источник выпуска (файл или Google-таблица).</small></p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>ОПП</th><th>Б24</th><th>Заказчик</th><th>Цеха</th><th>Выпуск, т</th><th>Цена, ₽/т</th><th>Выручка, ₽</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={String(r.opp) + r.customer}>
                <td>{r.opp ?? '—'}</td><td>{r.b24 ?? '—'}</td><td>{r.customer || '—'}</td><td>{r.workshops.join(', ') || '—'}</td>
                <td {...src({ kind: 'prod_ext' })}>{t3(r.outputT)}</td>
                <td {...src(tkpSrc(r.b24))}>{money(r.pricePerT)}</td>
                <td {...src(tkpSrc(r.b24))}>{money(r.revenue)}</td>
              </tr>
            ))}
            <tr className="total-row"><td colSpan={4}>Итого{priced.length < rows.length ? ` (без цены: ${rows.length - priced.length})` : ''}</td><td>{t3(totalT)}</td><td /><td>{money(totalRev)}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NoTkpPage({ data, c }: { data: WorkspaceData; c: Consolidation }) {
  const src = useSource();
  const closed = useMemo(() => new Set(c.deals.map(d => d.b24).filter((b): b is number => b !== null)), [c]);
  const rows = useMemo(() => dealsWithoutTkp(data.reference ?? [], data.tkp,
    outputKgByOpp([...(data.prodOwn ?? []), ...(data.prodExt ?? [])]), closed), [data, closed]);
  const name = (r: { client: string; product: string }) => [r.client, r.product].filter(Boolean).join(' — ');
  const matrix: Matrix = {
    head: ['Б24', 'Наименование сделки', 'РВС', 'ОПП', 'Выпуск, т', 'Закрыта в подразделениях', 'Лист справочника'],
    rows: rows.map(r => [r.b24, name(r), r.tanks.join(', '), r.opps.join(', '), r.outputT, r.closed ? 'да' : 'нет', r.sheets.join(', ')]),
  };
  return (
    <>
      <Heading eyebrow="КОНТРОЛЬ ИСТОЧНИКОВ" title="Сделки без ТКП"
        text="Сделки из «Номеров заказов», по которым есть выпуск МК или которые закрыты в файлах подразделений, но не загружен «Расчёт ТКП». Без ТКП нет цены за тонну, плана МК и выручки по выпуску."
        actions={<>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => void downloadXlsx(matrix, 'Сделки без ТКП', 'MONOLITH-Sdelki-bez-TKP.xlsx')}><Download size={16} /> Excel</button>
          <button className="btn-secondary" disabled={!rows.length} onClick={() => downloadCsv(matrix, 'MONOLITH-Sdelki-bez-TKP.csv')}><Download size={16} /> CSV</button>
        </>} />
      {!data.reference?.length && <div className="bottom-note">Загрузите «Номера заказов».</div>}
      <div className="kpi-grid">
        <div className="kpi-card"><span>Сделок без ТКП</span><strong className="kpi-value">{rows.length}</strong></div>
        <div className="kpi-card"><span>Из них закрыты</span><strong className="kpi-value">{rows.filter(r => r.closed).length}</strong></div>
        <div className="kpi-card"><span>Выпуск по ним</span><strong className="kpi-value">{t3(rows.reduce((s, r) => s + r.outputT, 0))} т</strong></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Б24</th><th>Наименование сделки</th><th>РВС</th><th>ОПП</th><th>Выпуск, т</th><th>Закрыта</th><th>Лист</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.b24} {...src({ kind: 'reference' })}>
                <td>{r.b24}</td><td>{name(r) || '—'}</td><td>{r.tanks.join(', ') || '—'}</td><td>{r.opps.join(', ') || '—'}</td>
                <td>{t3(r.outputT)}</td><td>{r.closed ? 'да' : '—'}</td><td>{r.sheets.join(', ')}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7}>Нет сделок без ТКП.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
