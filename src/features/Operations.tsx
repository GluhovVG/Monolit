import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@appdeploy/client';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, ChevronRight, Download, Info, Send, Trash2, Upload, X } from 'lucide-react';
import {
  BLOCKS, consolidate, dealNameKey, ratio, registerTotals,
  type Consolidation, type DealIssue, type OppMk, type OppRow, type ProductionOpp, type WorkspaceData,
} from '../domain/consolidate';
import type { MkLine } from '../domain/mk-production';
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
import { readWorkbook } from '../import/xlsx-reader';
import { buildAiContext, loadWorkspace, packProduction, packReference, type Alias, type UploadMeta } from './workspace';

export type OperationsPage = 'uploads' | 'register' | 'production' | 'assistant';

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
  const [state, setState] = useState<{ data: WorkspaceData; uploads: UploadMeta[]; aliases: Alias[] } | null>(null);
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
  if (page === 'uploads') return <UploadsPage uploads={state.uploads} aliases={state.aliases} onChanged={reload} />;
  if (page === 'register') return <RegisterPage c={consolidation} data={state.data} onChanged={reload} />;
  if (page === 'production') return <ProductionPage c={consolidation} data={state.data} onChanged={reload} />;
  return <AssistantPage c={consolidation} />;
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
  error?: string;
};

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

function UploadsPage({ uploads, aliases, onChanged }: { uploads: UploadMeta[]; aliases: Alias[]; onChanged: () => Promise<void> }) {
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
        const book = await readWorkbook(file);
        const kind = detectFileKind(book);
        let next = prepare(book, kind, { ...base, book, kind });
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
      await api.post('/api/uploads', { kind: p.kind, fileName: p.fileName, department: p.department, period: p.period, payload: p.payload, rowCount: p.rowCount });
      update(p.id, { status: 'saved', book: undefined });
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
  const uploadLabel = (u: UploadMeta) => (u.kind === 'department' ? `${u.department}, ${monthLabel(u.period)}` : u.kind === 'tkp' ? `сделка ${u.department}` : '—');

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
        <small>Закрытые сделки по подразделениям · Расчёт ТКП · Номера заказов · Расценки · Выпуск СЗ · Выпуск сторонних цехов</small>
        <input type="file" accept=".xlsx,.xlsm" multiple hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      </label>

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
          <td>{l.rate === null ? <span className="login-error">нет</span> : num1(l.rate)}</td>
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
            <tr key={p.sourceRow}><td>{p.name}</td><td>{kg(p.weightPlanKg)}</td><td>{money(p.mkCostPlan)}</td><td>{money(p.mkValuePlan)}</td><td>{money(p.mkValueFact)}</td></tr>
          ))}</tbody>
        </table></div>
      ) : <p>Нет позиций ТКП для этого шифра.</p>}
      <h3>Блоки подразделений</h3>
      {blockLines.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Блок</th><th>Строка файла</th><th>Бак</th><th>Наименование</th><th>Поставщик</th><th>Бюджет</th><th>Факт</th><th>Доля</th><th>Источник</th></tr></thead>
          <tbody>{blockLines.map((l, k) => (
            <tr key={k}>
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

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportRegister(rows: OppRow[]) {
  const head = ['Месяц', 'Шифр ОПП', 'Заказчик', 'Изделие (баки)', 'Б24', 'Выручка план', 'Выручка факт', 'Полная с-ть план', 'Полная с-ть факт',
    'Маржа план', 'Маржа факт', 'Вес план, кг', 'Вес факт, кг', 'Стоимость МК план', 'Стоимость МК факт', 'Цена за 1 кг', 'Себестоимость МК план',
    'Себестоимость МК факт', 'Затраты завода', 'Металл (завод)', 'Без сырья (завод)', 'Выпуск завода, кг', 'Затраты сторонние', 'Металл (сторонние)',
    'Работа сторонних по расценке', 'Частичное переразмещение (услуги)', 'Выпуск сторонних, кг', 'Маржа МК план', 'Маржа МК факт',
    ...BLOCKS.flatMap(b => [`${b.label} бюджет`, `${b.label} факт`]), 'БГ/штрафы', 'Замечания'];
  const lines = rows.map(r => [
    r.period, r.opp, r.customer, r.tanks.join('; '), r.b24, r.revenuePlan, r.revenueFact, r.costPlan, r.costFact, r.profitPlan, r.profitFact,
    r.weightPlanKg, r.weightFactKg, r.mkValuePlan, r.mkValueFact, r.priceKg, r.mkCostPlan, r.mk?.costRub ?? null,
    r.mk?.own.totalRub ?? null, r.mk?.own.writeOffRub ?? null, r.mk?.own.workRub ?? null, r.mk?.own.outputKg ?? null,
    r.mk?.ext.totalRub ?? null, r.mk?.ext.writeOffRub ?? null, r.mk?.ext.workRub ?? null, r.mk?.ext.reallocationRub ?? null, r.mk?.ext.outputKg ?? null,
    r.mkProfitPlan, r.mkProfitFact, ...BLOCKS.flatMap(b => [r.blocks[b.key].plan, r.blocks[b.key].fact]), r.finesRub,
    r.issues.map(i => i.message).join(' | '),
  ].map(csvCell).join(';'));
  const csv = '﻿' + [head.map(csvCell).join(';'), ...lines].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'MONOLITH-Sdelki-po-OPP.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PF({ plan, fact, inverse }: { plan: number | null; fact: number | null; inverse?: boolean }) {
  const d = delta(fact, plan);
  const bad = d !== null && (inverse ? d > 0 : d < 0);
  return <><td>{money(plan)}</td><td>{money(fact)}</td><td className={bad ? 'negative' : undefined}>{money(d)}</td></>;
}

function RegisterPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
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
        actions={<button className="btn-secondary" disabled={!visible.length} onClick={() => exportRegister(visible)}><Download size={16} /> CSV</button>} />
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
            {BLOCKS.map(b => <Fragment key={b.key}><th>Бюджет</th><th>Факт</th></Fragment>)}
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
                  <PF plan={r.revenuePlan} fact={r.revenueFact} /><PF plan={r.costPlan} fact={r.costFact} inverse /><PF plan={r.profitPlan} fact={r.profitFact} />
                  <td className={neg(r.profitFact)}>{pct(ratio(r.profitFact, r.revenueFact))}</td>
                  <td>{kg(r.weightPlanKg)}</td><td>{kg(r.weightFactKg)}</td>
                  <td>{money(r.mkValuePlan)}</td><td>{money(r.mkValueFact)}</td><td>{num1(r.priceKg)}</td>
                  <PF plan={r.mkCostPlan} fact={r.mk?.costRub ?? null} inverse />
                  <td>{money(r.mk?.own.totalRub)}</td><td>{money(r.mk?.own.writeOffRub)}</td><td>{kg(r.mk?.own.outputKg)}</td>
                  <td>{money(r.mk?.ext.totalRub)}</td><td>{money(r.mk?.ext.writeOffRub)}</td><td>{money(r.mk ? r.mk.ext.workRub + r.mk.ext.reallocationRub : null)}</td>
                  <td className={neg(r.mkProfitFact)}>{money(r.mkProfitFact)}</td>
                  {BLOCKS.map(b => <Fragment key={b.key}><td>{money(r.blocks[b.key].plan)}</td><td>{money(r.blocks[b.key].fact)}</td></Fragment>)}
                  <td>{money(r.finesRub)}</td>
                  <td>{level ? <span className={'status ' + level}>{r.issues.filter(i => i.level !== 'info').length}</span> : '—'}</td>
                </tr>
                {isOpen && <tr className="details-row"><td colSpan={colSpan}><RowDetails r={r} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table></div>
      <p className="register-note"><small>Выручка = стоимость МК (ТКП) + бюджеты блоков. Полная себестоимость факт = себестоимость МК + факт блоков + БГ/штрафы.
        Себестоимость МК = списание «Сумма всего с НДС» + выпуск × коэффициент (завод — коэффициент месяца, подрядчик — расценка; без расценки — «Переразмещения (частичные)»).
        Суммы сделки без привязки к баку распределяются по шифрам пропорционально стоимости МК из ТКП. ОМТС — справочно, в себестоимость не входит.</small></p>
      <MatchReview kind="deal" title="Сделки без ссылки на Б24" items={c.unmatchedDealNames} candidates={refCandidates} onSaved={onChanged}
        toAlias={(item, candidate) => { const b24 = Number(/^\s*(\d+)/.exec(candidate)?.[1]); return b24 ? { from: dealNameKey(item), to: b24 } : null; }} />
    </>
  );
}

/* ───────────────────────── Production ───────────────────────── */

function ProductionPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
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
      <MatchReview kind="contractor" title="Подрядчики без расценки" items={c.missingContractors} candidates={rateLabels} onSaved={onChanged}
        toAlias={(item, candidate) => ({ from: normalizeName(item), to: normalizeName(candidate) })} />
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
              <td>{kg(p.mk.own.outputKg)}</td><td>{money(p.mk.own.totalRub)}</td><td>{kg(p.mk.ext.outputKg)}</td><td>{money(p.mk.ext.totalRub)}</td>
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
