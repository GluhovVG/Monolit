import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '@appdeploy/client';
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, ChevronRight, Send, Trash2, Upload, X } from 'lucide-react';
import { consolidate, dealNameKey, type Consolidation, type ConsolidatedDeal, type WorkspaceData } from '../domain/consolidate';
import {
  departmentFromFileName, detectDepartmentMapping, extractDepartmentDeals, sanitizeMapping, sheetPreview,
  type DepartmentDeal, type DepartmentMapping,
} from '../import/department';
import { detectFileKind, FILE_KIND_LABELS, type FileKind } from '../import/detect';
import { parseProduction } from '../import/production';
import { parseRates } from '../import/rates';
import { parseReference } from '../import/reference';
import { normalizeName, type Workbook } from '../import/sheet';
import { readWorkbook } from '../import/xlsx-reader';
import { buildAiContext, loadWorkspace, packProduction, packReference, type Alias, type UploadMeta } from './workspace';

export type OperationsPage = 'uploads' | 'register' | 'production' | 'assistant';

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—'
    : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
const tonnes = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n) + ' т';
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return y && m ? new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1))) : period;
};

/** Upload-based financial workspace: files, consolidated deals, MK production, AI. */
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

function Heading({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
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
  department: string;
  period: string;
  mapping?: DepartmentMapping;
  aiNote?: string;
  preview?: DepartmentDeal[];
  error?: string;
};

function prepare(book: Workbook, kind: FileKind, base: Pending): Pending {
  if (kind === 'reference') {
    const rows = parseReference(book);
    const deals = new Set(rows.map(r => r.b24).filter(x => x !== null)).size;
    const opps = new Set(rows.map(r => r.opp).filter(x => x !== null)).size;
    return { ...base, status: rows.length ? 'ready' : 'error', payload: { rows: packReference(rows) }, rowCount: rows.length,
      summary: `${rows.length} строк: ${deals} сделок Б24, ${opps} шифров для бухгалтерии`, error: rows.length ? undefined : 'Не найдено строк с шифрами.' };
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
  if (kind === 'department') {
    const meta = departmentFromFileName(book.fileName, new Date().getFullYear());
    const next = { ...base, department: meta?.department ?? '', period: meta?.period ?? '' };
    return applyMapping(next, book, next.department ? detectDepartmentMapping(book, next.department) : null);
  }
  return { ...base, status: 'error', error: 'Тип файла не распознан. Файлы подразделений должны называться «Закрытые сделки <Подразделение> <месяц>».' };
}

function applyMapping(p: Pending, book: Workbook, mapping: DepartmentMapping | null, aiNote?: string): Pending {
  if (!p.department || !/^\d{4}-\d{2}$/.test(p.period)) {
    return { ...p, status: 'needs_input', mapping: mapping ?? undefined, summary: 'Укажите подразделение и месяц.' };
  }
  if (!mapping) return { ...p, status: 'ai', summary: 'Колонки не распознаны правилами — подбираем с помощью ИИ…' };
  const deals = extractDepartmentDeals(book, mapping);
  const payload = { department: p.department, period: p.period, fileName: p.fileName, mapping, deals };
  return {
    ...p, status: deals.length ? 'ready' : 'error', mapping, aiNote, preview: deals.slice(0, 5), payload, rowCount: deals.length,
    summary: `${p.department}, ${monthLabel(p.period)}: ${deals.length} сделок, из них с номером Б24: ${deals.filter(d => d.b24 !== null).length}`,
    error: deals.length ? undefined : 'Не найдено строк сделок с суммами.',
  };
}

async function aiMap(p: Pending): Promise<Pending> {
  if (!p.book) return p;
  try {
    const res = await api.post('/api/ai/map-columns', {
      fileName: p.fileName, department: p.department,
      sheets: p.book.sheets.slice(0, 4).map(s => ({ name: s.name, preview: sheetPreview(s) })),
    });
    const raw = (res.data as { mapping?: Partial<DepartmentMapping> & { explanation?: string; confidence?: number } }).mapping ?? {};
    const mapping = sanitizeMapping(p.book, raw, 'ai');
    if (!mapping) return { ...p, status: 'error', error: 'ИИ не нашёл колонки выручки и себестоимости. Пришлите пример файла — добавим правило.' };
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
    if (!p.book) return;
    const next = { ...p, ...patch };
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

  return (
    <>
      <Heading eyebrow="ИСТОЧНИКИ ДАННЫХ" title="Загрузка файлов"
        text="Можно выбрать сразу несколько файлов. Тип определяется автоматически; новый файл того же типа (или того же подразделения и месяца) заменяет прежний." />
      <label
        className={'upload-drop' + (drag ? ' upload-drop-active' : '')}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
      >
        <Upload size={22} />
        <strong>Перетащите файлы .xlsx сюда или нажмите, чтобы выбрать</strong>
        <small>Закрытые сделки по подразделениям · Номера заказов · Расценки · Выпуск СЗ · Выпуск сторонних цехов</small>
        <input type="file" accept=".xlsx" multiple hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
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
              {p.aiNote && <p className="ai-note"><BrainCircuit size={15} /> {p.aiNote}</p>}
              {p.issues.map(i => <p key={i} className="login-error"><AlertTriangle size={14} /> {i}</p>)}
              {p.preview && p.preview.length > 0 && (
                <div className="table-wrap"><table>
                  <thead><tr><th>Сделка</th><th>Б24</th><th>Выручка факт</th><th>Себест. факт</th><th>Прибыль факт</th><th>Выручка план</th></tr></thead>
                  <tbody>{p.preview.map(d => (
                    <tr key={d.sourceRow}><td>{d.name}</td><td>{d.b24 ?? '—'}</td><td>{money(d.revenueFact)}</td><td>{money(d.costFact)}</td><td>{money(d.profitFact)}</td><td>{money(d.revenuePlan)}</td></tr>
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
            <thead><tr><th>Тип</th><th>Файл</th><th>Подразделение / месяц</th><th>Строк</th><th>Загрузил</th><th></th></tr></thead>
            <tbody>{[...uploads].sort((a, b) => a.kind.localeCompare(b.kind) || a.period.localeCompare(b.period)).map(u => (
              <tr key={u.id}>
                <td>{FILE_KIND_LABELS[u.kind]}</td><td>{u.fileName}</td>
                <td>{u.kind === 'department' ? `${u.department}, ${monthLabel(u.period)}` : '—'}</td>
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

/* ───────────────────────── Register ───────────────────────── */

function IssueList({ deal }: { deal: ConsolidatedDeal }) {
  if (!deal.issues.length) return null;
  return <div className="checklist">{deal.issues.map((i, k) => (
    <div key={k} className={i.level === 'blocker' ? 'login-error' : ''}><AlertTriangle size={14} /> {i.message}</div>
  ))}</div>;
}

function MkDetails({ deal }: { deal: ConsolidatedDeal }) {
  if (!deal.mk) return <p>Выпуска МК по шифрам сделки нет.</p>;
  return (
    <div className="table-wrap"><table className="mk-lines">
      <thead><tr><th>Шифр</th><th>Источник</th><th>Месяц / цех</th><th>Выпуск</th><th>Металл</th><th>Руб/кг</th><th>Работа</th><th>Итого</th></tr></thead>
      <tbody>{deal.mk.byOpp.flatMap(o => o.lines.map((l, k) => (
        <tr key={o.opp + '-' + k}>
          <td>{o.opp}</td><td>{l.source === 'own' ? 'СЗ' : 'Сторонний'}</td><td>{l.source === 'own' ? l.month : l.workshop}</td>
          <td>{tonnes(l.outputT)}</td><td>{money(l.metalRub)}</td>
          <td>{l.rate === null ? <span className="login-error">нет</span> : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(l.rate)}</td>
          <td>{money(l.workRub)}</td><td>{money(l.totalRub)}{l.note && <small>{l.note}</small>}</td>
        </tr>
      )))}</tbody>
    </table></div>
  );
}

function RegisterPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
  const [period, setPeriod] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const departments = c.departments;
  const visible = c.deals.filter(d => (period === 'all' || d.blocks.some(b => b.period === period))
    && (d.name + ' ' + (d.b24 ?? '') + ' ' + d.client).toLowerCase().includes(search.toLowerCase()));
  const blockFact = (d: ConsolidatedDeal, dep: string) => {
    const bs = d.blocks.filter(b => b.department === dep && (period === 'all' || b.period === period));
    if (!bs.length) return null;
    return bs.reduce((s, b) => s + (b.profitFact ?? b.profitPlan ?? 0), 0);
  };
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

  return (
    <>
      <Heading eyebrow="СВОДНЫЙ РЕЕСТР" title="Сделки по подразделениям"
        text="Блоки подразделений из файлов «Закрытые сделки», шифр для бухгалтерии (ОПП) из «Номеров заказов» и раздел «Производство МК»." />
      {!data.departments.length && <div className="bottom-note">Файлы подразделений ещё не загружены — откройте «Загрузка файлов».</div>}
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по сделке, Б24 или заказчику" aria-label="Поиск" /></div>
        <select value={period} onChange={e => setPeriod(e.target.value)} aria-label="Месяц">
          <option value="all">Все месяцы</option>
          {c.periods.map(p => <option key={p} value={p}>{monthLabel(p)}</option>)}
        </select>
        <span className="result-count">{visible.length} сд.</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr>
          <th></th><th>Б24 / сделка</th><th>ОПП</th>
          {departments.map(dep => <th key={dep}>{dep}, прибыль</th>)}
          <th>Производство МК, себестоимость</th><th>Замечания</th>
        </tr></thead>
        <tbody>{visible.map(d => (
          <Fragment key={d.key}>
            <tr tabIndex={0} role="button" aria-expanded={open === d.key} onClick={() => setOpen(open === d.key ? null : d.key)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === d.key ? null : d.key); } }}>
              <td>{open === d.key ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
              <td><strong>{d.name}</strong><small>{d.b24 ?? 'без номера'}{d.client ? ' · ' + d.client : ''}</small></td>
              <td>{d.opps.join(', ') || '—'}</td>
              {departments.map(dep => { const v = blockFact(d, dep); return <td key={dep} className={v !== null && v < 0 ? 'negative' : ''}>{money(v)}</td>; })}
              <td>{d.mk ? money(d.mk.totalRub) : '—'}{d.mk && <small>{tonnes(d.mk.outputT)}</small>}</td>
              <td>{d.issues.length ? <span className={'status ' + (d.issues.some(i => i.level === 'blocker') ? 'status-danger' : 'status-review')}>{d.issues.length}</span> : '—'}</td>
            </tr>
            {open === d.key && (
              <tr className="details-row"><td colSpan={5 + departments.length}>
                <h3>Блоки подразделений</h3>
                <div className="table-wrap"><table>
                  <thead><tr><th>Подразделение</th><th>Месяц</th><th>Выручка факт / план</th><th>Себестоимость факт / план</th><th>Прибыль факт / план</th><th>Источник</th></tr></thead>
                  <tbody>{d.blocks.map((b, k) => (
                    <tr key={k}><td>{b.department}</td><td>{monthLabel(b.period)}</td>
                      <td>{money(b.revenueFact)} / {money(b.revenuePlan)}</td><td>{money(b.costFact)} / {money(b.costPlan)}</td>
                      <td>{money(b.profitFact)} / {money(b.profitPlan)}</td><td><small>{b.fileName}, стр. {b.sourceRow}</small></td></tr>
                  ))}</tbody>
                </table></div>
                {d.tankCodes.length > 0 && <p><b>Баки:</b> {d.tankCodes.join('; ')}</p>}
                <h3>Производство МК</h3>
                <MkDetails deal={d} />
                <IssueList deal={d} />
              </td></tr>
            )}
          </Fragment>
        ))}</tbody>
      </table></div>
      <MatchReview kind="deal" title="Сделки без номера Б24" items={c.unmatchedDealNames} candidates={refCandidates} onSaved={onChanged}
        toAlias={(item, candidate) => { const b24 = Number(/^\s*(\d+)/.exec(candidate)?.[1]); return b24 ? { from: dealNameKey(item), to: b24 } : null; }} />
    </>
  );
}

/* ───────────────────────── Production ───────────────────────── */

function ProductionPage({ c, data, onChanged }: { c: Consolidation; data: WorkspaceData; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const rows = c.productionDeals.filter(d => (String(d.b24) + ' ' + d.client + ' ' + d.opps.join(' ')).toLowerCase().includes(search.toLowerCase()));
  const totals = c.productionDeals.reduce((s, d) => ({ t: s.t + d.mk!.outputT, metal: s.metal + d.mk!.metalRub, work: s.work + d.mk!.workRub }), { t: 0, metal: 0, work: 0 });
  const rateLabels = Object.values(data.rates?.contractorLabels ?? {});
  return (
    <>
      <Heading eyebrow="СЕБЕСТОИМОСТЬ МК" title="Производство МК"
        text="Себестоимость = списание металла + выпуск (т × 1000) × коэффициент: для СЗ — коэффициент месяца, для подрядчиков — расценка за кг из «Расценок»." />
      <div className="kpi-grid">
        <div className="kpi-card"><span>Выпуск</span><strong className="kpi-value">{tonnes(totals.t)}</strong></div>
        <div className="kpi-card"><span>Металл</span><strong className="kpi-value">{money(totals.metal)}</strong></div>
        <div className="kpi-card"><span>Работа</span><strong className="kpi-value">{money(totals.work)}</strong></div>
        <div className="kpi-card"><span>Итого</span><strong className="kpi-value">{money(totals.metal + totals.work)}</strong></div>
      </div>
      {c.globalIssues.length > 0 && (
        <section className="panel"><div className="panel-heading"><div><h2>Что мешает расчёту</h2></div></div>
          <div className="checklist">{c.globalIssues.map((i, k) => <div key={k} className="login-error"><AlertTriangle size={14} /> {i.message}</div>)}</div>
          {c.unmatchedProductionOpps.length > 0 && <p>Шифры из отчётов о выпуске, которых нет в «Номерах заказов»: {c.unmatchedProductionOpps.join(', ')}.</p>}
        </section>
      )}
      <MatchReview kind="contractor" title="Подрядчики без расценки" items={c.missingContractors} candidates={rateLabels} onSaved={onChanged}
        toAlias={(item, candidate) => ({ from: normalizeName(item), to: normalizeName(candidate) })} />
      <div className="filters">
        <div className="search-box"><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по Б24, заказчику, шифру" aria-label="Поиск" /></div>
        <span className="result-count">{rows.length} сд.</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th></th><th>Б24 / заказчик</th><th>ОПП</th><th>Выпуск</th><th>Металл</th><th>Работа</th><th>Итого</th><th>Руб/кг</th></tr></thead>
        <tbody>{rows.map(d => (
          <Fragment key={d.key}>
            <tr tabIndex={0} role="button" aria-expanded={open === d.key} onClick={() => setOpen(open === d.key ? null : d.key)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === d.key ? null : d.key); } }}>
              <td>{open === d.key ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
              <td><strong>{d.b24}</strong><small>{d.client}</small></td><td>{d.opps.join(', ')}</td>
              <td>{tonnes(d.mk!.outputT)}</td><td>{money(d.mk!.metalRub)}</td><td>{money(d.mk!.workRub)}</td><td>{money(d.mk!.totalRub)}</td>
              <td>{d.mk!.outputT > 0 ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(d.mk!.totalRub / (d.mk!.outputT * 1000)) : '—'}</td>
            </tr>
            {open === d.key && <tr className="details-row"><td colSpan={8}><MkDetails deal={d} /><IssueList deal={d} /></td></tr>}
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
  const deterministic = useMemo(() => c.deals.flatMap(d => d.issues.map(i => `${d.key}: ${i.message}`)).concat(c.globalIssues.map(i => i.message)), [c]);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const hasData = c.deals.length > 0 || c.productionDeals.length > 0;
  const nameOf = (key: string) => c.deals.find(d => d.key === key)?.name ?? c.productionDeals.find(d => d.key === key)?.client ?? key;

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
        text="Сначала работают обязательные проверки системы, затем ИИ ищет аномалии и отвечает на вопросы. Решения принимает администратор." />
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
        <div className="panel-heading"><div><h2>Вопросы по данным</h2><p>Например: «Какие сделки убыточны в феврале?», «Где самая дорогая МК за кг?»</p></div></div>
        <div className="chat-log" aria-live="polite">
          {messages.map((m, k) => <div key={k} className={'chat-msg ' + m.role}>{m.content}</div>)}
          {chatBusy && <div className="chat-msg assistant">Думаю…</div>}
        </div>
        <div className="chat-input">
          <textarea rows={2} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ваш вопрос" aria-label="Вопрос"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
          <button className="btn-primary" disabled={chatBusy || !question.trim() || !hasData} onClick={() => void ask()} aria-label="Отправить"><Send size={16} /></button>
        </div>
        <small>ИИ видит только сводку по сделкам из загруженных файлов.</small>
      </section>
    </>
  );
}
