import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { loadReport, saveReport, clearReport, isConfigured } from './db';
import { parseWeeklyReport } from './parser';
import './App.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = n => Number(n || 0).toLocaleString('en-US');
const fmtRate = n => (n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`);
const fmtNum = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));

// The 8 metrics the site focuses on, in display order.
const METRICS = [
  { key: 'visits', label: 'Guest Count', fmt: fmtInt },
  { key: 'netSales', label: 'Net Sales', fmt: fmt$ },
  { key: 'tsth', label: 'TSTH', fmt: fmtRate },
  { key: 'totalHours', label: 'Total Hours', fmt: n => fmtNum(n, 0) },
  { key: 'colorNet', label: 'Color Net', fmt: fmt$ },
  { key: 'cpc', label: 'CPC', fmt: fmtNum },
  { key: 'productNet', label: 'Product Net', fmt: fmt$ },
  { key: 'rpc', label: 'RPC', fmt: fmtNum },
];

const SORT_OPTIONS = [
  ...METRICS.map(m => ({ value: m.key, label: m.label })),
  { value: 'name', label: 'Name (A–Z)' },
];

function sortStores(stores, key, order = 'desc') {
  const arr = [...stores];
  if (key === 'name') {
    arr.sort((a, b) => a.name.localeCompare(b.name) * (order === 'desc' ? -1 : 1));
  } else {
    arr.sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * (order === 'desc' ? -1 : 1));
  }
  return arr;
}

// ─── Leaderboard (signature element) ───────────────────────────────────────
function Leaderboard({ stores, metric, formatter, title, count = 8, order = 'desc' }) {
  const ranked = useMemo(() => sortStores(stores, metric, order).slice(0, count), [stores, metric, count, order]);
  const maxVal = Math.max(...ranked.map(s => Math.abs(s[metric] || 0)), 1);
  const medalClass = i => {
    if (order !== 'desc') return 'rank-plain';
    return i === 0 ? 'rank-gold' : i === 1 ? 'rank-silver' : i === 2 ? 'rank-bronze' : 'rank-plain';
  };

  return (
    <div className="leaderboard">
      <p className="leaderboard-title">{title}</p>
      {ranked.map((s, i) => (
        <div className="leaderboard-row" key={s.name}>
          <div className={`rank-badge ${medalClass(i)}`}>{i + 1}</div>
          <div className="leaderboard-body">
            <div className="leaderboard-row-head">
              <span className="leaderboard-name">{s.name}</span>
              <span className="leaderboard-value">{formatter(s[metric])}</span>
            </div>
            <div className="leaderboard-bar-track">
              <div className="leaderboard-bar-fill" style={{ width: `${Math.max(4, (Math.abs(s[metric] || 0) / maxVal) * 100)}%` }} />
            </div>
          </div>
        </div>
      ))}
      {!ranked.length && <p className="empty-note">No stores to rank yet.</p>}
    </div>
  );
}

// ─── Upload ─────────────────────────────────────────────────────────────────
function UploadSlot({ fileInfo, uploading, onFile }) {
  return (
    <label htmlFor="weekly-report-file" className={`upload-slot ${fileInfo ? 'upload-slot--filled' : ''}`}>
      <input
        id="weekly-report-file" type="file" accept=".xlsx,.xls,.csv"
        onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
      <div className="upload-slot-icon">{uploading ? <span className="spinner small" /> : (fileInfo ? '✓' : '+')}</div>
      <div className="upload-slot-body">
        <p className="upload-slot-title">Weekly Report</p>
        {fileInfo ? (
          <>
            <p className="upload-slot-file">{fileInfo.fileName}</p>
            <p className="upload-slot-sub">{fileInfo.sub}</p>
            <span className="upload-slot-replace">Replace file</span>
          </>
        ) : (
          <p className="upload-slot-hint">Upload this week's store performance export</p>
        )}
      </div>
    </label>
  );
}

function UploadTab({ report, uploading, onFile, onClear }) {
  return (
    <div className="tab-content">
      <UploadSlot
        fileInfo={report ? { fileName: report.fileName, sub: `${report.storeCount} stores · ${fmt$(report.totals.netSales)} total net sales` } : null}
        uploading={uploading}
        onFile={onFile}
      />
      {report && (
        <button className="btn-ghost btn-danger" onClick={onClear}>Clear this report</button>
      )}
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────
function OverviewTab({ report, selected, onSelect }) {
  const t = report.totals;
  const metric = METRICS.find(m => m.key === selected) || METRICS[0];

  return (
    <div className="tab-content">
      <p className="section-hint">Tap any metric to see the top 10 and bottom 10 stores for it.</p>
      <div className="summary-grid">
        {METRICS.map(m => (
          <button
            key={m.key}
            className={`summary-tile ${selected === m.key ? 'summary-tile--active' : ''}`}
            onClick={() => onSelect(m.key)}
          >
            <p className="summary-tile-label">{m.label}</p>
            <p className="summary-tile-value">{m.fmt(t[m.key])}</p>
          </button>
        ))}
      </div>

      <div className="leaderboard-grid">
        <Leaderboard stores={report.stores} metric={metric.key} formatter={metric.fmt} title={`Top 10 — ${metric.label}`} count={10} order="desc" />
        <Leaderboard stores={report.stores} metric={metric.key} formatter={metric.fmt} title={`Bottom 10 — ${metric.label}`} count={10} order="asc" />
      </div>
    </div>
  );
}

// ─── Stores tab ─────────────────────────────────────────────────────────────
function StoresTab({ report }) {
  const [sortBy, setSortBy] = useState('tsth');
  const sorted = useMemo(() => sortStores(report.stores, sortBy, 'desc'), [report.stores, sortBy]);

  const chartRows = useMemo(() => sortStores(report.stores, 'netSales', 'desc').slice(0, 15), [report.stores]);
  const chartData = {
    labels: chartRows.map(s => s.name),
    datasets: [{ label: 'TSTH', data: chartRows.map(s => Math.round(s.tsth * 100) / 100), backgroundColor: '#C23B3B', borderRadius: 4 }],
  };
  const chartOpts = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => ` TSTH: ${fmtRate(ctx.parsed.x)}` } },
    },
    scales: {
      x: { grid: { color: 'rgba(20,42,74,0.06)' }, ticks: { color: '#4A5A70', font: { size: 10, family: 'IBM Plex Mono' } } },
      y: { grid: { display: false }, ticks: { color: '#142A4A', font: { size: 11, family: 'Inter' } } },
    },
  };

  const t = report.totals;

  return (
    <div className="tab-content">
      <div className="chart-card">
        <p className="chart-title">TSTH by store (top 15 by net sales)</p>
        <div style={{ height: Math.max(240, chartRows.length * 26 + 40) }}>
          <Bar data={chartData} options={chartOpts} />
        </div>
      </div>

      <div className="ledger-head-row">
        <p className="section-label">All {report.storeCount} stores</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
      </div>

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Store</th>
              <th>Guest Count</th><th>Net Sales</th><th>TSTH</th><th>Total Hours</th>
              <th>Color Net</th><th>CPC</th><th>Product Net</th><th>RPC</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => (
              <tr key={s.name}>
                <td className="ledger-name-col">{s.name}</td>
                <td>{fmtInt(s.visits)}</td>
                <td>{fmt$(s.netSales)}</td>
                <td className="ledger-rate">{fmtRate(s.tsth)}</td>
                <td>{fmtNum(s.totalHours, 0)}</td>
                <td>{fmt$(s.colorNet)}</td>
                <td>{fmtNum(s.cpc)}</td>
                <td>{fmt$(s.productNet)}</td>
                <td>{fmtNum(s.rpc)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="ledger-avg-row">
              <td className="ledger-name-col">Company (weighted)</td>
              <td>{fmtInt(t.visits)}</td>
              <td>{fmt$(t.netSales)}</td>
              <td className="ledger-rate">{fmtRate(t.tsth)}</td>
              <td>{fmtNum(t.totalHours, 0)}</td>
              <td>{fmt$(t.colorNet)}</td>
              <td>{fmtNum(t.cpc)}</td>
              <td>{fmt$(t.productNet)}</td>
              <td>{fmtNum(t.rpc)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="ledger-footnote">Company row is a true weighted total (e.g. TSTH = total net sales ÷ total hours) — not a plain average of each store's TSTH, which would overweight small stores. Ratio metrics (TSTH, CPC, RPC) are never simply summed.</p>
    </div>
  );
}

// ─── Setup tab ──────────────────────────────────────────────────────────────
function SetupTab({ configured }) {
  const steps = [
    { n: 1, title: 'Export this week\u2019s report', body: 'Run your weekly store performance report — one row per store, covering the week you want to see.' },
    { n: 2, title: 'Upload it', body: 'Go to the Upload tab and drop the file in. The date range fills in automatically from the file.' },
    { n: 3, title: 'Read the scoreboard', body: 'Overview lets you tap any of 8 key metrics to see the top 10 and bottom 10 stores for it. Stores shows every location side by side, sortable by any column.' },
    { n: 4, title: 'Next week', body: 'Just upload the new file the same way \u2014 it replaces this week\u2019s data for everyone viewing the site.' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className={`setup-status ${configured ? 'setup-status--ok' : 'setup-status--warn'}`}>
        {configured
          ? '✓ Connected to Supabase — your data syncs across devices.'
          : '⚠ Supabase not connected — data is only saved on this device.'}
      </div>
      <div className="setup-section">
        {steps.map(s => (
          <div key={s.n} className="setup-step">
            <div className="step-num">{s.n}</div>
            <div><p className="step-title">{s.title}</p><p className="step-body">{s.body}</p></div>
          </div>
        ))}
      </div>
      {!configured && (
        <div className="setup-sql-card">
          <p className="chart-title">One-time Supabase setup</p>
          <p className="step-body">Create a table called <code>weekly_report</code> by running this in the Supabase SQL Editor:</p>
          <pre className="setup-sql">{`create table weekly_report (
  report_id text primary key,
  payload jsonb not null,
  updated_at timestamp with time zone default now()
);

alter table weekly_report enable row level security;

create policy "Allow all access"
  on weekly_report for all
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on weekly_report to anon, authenticated;`}</pre>
          <p className="step-body">Then add <code>REACT_APP_SUPABASE_URL</code> and <code>REACT_APP_SUPABASE_ANON_KEY</code> as environment variables in Vercel, using the values from Supabase → Settings → API.</p>
        </div>
      )}
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Stores', 'Upload', 'Setup'];

export default function App() {
  const [report, setReport] = useState(null);
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('tsth');

  useEffect(() => {
    loadReport().then(({ data, source, error }) => {
      if (data) {
        setReport(data);
      } else {
        setTab('Upload');
      }
      setLoading(false);
      if (isConfigured() && source === 'local') {
        showToast(`Couldn't reach Supabase (${error || 'unknown error'}) — showing this device's local data only`, 'error');
      }
    }).catch(() => setLoading(false));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFile = useCallback(async file => {
    setUploading(true);
    try {
      const parsed = await parseWeeklyReport(file);
      setReport(parsed);
      setLabel(parsed.dateRangeLabel || '');
      const result = await saveReport(parsed);
      if (isConfigured() && !result.ok) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
      } else {
        showToast(`Loaded ${file.name} — ${parsed.storeCount} stores found`);
      }
      setTab('Overview');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleClearAll = async () => {
    if (!window.confirm('Clear the uploaded report and start over? This cannot be undone.')) return;
    await clearReport();
    setReport(null);
    setLabel('');
    setTab('Upload');
    showToast('Report cleared');
  };

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Store Scoreboard</h1>
          <p className="app-subtitle">{label || 'Weekly performance across every location'}</p>
        </div>
      </header>

      <nav className="tab-nav">
        {TABS.map(t => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <main className="app-main">
        {tab === 'Overview' && (report
          ? <OverviewTab report={report} selected={selectedMetric} onSelect={setSelectedMetric} />
          : <div className="empty-state"><p className="empty-title">No report yet</p><p>Go to the Upload tab to add this week's report.</p></div>)}
        {tab === 'Stores' && (report
          ? <StoresTab report={report} />
          : <div className="empty-state"><p className="empty-title">No report yet</p><p>Go to the Upload tab to add this week's report.</p></div>)}
        {tab === 'Upload' && <UploadTab report={report} uploading={uploading} onFile={handleFile} onClear={handleClearAll} />}
        {tab === 'Setup' && <SetupTab configured={isConfigured()} />}
      </main>
    </div>
  );
}
