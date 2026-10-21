import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_GENERAL_PARAMETERS, checkFinancialRegister, financialTotals, type GeneralParameters } from './domain/financial-controls';
import {
  accountingDeals, dealsForPeriod, periods, sumKnown, SOURCE_NAME, SOURCE_SHEET,
  type AccountingDeal, type BlockName,
} from './data/management-2025';
const api = {
  post: async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof data?.message === 'string' ? data.message : 'API request failed'
      );
    }
    return { data };
  },
};
import {
  LayoutDashboard,
  FileText,
  Upload,
  Search,
  Bell,
  ChevronDown,
  Download,
  Printer,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ArrowUpRight,
  ArrowDownRight,
  Menu,
  X,
  BrainCircuit,
  FileSpreadsheet,
  SlidersHorizontal,
} from 'lucide-react';

type Deal = AccountingDeal;
const money = (n: number) =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
const pct = (n: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n) + '%';
const periodOptions = periods;

const regulationSections = [
  {
    title: '1. Назначение и принципы',
    body: 'MONOLITH — единая система финансового контроля компании. Система объединяет финансовую сводку, детализацию по блокам и сделкам, контроль качества данных, версионность источников и журнал управленческих решений. Подтверждённые результаты отделяются от предварительных. ИИ помогает выявлять риски, но не заменяет ответственность администратора.',
  },
  {
    title: '2. Дашборд и отчётность',
    body: 'Главный экран показывает выручку, затраты, прибыль и рентабельность продаж, а также итоги по финансовым блокам: МК, комплектация, документация, СМР и логистика. Периоды: выбранный месяц, сравнение с предыдущим месяцем и накопительный итог с начала года. Предусмотрены графики, таблицы, фильтры, переходы от блока к сделке и экспорт отчёта в Excel-совместимый формат и PDF.',
  },
  {
    title: '3. Финансовые расчёты',
    body: 'Прибыль = выручка − затраты. Рентабельность продаж = прибыль / выручка × 100%; при нулевой выручке показатель не рассчитывается. Расчёт по каждой сделке должен быть воспроизводимым: сохраняются версия методики, исходные данные, формулы, промежуточные значения и итог. БГ и штрафы отражаются отдельно согласно утверждённой методике и не включаются в рентабельность отдельных блоков, если методика прямо не предусматривает иное.',
  },
  {
    title: '4. Роли и полномочия',
    body: 'Администратор имеет полный доступ к источникам, методике, справочникам, проверкам, журналу изменений и подтверждению финансовых результатов. Руководитель видит все сделки и финансовые результаты, оставляет комментарии, отмечает сделки для дополнительной проверки и запрашивает пересчёт. Сотрудник подразделения работает только с данными своего подразделения, отвечает на запросы и предоставляет исправления. Руководитель и сотрудники не меняют методику и не подтверждают итоговый результат.',
  },
  {
    title: '5. Проверки системы и ИИ',
    body: 'Автоматические проверки охватывают формат, обязательные поля, дубли, арифметику, соответствие структуре источника, сопоставления ОПП, пропуски и изменения относительно прошлых версий. ИИ анализирует необычные изменения, возможные ошибки формул, конфликтующие соответствия и вероятные пропуски затрат. Замечание ИИ должно сопровождаться объяснением и доступными основаниями. Необычное, но допустимое изменение вызывает предупреждение без блокировки; вероятная ошибка или конфликт направляются на проверку. Критические ошибки, определённые системными правилами, блокируют подтверждение.',
  },
  {
    title: '6. Решение по замечаниям ИИ',
    body: 'Если обычные проверки не нашли ошибки, а ИИ обнаружил возможную проблему, система показывает предупреждение и передаёт решение администратору. Администратор может отметить замечание как не подтверждённое; комментарий необязателен. Система сохраняет само замечание, решение и дату. История решений может использоваться для улучшения будущих проверок, но не изменяет финансовые правила автоматически.',
  },
  {
    title: '7. Запрос пересчёта руководителем',
    body: 'Запрос руководителя сначала анализируется ИИ: проверяются формулы, источники, ОПП, затраты по блокам, история и возможные причины расхождений. ИИ формирует заключение и рекомендации. Администратор решает, исправлять ли данные, менять ли соответствие или запускать пересчёт. Руководителю доступны статус, заключение ИИ, решение администратора и сравнение до/после, если пересчёт состоялся.',
  },
  {
    title: '8. Методика и её версии',
    body: 'Администратор может менять формулы, правила распределения затрат и источники данных. Каждое изменение фиксируется с автором, датой, причиной, предыдущей и новой версией и датой начала действия. Администратор выбирает область применения: будущие периоды, конкретные прошлые месяцы или все периоды с даты. Перед пересчётом показывается список затронутых сделок. Старые расчёты сохраняются; изменившиеся подтверждённые результаты требуют повторной проверки и подтверждения.',
  },
  {
    title: '9. Загрузка и версии файлов',
    body: 'Каждая загруженная версия исходного файла сохраняется. Перед применением проверяются формат, обязательные колонки, дубли, суммы, структура и отличия от предыдущей версии. ИИ выделяет необычные изменения и готовит вопросы администратору. Обычные обновления могут применяться автоматически только при отсутствии существенных конфликтов. Конфликты подтверждённых соответствий ОПП, дубли и неоднозначности направляются администратору; затронутые сделки при необходимости блокируются, остальные продолжают рассчитываться.',
  },
  {
    title: '10. Пороги существенности и подтверждение',
    body: 'В качестве исходного правила для существенных изменений применяется порог 50 000 ₽ или 2% — если утверждённая рабочая конфигурация не установит иное. Порог требует согласования с реальной финансовой методикой до промышленного использования. Подтверждение доступно администратору после прохождения обязательных проверок. При изменении исходных данных или расчёта подтверждение затронутого результата снимается. ИИ сам не утверждает финансовые результаты.',
  },
  {
    title: '11. Аудит и хранение',
    body: 'Для каждой сделки хранятся версии расчётов, версии методики и источников, промежуточные вычисления, результаты автоматических проверок и ИИ, решения администратора и статус подтверждения. Сводный отчёт по изменению методики показывает количество пересчитанных сделок и влияние на выручку, затраты, прибыль и финансовые блоки. История не переписывается незаметно и не удаляется при загрузке новой версии.',
  },
  {
    title: '12. Статус внедрения',
    body: 'Этот экземпляр интерфейса содержит демонстрационные данные и согласованное положение. До промышленного запуска необходимо подключить утверждённые исходные файлы, определить точные поля и соответствия, проверить формулы на контрольных примерах, настроить защищённую аутентификацию и хранение версий, согласовать пороги существенности и проверить права доступа. Демонстрационные показатели не являются финансовой отчётностью компании.',
  },
];

function App() {
  const [page, setPage] = useState('dashboard');
  const [period, setPeriod] = useState('2025');
  const [generalParameters, setGeneralParameters] = useState<GeneralParameters>(DEFAULT_GENERAL_PARAMETERS);
  const periodDeals = useMemo(() => dealsForPeriod(accountingDeals, period), [period]);
  const [filter, setFilter] = useState('Все блоки');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Deal | null>(null);
  const [aiText, setAiText] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAvailability, setAiAvailability] = useState<'checking' | 'available' | 'unavailable'>('checking');
  useEffect(() => {
    if (page !== 'checks') return;
    let active = true;
    setAiAvailability('checking');
    fetch('/api/health', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('API not reachable');
        const body = await response.json();
        if (body?.status !== 'ok') throw new Error('API not ready');
        if (active) setAiAvailability('available');
      })
      .catch(() => { if (active) setAiAvailability('unavailable'); });
    return () => { active = false; };
  }, [page]);
  const [notice, setNotice] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const deals = useMemo(
    () =>
      periodDeals.filter(
        d =>
          (filter === 'Все блоки' || (d.blockCosts[filter as BlockName] ?? 0) > 0) &&
          (d.name + d.id + d.customer + d.period).toLowerCase().includes(search.toLowerCase())
      ),
    [filter, search, periodDeals]
  );
  const totals = useMemo(() => financialTotals(periodDeals, generalParameters), [periodDeals, generalParameters]);
  const reportCheck = useMemo(() => checkFinancialRegister(periodDeals, generalParameters), [periodDeals, generalParameters]);
  const profit = totals.profit;
  const margin = totals.margin;
  const blocks = generalParameters.blocks
    .filter(item => item.active && item.includeInTotals)
    .map(({ name }) => {
      const values = periodDeals.map(deal => deal.blockCosts[name as BlockName]);
      const amount = sumKnown(values);
      return { name, amount: amount.sum, complete: amount.complete,
        count: values.filter(value => value !== null && value !== 0).length };
    });
  const previousPeriod = /^2025-(0[2-9]|1[0-2])$/.test(period)
    ? `2025-${String(Number(period.slice(5)) - 1).padStart(2, '0')}` : null;
  const comparisonDeals = previousPeriod ? dealsForPeriod(accountingDeals, previousPeriod) : [];
  const comparison = comparisonDeals.length ? financialTotals(comparisonDeals, generalParameters) : null;
  const change = (now: number, before: number | undefined) => before && Number.isFinite(before)
    ? pct(((now - before) / Math.abs(before)) * 100) : '—';
  const trend = (now: number, before: number | undefined) =>
    before === undefined ? 'flat' : now > before ? 'up' : now < before ? 'down' : 'flat';
  const comparisonLabel = comparison ? 'к предыдущему месяцу' : 'нет данных для сравнения';
  const exportCsv = () => {
    if (!deals.length) {
      setNotice('За выбранный период или фильтр нет данных для выгрузки.');
      return;
    }
    const rows = [
      [
        'Период', 'Шифр сделки', 'Заказчик', 'Изделие',
        'Выручка план, ₽', 'Выручка факт, ₽',
        'Себестоимость план, ₽', 'Себестоимость факт, ₽',
        'Прибыль факт, ₽', 'Рентабельность продаж, %',
        'Вес факт, кг', 'Строка Excel', 'Статус сверки', 'Замечания',
      ],
      ...deals.map(d => [
        d.period || 'Без периода', d.id, d.customer, d.name,
        d.plan, d.revenue, d.planCost, d.cost,
        d.revenue - d.cost,
        d.revenue ? (((d.revenue - d.cost) / d.revenue) * 100).toFixed(2) : '',
        d.weightKg ?? '', SOURCE_SHEET + '!' + d.sourceRow,
        d.status, d.issue,
      ]),
    ];
    const csv =
      '\uFEFF' +
      rows
        .map(r =>
          r.map(v => {
            const text = String(v);
            const safe = typeof v === 'string' && /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
            return '"' + safe.replace(/"/g, '""') + '"';
          }).join(';')
        )
        .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'MONOLITH-Upravlencheskiy-uchet-2025.csv';
    a.click();
    URL.revokeObjectURL(url);
    setNotice(
      'Экспортирован CSV из исходного XLSX. Показатели требуют проверки первичных документов.'
    );
  };
  const runAi = async () => {
    if (aiAvailability !== 'available') {
      setAiResult('Сервер /api/review-change недоступен. Запрос не отправлен.');
      return;
    }
    if (!aiText.trim()) {
      setNotice('Введите описание изменения для проверки.');
      return;
    }
    setAiBusy(true);
    setAiResult('');
    try {
      const response = await api.post('/api/review-change', {
        description: aiText,
      });
      setAiResult(
        response.data.summary +
          ' Категория: ' +
          response.data.label +
          '. ' +
          response.data.action
      );
    } catch (cause) {
      setAiResult(cause instanceof Error
        ? 'ИИ не ответил: ' + cause.message + '. Используйте ручную проверку.'
        : 'ИИ не ответил. Используйте ручную проверку.');
    } finally {
      setAiBusy(false);
    }
  };
  const nav = [
    { id: 'dashboard', label: 'Дашборд', icon: LayoutDashboard },
    { id: 'deals', label: 'Сделки', icon: FileSpreadsheet },
    { id: 'checks', label: 'Проверки ИИ', icon: BrainCircuit },
    { id: 'regulation', label: 'Положение', icon: FileText },
    { id: 'settings', label: 'Настройки', icon: SlidersHorizontal },
  ];
  return (
    <div className="shell">
      <aside className={'sidebar ' + (mobileNav ? 'sidebar-open' : '')}>
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>MONOLITH</strong>
            <span>ФИНАНСОВЫЙ КОНТРОЛЬ</span>
          </div>
          <button className="mobile-close" onClick={() => setMobileNav(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="workspace">
          <span className="workspace-dot"></span>
          <div>
            <strong>Главная компания</strong>
            <small>Демонстрационный режим</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {nav.map(item => (
            <button
              key={item.id}
              className={'nav-item ' + (page === item.id ? 'active' : '')}
              onClick={() => {
                setPage(item.id);
                setMobileNav(false);
              }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'checks' && <span className="nav-count">3</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-icon">
            <ShieldCheck size={18} />
          </div>
          <div>
            <strong>Контроль доступа</strong>
            <small>3 роли · аудит изменений</small>
          </div>
        </div>
        <div className="profile">
          <div className="avatar">А</div>
          <div>
            <strong>Администратор</strong>
            <small>Полный доступ</small>
          </div>
          <ChevronDown size={16} />
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            MONOLITH <span>/</span> {nav.find(n => n.id === page)?.label}
          </div>
          <div className="top-actions">
            <span className="demo-pill">
              <span></span> ДЕМО-ДАННЫЕ
            </span>
            <button
              className="icon-btn"
              aria-label="Уведомления"
              onClick={() =>
                setNotice(
                  'Уведомления: 3 сделки требуют внимания администратора.'
                )
              }
            >
              <Bell size={18} />
              <i></i>
            </button>
            <div className="top-avatar">А</div>
          </div>
        </header>
        <div className="content">
          {notice && (
            <div className="toast">
              <span>{notice}</span>
              <button onClick={() => setNotice('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'dashboard' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ФИНАНСОВАЯ СВОДКА</div>
                  <h1>Обзор компании</h1>
                  <p>
                    Финансовые показатели и контроль качества данных в одном
                    месте.
                  </p>
                </div>
                <div className="heading-actions">
                  <select
                    value={period}
                    onChange={e => setPeriod(e.target.value)}
                    aria-label="Период"
                  >
                    {periodOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <button className="btn-secondary" onClick={exportCsv}>
                    <Download size={16} /> Excel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => window.print()}
                  >
                    <Printer size={16} /> PDF / печать
                  </button>
                </div>
              </div>
              <div className="period-strip">
                <span>
                  <Clock3 size={15} /> Период: <b>{period}</b>
                </span>
                <span>{comparison ? 'Сравнение с предыдущим месяцем' : 'Нет сопоставимых данных предыдущего периода'}</span>
                <span className="prelim-tag">XLSX 2025 · предварительные данные</span>
              </div>
              <div className="kpi-grid">
                <Kpi
                  label="Выручка"
                  value={periodDeals.length ? money(totals.revenue) : '—'}
                  change={change(totals.revenue, comparison?.revenue)}
                  trend={trend(totals.revenue, comparison?.revenue)}
                  note={comparisonLabel}
                  color="blue"
                />
                <Kpi
                  label="Затраты"
                  value={periodDeals.length ? money(totals.cost) : '—'}
                  change={change(totals.cost, comparison?.cost)}
                  trend={trend(totals.cost, comparison?.cost)}
                  note={comparisonLabel}
                  color="orange"
                />
                <Kpi
                  label="Прибыль"
                  value={periodDeals.length ? money(profit) : '—'}
                  change={change(profit, comparison?.profit)}
                  trend={trend(profit, comparison?.profit)}
                  note={comparisonLabel}
                  color="green"
                />
                <Kpi
                  label="Рентабельность продаж"
                  value={margin === null || !periodDeals.length ? '—' : pct(margin)}
                  change={margin !== null && comparison?.margin != null ? pct(margin - comparison.margin) + ' п.п.' : '—'}
                  trend={margin !== null && comparison?.margin != null ? trend(margin, comparison.margin) : 'flat'}
                  note={comparisonLabel}
                  color="violet"
                />
              </div>
              {periodDeals.length === 0 && (
                <div className="bottom-note">За выбранный период в импортированном XLSX нет записей. Отсутствие данных не означает нулевой результат.</div>
              )}
              <div className="section-head">
                <div>
                  <h2>Расшифровка фактических затрат</h2>
                  <p>По направлениям из Excel · без повторного учёта выручки</p>
                </div>
                <button
                  className="text-action"
                  onClick={() => setPage('deals')}
                >
                  Все сделки <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="block-grid">
                {blocks.map(b => (
                  <button
                    className="block-card"
                    key={b.name}
                    onClick={() => {
                      setFilter(b.name);
                      setPage('deals');
                    }}
                  >
                    <div className="block-top">
                      <span
                        className={
                          'block-symbol sym-' +
                          b.name
                            .toLowerCase()
                            .replace('ё', 'е')
                            .replace(' ', '-')
                        }
                      >
                        {b.name === 'МК'
                          ? 'МК'
                          : b.name.slice(0, 2).toUpperCase()}
                      </span>
                      <ArrowUpRight size={16} className="muted-icon" />
                    </div>
                    <h3>{b.name}</h3>
                    <strong>{b.amount !== null ? money(b.amount) : '—'}</strong>
                    <small>{b.count} сделок с указанными затратами</small>
                    <div className="mini-bar"><span style={{ width: b.amount !== null && totals.cost > 0
                      ? Math.min(100, Math.max(0, (b.amount / totals.cost) * 100)) + '%' : '0%' }}></span></div>
                    <div className="block-meta">
                      <span>{b.complete ? 'Факт из Excel' : 'Факт (неполные данные)'}</span>
                      <b>{b.amount !== null ? money(b.amount) : 'нет данных'}</b>
                    </div>
                  </button>
                ))}
              </div>
              <div className="lower-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Приоритетные сделки</h2>
                      <p>Список для внимания администратора</p>
                    </div>
                    <span className="counter">{periodDeals.filter(d => d.status !== 'Подтверждён').length} требуют внимания</span>
                  </div>
                  {periodDeals
                    .filter(d => d.status !== 'Подтверждён')
                    .slice(0, 3)
                    .map((d, i) => (
                      <button
                        className="priority-row"
                        key={d.id}
                        onClick={() => setSelected(d)}
                      >
                        <span className={'priority-num p' + i}>
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="priority-copy">
                          <strong>{d.name}</strong>
                          <small>
                            {d.id} · {d.issue}
                          </small>
                        </span>
                        <span
                          className={
                            'status ' +
                            (d.status === 'На проверке'
                              ? 'status-review'
                              : 'status-prelim')
                          }
                        >
                          {d.status}
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                  <button
                    className="panel-link"
                    onClick={() => setPage('deals')}
                  >
                    Открыть полный реестр <ArrowUpRight size={15} />
                  </button>
                </section>
                <section className="panel health-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Готовность данных</h2>
                      <p>Контроль перед подтверждением</p>
                    </div>
                    <ShieldCheck size={19} className="green-text" />
                  </div>
                  <div className="health-score">
                    <div className="score-ring">
                      <strong>{reportCheck.okToPublish ? 'OK' : '!'}</strong>
                        <span>контроль</span>
                    </div>
                    <div>
                      <strong>{reportCheck.okToPublish ? 'Блокировок нет' : 'Отчёт не готов к подтверждению'}</strong>
                       <p>Детерминированные проверки демонстрационного реестра.</p>
                    </div>
                  </div>
                  <div className="health-line">
                    <span>
                      <i className="dot green-dot"></i> Проверено активных сделок
                    </span>
                    <b>{reportCheck.checkedDeals}</b>
                  </div>
                  <div className="health-line">
                    <span>
                      <i className="dot amber-dot"></i> Предупреждения правил
                    </span>
                    <b>{reportCheck.warnings}</b>
                  </div>
                  <div className="health-line">
                    <span>
                      <i className="dot red-dot"></i> Блокирующие замечания
                    </span>
                    <b>{reportCheck.blockers}</b>
                  </div>
                  <button
                    className="panel-link"
                    onClick={() => setPage('checks')}
                  >
                    Перейти к проверкам <ArrowUpRight size={15} />
                  </button>
                </section>
              </div>
              <div className="bottom-note">
                <ShieldCheck size={16} />
                <span>
                  Подтверждённые и предварительные результаты разделяются.
                  Данные на экране — демонстрационные, не финансовая отчётность.
                </span>
              </div>
            </>
          )}
          {page === 'deals' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">РЕЕСТР ФИНАНСОВОГО КОНТРОЛЯ</div>
                  <h1>Сделки</h1>
                  <p>Реестр и финансовые результаты по блокам.</p>
                </div>
                <div className="heading-actions">
                  <select value={period} onChange={e => setPeriod(e.target.value)} aria-label="Период реестра">
                    {periodOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <button className="btn-secondary" onClick={exportCsv}>
                    <Download size={16} /> Экспорт Excel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => window.print()}
                  >
                    <Printer size={16} /> PDF / печать
                  </button>
                </div>
              </div>
              <div className="filters">
                <div className="search-box">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Поиск по сделке или ID"
                  />
                </div>
                <select
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                >
                  <option>Все блоки</option>
                  {blocks.map(b => (
                    <option key={b.name}>{b.name}</option>
                  ))}
                </select>
                <span className="result-count">{deals.length} сделок</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>СДЕЛКА</th>
                      <th>БЛОК</th>
                      <th>ВЫРУЧКА</th>
                      <th>ЗАТРАТЫ</th>
                      <th>ПРИБЫЛЬ</th>
                      <th>РЕНТАБЕЛЬНОСТЬ</th>
                      <th>СТАТУС</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deals.map(d => (
                      <tr key={d.id} onClick={() => setSelected(d)}>
                        <td>
                          <strong>{d.name}</strong>
                          <small>{d.id}</small>
                        </td>
                        <td>
                          <span className="block-chip">{d.block}</span>
                        </td>
                        <td>{money(d.revenue)}</td>
                        <td>{money(d.cost)}</td>
                        <td
                          className={
                            d.revenue - d.cost < 0 ? 'negative' : 'positive'
                          }
                        >
                          {money(d.revenue - d.cost)}
                        </td>
                        <td>{d.revenue ? pct(((d.revenue - d.cost) / d.revenue) * 100) : '—'}</td>
                        <td>
                          <span
                            className={
                              'status ' +
                              (d.status === 'Подтверждён'
                                ? 'status-ok'
                                : d.status === 'На проверке'
                                  ? 'status-review'
                                  : 'status-prelim')
                            }
                          >
                            {d.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {deals.length === 0 && (
                  <div className="empty-state">
                    По заданным фильтрам сделки не найдены.
                  </div>
                )}
              </div>
              <div className="table-foot">
                Нажмите на строку, чтобы открыть карточку сделки. Источники и
                фактические расчёты подключаются при внедрении.
              </div>
            </>
          )}
          {page === 'checks' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">КОНТРОЛЬ КАЧЕСТВА</div>
                  <h1>Проверки ИИ</h1>
                  <p>Оценка подозрительных изменений до применения данных.</p>
                </div>
                <span className="demo-pill">
                  <span></span> Режим демонстрации
                </span>
              </div>
              <section className="panel settings-panel">
                <div className="panel-heading"><div><h2>Обязательные проверки</h2><p>Детерминированные правила проверяются до анализа ИИ.</p></div></div>
                <p>Проверено сделок: {reportCheck.checkedDeals}. Блокировок: {reportCheck.blockers}. Предупреждений: {reportCheck.warnings}.</p>
                <div className="checklist">
                  {reportCheck.issues.slice(0, 12).map((issue, index) => (
                    <div key={issue.code + index}><AlertTriangle size={16} />
                      {issue.level === 'blocker' ? 'Блокировка: ' : 'Предупреждение: '}{issue.message}</div>
                  ))}
                  {reportCheck.issues.length === 0 && <div><CheckCircle2 size={16}/>Нет замечаний к реестру.</div>}
                </div>
                <p>Демо-проверка не заменяет сверку первичных источников и утверждение администратором.</p>
              </section>
              <div className="ai-banner">
                <div className="ai-badge">
                  <BrainCircuit size={22} />
                </div>
                <div>
                  <strong>ИИ — помощник администратора</strong>
                  <p>
                    ИИ классифицирует риск и предлагает действие. Он не изменяет
                    методику и не подтверждает финансовый результат.
                  </p>
                </div>
              </div>
              <section className="panel ai-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Проверить изменение</h2>
                    <p>
                      Опишите отличие в новом файле или подозрительную строку.
                    </p>
                  </div>
                  <span className="live-dot">AI REVIEW</span>
                </div>
                <label htmlFor="ai-description">Описание изменения</label>
                <textarea
                  id="ai-description"
                  value={aiText}
                  onChange={e => setAiText(e.target.value)}
                  rows={5}
                />
                <div className="ai-form-footer">
                  <small>
                    Не вводите пароли или избыточные персональные данные.
                  </small>
                  <button
                    className="btn-primary"
                    onClick={runAi}
                    disabled={aiBusy}
                  >
                    {aiBusy ? (
                      'Анализируем…'
                    ) : (
                      <>
                        <BrainCircuit size={16} /> Анализировать с ИИ
                      </>
                    )}
                  </button>
                </div>
                {aiResult && (
                  <div className="ai-result">
                    <div className="result-icon">
                      <ShieldCheck size={18} />
                    </div>
                    <div>
                      <strong>Результат анализа</strong>
                      <p>{aiResult}</p>
                      <small>
                        Решение остаётся за администратором. Перед применением
                        проверьте первичный источник.
                      </small>
                    </div>
                  </div>
                )}
              </section>
              <div className="section-head">
                <div>
                  <h2>Последние замечания</h2>
                  <p>Демонстрационный список</p>
                </div>
              </div>
              <div className="issue-list">
                <Issue
                  level="Высокий риск"
                  title="Возможное несоответствие ОПП"
                  desc="MON-2402 · требуется ручная проверка соответствия."
                />
                <Issue
                  level="Предупреждение"
                  title="Необычное изменение суммы"
                  desc="MON-2405 · сравнить с предыдущей версией файла."
                />
                <Issue
                  level="Критический конфликт"
                  title="Повторная строка источника"
                  desc="MON-2406 · подтверждение заблокировано до устранения дубля."
                />
              </div>
            </>
          )}
          {page === 'regulation' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">НОРМАТИВНЫЙ ДОКУМЕНТ</div>
                  <h1>Положение о MONOLITH</h1>
                  <p>
                    Согласованные правила финансового контроля, расчётов и
                    использования ИИ.
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      const w = window.open('', '_blank');
                      if (w) {
                        w.document.write(
                          '<html lang="ru"><head><title>Положение о MONOLITH</title><style>body{font:16px Arial;line-height:1.6;max-width:900px;margin:40px auto;color:#182331}h1,h2{color:#163b63} @media print{body{margin:18mm}}</style></head><body><h1>Положение о MONOLITH</h1><p>Редакция 1.0 · 21 октября 2026 года · Проект для согласования</p>' +
                            regulationSections
                              .map(
                                s =>
                                  '<h2>' +
                                  s.title +
                                  '</h2><p>' +
                                  s.body +
                                  '</p>'
                              )
                              .join('') +
                            '</body></html>'
                        );
                        w.document.close();
                        w.print();
                      }
                    }}
                  >
                    <Printer size={16} /> Печать / PDF
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      const blob = new Blob(
                        [
                          '\uFEFFПОЛОЖЕНИЕ О MONOLITH\r\nРедакция 1.0 · 21 октября 2026 года · Проект для согласования\r\n\r\n' +
                            regulationSections
                              .map(s => s.title + '\r\n' + s.body)
                              .join('\r\n\r\n'),
                        ],
                        { type: 'application/msword;charset=utf-8' }
                      );
                      const u = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = u;
                      a.download = 'Polozhenie-MONOLITH.doc';
                      a.click();
                      URL.revokeObjectURL(u);
                    }}
                  >
                    <Download size={16} /> Скачать документ
                  </button>
                </div>
              </div>
              <div className="doc-meta">
                <span>
                  <FileText size={16} /> Редакция 1.0
                </span>
                <span>Дата: 21 октября 2026</span>
                <span className="prelim-tag">Проект для согласования</span>
              </div>
              <div className="regulation-layout">
                <div className="regulation-nav">
                  <strong>Содержание</strong>
                  {regulationSections.map((s, i) => (
                    <a key={s.title} href={'#section-' + i}>
                      {s.title}
                    </a>
                  ))}
                </div>
                <article className="regulation-doc">
                  <div className="doc-cover">
                    <div className="doc-mark">M</div>
                    <div className="eyebrow">
                      ВНУТРЕННИЙ НОРМАТИВНЫЙ ДОКУМЕНТ
                    </div>
                    <h2>Положение о системе MONOLITH</h2>
                    <p>Единая система финансового контроля компании</p>
                    <div className="doc-cover-line"></div>
                    <small>
                      Редакция 1.0 · 21 октября 2026 года · Проект для
                      согласования
                    </small>
                  </div>
                  {regulationSections.map((s, i) => (
                    <section
                      id={'section-' + i}
                      className="doc-section"
                      key={s.title}
                    >
                      <h3>{s.title}</h3>
                      <p>{s.body}</p>
                    </section>
                  ))}
                  <div className="approval-box">
                    <strong>Статус документа: проект для согласования</strong>
                    <p>
                      Перед утверждением необходимо согласовать финансовую
                      методику, пороги существенности, источники данных, правила
                      хранения и полномочия пользователей.
                    </p>
                  </div>
                </article>
              </div>
            </>
          )}
          {page === 'settings' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">КОНФИГУРАЦИЯ</div>
                  <h1>Настройки</h1>
                  <p>
                    Общие параметры демо-сеанса. Постоянное серверное хранение пока не подключено.
                  </p>
                </div>
              </div>
              <section className="panel settings-panel wide" style={{ marginBottom: 20 }}>
                <div className="panel-heading"><div><h2>Общие финансовые параметры</h2>
                  <p>Влияют на отображаемые итоги и обязательные проверки в текущем сеансе.</p></div>
                  <button className="btn-secondary" onClick={() => setGeneralParameters(DEFAULT_GENERAL_PARAMETERS)}>Сбросить</button>
                </div>
                <div className="filters">
                  <label>Порог, ₽ <input aria-label="Порог в рублях" type="number" min="1" value={generalParameters.materialityRub}
                    onChange={e => setGeneralParameters(prev => ({ ...prev, materialityRub: Number(e.target.value) }))}/></label>
                  <label>Порог, % <input aria-label="Порог в процентах" type="number" min="0.1" max="100" step="0.1" value={generalParameters.materialityPercent}
                    onChange={e => setGeneralParameters(prev => ({ ...prev, materialityPercent: Number(e.target.value) }))}/></label>
                </div>
                <p>Отклонение существенно при достижении порога в рублях ИЛИ процентах.</p>
                <div className="table-wrap"><table>
                  <thead><tr><th>Блок</th><th>Активен</th><th>Учитывать в итогах</th><th>Требовать подтверждение</th></tr></thead>
                  <tbody>{generalParameters.blocks.map(block => (
                    <tr key={block.name}><td>{block.name}</td>
                      {(['active', 'includeInTotals', 'requireConfirmation'] as const).map(field => (
                        <td key={field}><input type="checkbox" checked={block[field]} aria-label={block.name + ' ' + field}
                          onChange={e => setGeneralParameters(prev => ({ ...prev,
                            blocks: prev.blocks.map(item => item.name === block.name ? { ...item, [field]: e.target.checked } : item),
                          }))}/></td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table></div>
                <p>Данные демонстрационные. Настройки сбрасываются после обновления страницы и не меняют права доступа.</p>
              </section>
              <div className="settings-grid">
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Роли доступа</h2>
                      <p>Три роли, как согласовано</p>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <Setting
                    label="Администратор"
                    desc="Полный доступ, методика, проверки и подтверждение"
                  />
                  <Setting
                    label="Руководитель"
                    desc="Все сделки, запросы проверки и пересчёта"
                  />
                  <Setting
                    label="Сотрудник подразделения"
                    desc="Только данные своего подразделения"
                  />
                </section>
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Контроль изменений</h2>
                      <p>Параметры согласованного процесса</p>
                    </div>
                    <SlidersHorizontal size={18} />
                  </div>
                  <Setting
                    label="Версии исходных файлов"
                    desc="Сохранять все версии и сравнивать содержимое"
                  />
                  <Setting
                    label="ИИ-анализ"
                    desc="Предупреждения и классификация риска, решение за администратором"
                  />
                  <Setting
                    label="Порог существенности"
                    desc={generalParameters.materialityRub.toLocaleString("ru-RU") + " ₽ или " + generalParameters.materialityPercent + "% (демо)"}
                  />
                  <Setting
                    label="Подтверждение результата"
                    desc="Только администратор; при изменении расчёта — повторная проверка"
                  />
                </section>
                <section className="panel settings-panel wide">
                  <div className="panel-heading">
                    <div>
                      <h2>Статус внедрения</h2>
                      <p>Перед использованием реальных финансовых данных</p>
                    </div>
                    <span className="status status-prelim">Демонстрация</span>
                  </div>
                  <div className="checklist">
                    <div>
                      <CheckCircle2 size={17} /> Согласован состав дашборда и
                      отчёта
                    </div>
                    <div>
                      <CheckCircle2 size={17} /> Подготовлен проект положения
                    </div>
                    <div>
                      <CheckCircle2 size={17} /> Реализован демонстрационный
                      интерфейс
                    </div>
                    <div>
                      <AlertTriangle size={17} /> Требуется загрузить и
                      сопоставить реальные исходные файлы
                    </div>
                    <div>
                      <AlertTriangle size={17} /> Требуется проверка расчётов на
                      контрольных примерах
                    </div>
                    <div>
                      <AlertTriangle size={17} /> Требуется настроить
                      аутентификацию и постоянное хранилище
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
        <footer className="footer">
          <span>MONOLITH · Финансовый контроль</span>
          <span>
            Редакция интерфейса 1.0 <i>•</i> Данные демонстрационные
          </span>
        </footer>
      </main>
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="deal-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="eyebrow">{selected.id} · КАРТОЧКА СДЕЛКИ</div>
                <h2>{selected.name}</h2>
              </div>
              <button className="icon-btn" onClick={() => setSelected(null)}>
                <X size={18} />
              </button>
            </div>
            <span
              className={
                'status ' +
                (selected.status === 'Подтверждён'
                  ? 'status-ok'
                  : selected.status === 'На проверке'
                    ? 'status-review'
                    : 'status-prelim')
              }
            >
              {selected.status}
            </span>
            <div className="modal-kpis">
              <div>
                <small>Выручка</small>
                <strong>{money(selected.revenue)}</strong>
              </div>
              <div>
                <small>Затраты</small>
                <strong>{money(selected.cost)}</strong>
              </div>
              <div>
                <small>Прибыль</small>
                <strong
                  className={
                    selected.revenue - selected.cost < 0
                      ? 'negative'
                      : 'positive'
                  }
                >
                  {money(selected.revenue - selected.cost)}
                </strong>
              </div>
              <div>
                <small>Рентабельность</small>
                <strong>
                  {selected.revenue ? pct(((selected.revenue - selected.cost) / selected.revenue) * 100) : '—'}
                </strong>
              </div>
            </div>
            <div className="modal-issue">
              <AlertTriangle size={18} />
              <div>
                <strong>Требует внимания</strong>
                <p>{selected.issue}</p>
                <small>
                  Демонстрационные данные. Источники и формулы не подключены.
                </small>
              </div>
            </div>
            <button
              className="btn-primary full-btn"
              onClick={() => {
                setPage('checks');
                setSelected(null);
              }}
            >
              Проверить с помощью ИИ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function Kpi({
  label,
  value,
  change,
  trend,
  note,
  color,
}: {
  label: string;
  value: string;
  change: string;
  trend: string;
  note: string;
  color: string;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-head">
        <span>{label}</span>
        <span className={'kpi-icon ' + color}>
          {color === 'blue'
            ? '₽'
            : color === 'orange'
              ? '↗'
              : color === 'green'
                ? '✓'
                : '%'}
        </span>
      </div>
      <strong className="kpi-value">{value}</strong>
      <div className="kpi-foot">
        <span className={'trend ' + trend}>
          {trend === 'up' ? (
            <ArrowUpRight size={14} />
          ) : trend === 'down' ? (
            <ArrowDownRight size={14} />
          ) : null}{' '}
          {change}
        </span>
        <span>{note}</span>
      </div>
    </div>
  );
}
function Issue({
  level,
  title,
  desc,
}: {
  level: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="issue-card">
      <div
        className={
          'issue-symbol ' +
          (level === 'Критический конфликт'
            ? 'danger'
            : level === 'Высокий риск'
              ? 'warning'
              : 'info')
        }
      >
        <AlertTriangle size={17} />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{desc}</p>
      </div>
      <span
        className={
          'status ' +
          (level === 'Критический конфликт'
            ? 'status-danger'
            : level === 'Высокий риск'
              ? 'status-review'
              : 'status-prelim')
        }
      >
        {level}
      </span>
    </div>
  );
}
function Setting({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{label}</strong>
        <p>{desc}</p>
      </div>
      <CheckCircle2 size={17} className="green-text" />
    </div>
  );
}
export default App;
