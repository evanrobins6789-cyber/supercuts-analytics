import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { loadReport, saveReport, clearReport, isConfigured } from './db';
import { parseStylistReport } from './parser';
import { LEADER_ROSTER_SECTIONS, getLeaderForStoreCode } from './leaderRoster';
import './App.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = n => Number(n || 0).toLocaleString('en-US');
const fmtRate = n => (n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`);
const fmtNum = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));

// Store-level metrics shown on Overview / Stores.
const STORE_METRICS = [
  { key: 'sales', label: 'Net Sales', fmt: fmt$ },
  { key: 'tsth', label: 'TSTH', fmt: fmtRate },
  { key: 'totalHours', label: 'Total Hours', fmt: n => fmtNum(n, 0) },
  { key: 'colorSales', label: 'Color Sales', fmt: fmt$ },
  { key: 'cpc', label: 'CPC', fmt: fmtNum },
  { key: 'retail', label: 'Retail', fmt: fmt$ },
  { key: 'rpc', label: 'RPC', fmt: fmtNum },
];

// Employee-level metrics shown on Employees / By Store.
const EMPLOYEE_METRICS = [
  { key: 'totalHours', label: 'Hours', fmt: n => fmtNum(n, 1) },
  { key: 'sales', label: 'Sales', fmt: fmt$ },
  { key: 'colorSales', label: 'Color Sales', fmt: fmt$ },
  { key: 'retail', label: 'Retail', fmt: fmt$ },
  { key: 'cpc', label: 'CPC', fmt: fmtNum },
  { key: 'rpc', label: 'RPC', fmt: fmtNum },
  { key: 'tsth', label: 'TSTH', fmt: fmtRate },
];

function sortByMetric(rows, key, order = 'desc') {
  const arr = [...rows];
  if (key === 'name' || key === 'store') {
    arr.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (order === 'desc' ? -1 : 1));
  } else {
    arr.sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * (order === 'desc' ? -1 : 1));
  }
  return arr;
}

// Re-aggregate a set of already-rolled-up rows (stores, or store totals) one
// level higher (e.g. up to a District Leader). Sums the additive fields and
// recomputes the ratio fields from those sums — never averages ratios directly.
function rollupRows(rows) {
  const sum = key => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalSales = sum('sales');
  const totalHours = sum('totalHours');
  const totalColor = sum('colorSales');
  const totalRetail = sum('retail');
  const totalHaircuts = sum('haircuts');
  return {
    sales: totalSales,
    totalHours,
    colorSales: totalColor,
    retail: totalRetail,
    haircuts: totalHaircuts,
    tsth: totalHours > 0 ? totalSales / totalHours : null,
    cpc: totalHaircuts > 0 ? totalColor / totalHaircuts : null,
    rpc: totalHaircuts > 0 ? totalRetail / totalHaircuts : null,
  };
}

// Groups store rows (each needs a `code` and `name`) under their District
// Leader / Area Supervisor, in the roster's own order. Stores with no match
// in the roster land in a trailing "Unassigned" group instead of vanishing.
function groupStoresByLeader(storeRows) {
  const order = [];
  LEADER_ROSTER_SECTIONS.forEach(sec => sec.leaders.forEach(l => order.push({ name: l.name, role: sec.role })));

  const withLeader = storeRows.map(r => {
    const info = getLeaderForStoreCode(r.code);
    return { ...r, leaderName: info ? info.leaderName : 'Unassigned', role: info ? info.role : 'Unassigned' };
  });

  const byLeader = new Map();
  withLeader.forEach(r => {
    if (!byLeader.has(r.leaderName)) byLeader.set(r.leaderName, []);
    byLeader.get(r.leaderName).push(r);
  });

  const groups = order
    .map(o => ({ leaderName: o.name, role: o.role, stores: byLeader.get(o.name) || [] }))
    .filter(g => g.stores.length > 0);

  if (byLeader.has('Unassigned')) {
    groups.push({ leaderName: 'Unassigned', role: 'Unassigned', stores: byLeader.get('Unassigned') });
  }
  return groups;
}

// ─── Search ─────────────────────────────────────────────────────────────────
function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="search-box">
      <span className="search-icon">⌕</span>
      <input
        type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className="search-input"
      />
      {value && <button className="search-clear" onClick={() => onChange('')}>×</button>}
    </div>
  );
}

// ─── Leaderboard (signature element) ───────────────────────────────────────
function Leaderboard({ rows, metric, formatter, title, count = 8, order = 'desc' }) {
  const ranked = useMemo(() => sortByMetric(rows, metric, order).slice(0, count), [rows, metric, count, order]);
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
      {!ranked.length && <p className="empty-note">No results.</p>}
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
        <p className="upload-slot-title">Stylist Report</p>
        {fileInfo ? (
          <>
            <p className="upload-slot-file">{fileInfo.fileName}</p>
            <p className="upload-slot-sub">{fileInfo.sub}</p>
            <span className="upload-slot-replace">Replace file</span>
          </>
        ) : (
          <p className="upload-slot-hint">Upload this week's store + stylist export</p>
        )}
      </div>
    </label>
  );
}

function UploadTab({ report, uploading, onFile, onClear }) {
  return (
    <div className="tab-content">
      <UploadSlot
        fileInfo={report ? { fileName: report.fileName, sub: `${report.storeCount} stores · ${report.employeeCount} employees · ${fmt$(report.companyTotals.sales)} total sales` } : null}
        uploading={uploading}
        onFile={onFile}
      />
      {report && <button className="btn-ghost btn-danger" onClick={onClear}>Clear this report</button>}
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────
function OverviewTab({ report, selected, onSelect, query, onQuery }) {
  const t = report.companyTotals;
  const metric = STORE_METRICS.find(m => m.key === selected) || STORE_METRICS[0];
  const storeRows = useMemo(() => {
    const rows = report.stores.map(s => ({ name: s.name, code: s.code, ...s.totals }));
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(r => r.name.toLowerCase().includes(q));
  }, [report.stores, query]);

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores…" />
      <p className="section-hint">Tap any metric to see the top 10 and bottom 10 stores for it.</p>
      <div className="summary-grid">
        {STORE_METRICS.map(m => (
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
        <Leaderboard rows={storeRows} metric={metric.key} formatter={metric.fmt} title={`Top 10 — ${metric.label}`} count={10} order="desc" />
        <Leaderboard rows={storeRows} metric={metric.key} formatter={metric.fmt} title={`Bottom 10 — ${metric.label}`} count={10} order="asc" />
      </div>
    </div>
  );
}

// ─── Stores tab ─────────────────────────────────────────────────────────────
function StoresTab({ report, query, onQuery }) {
  const [sortBy, setSortBy] = useState('tsth');
  const rows = useMemo(() => report.stores.map(s => ({ name: s.name, code: s.code, ...s.totals })), [report.stores]);
  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(r => r.name.toLowerCase().includes(q));
  }, [rows, query]);
  const sorted = useMemo(() => sortByMetric(filtered, sortBy, 'desc'), [filtered, sortBy]);

  const chartRows = useMemo(() => sortByMetric(rows, 'sales', 'desc').slice(0, 15), [rows]);
  const chartData = {
    labels: chartRows.map(s => s.name),
    datasets: [{ label: 'TSTH', data: chartRows.map(s => Math.round((s.tsth || 0) * 100) / 100), backgroundColor: '#C23B3B', borderRadius: 4 }],
  };
  const chartOpts = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` TSTH: ${fmtRate(ctx.parsed.x)}` } } },
    scales: {
      x: { grid: { color: 'rgba(20,42,74,0.06)' }, ticks: { color: '#4A5A70', font: { size: 10, family: 'IBM Plex Mono' } } },
      y: { grid: { display: false }, ticks: { color: '#142A4A', font: { size: 11, family: 'Inter' } } },
    },
  };

  const t = report.companyTotals;

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores…" />

      <div className="chart-card">
        <p className="chart-title">TSTH by store (top 15 by sales)</p>
        <div style={{ height: Math.max(240, chartRows.length * 26 + 40) }}>
          <Bar data={chartData} options={chartOpts} />
        </div>
      </div>

      <div className="ledger-head-row">
        <p className="section-label">{filtered.length} of {report.storeCount} stores</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {STORE_METRICS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Store</th>
              <th>Net Sales</th><th>TSTH</th><th>Total Hours</th>
              <th>Color Sales</th><th>CPC</th><th>Retail</th><th>RPC</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => (
              <tr key={s.name}>
                <td className="ledger-name-col">{s.name}</td>
                <td>{fmt$(s.sales)}</td>
                <td className="ledger-rate">{fmtRate(s.tsth)}</td>
                <td>{fmtNum(s.totalHours, 0)}</td>
                <td>{fmt$(s.colorSales)}</td>
                <td>{fmtNum(s.cpc)}</td>
                <td>{fmt$(s.retail)}</td>
                <td>{fmtNum(s.rpc)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="ledger-avg-row">
              <td className="ledger-name-col">Company (weighted)</td>
              <td>{fmt$(t.sales)}</td>
              <td className="ledger-rate">{fmtRate(t.tsth)}</td>
              <td>{fmtNum(t.totalHours, 0)}</td>
              <td>{fmt$(t.colorSales)}</td>
              <td>{fmtNum(t.cpc)}</td>
              <td>{fmt$(t.retail)}</td>
              <td>{fmtNum(t.rpc)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!sorted.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}
      <p className="ledger-footnote">Company row is a true weighted total (e.g. TSTH = total sales ÷ total hours) — ratio metrics are never simply summed or averaged.</p>
    </div>
  );
}

// ─── Employees tab ──────────────────────────────────────────────────────────
function EmployeeTable({ rows, showStoreCol = true, footer = null, footerLabel = 'Total / Avg (weighted)' }) {
  return (
    <div className="ledger-scroll">
      <table className="ledger-table">
        <thead>
          <tr>
            <th className="ledger-name-col">Employee</th>
            {showStoreCol && <th className="ledger-store-col">Store</th>}
            {EMPLOYEE_METRICS.map(m => <th key={m.key}>{m.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={`${e.name}-${e.store}-${i}`}>
              <td className="ledger-name-col">{e.name}</td>
              {showStoreCol && <td className="ledger-store-col">{e.store}</td>}
              {EMPLOYEE_METRICS.map(m => (
                <td key={m.key} className={m.key === 'tsth' ? 'ledger-rate' : ''}>{m.fmt(e[m.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="ledger-avg-row">
              <td className="ledger-name-col">{footerLabel}</td>
              {showStoreCol && <td className="ledger-store-col"></td>}
              {EMPLOYEE_METRICS.map(m => (
                <td key={m.key} className={m.key === 'tsth' ? 'ledger-rate' : ''}>{m.fmt(footer[m.key])}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {!rows.length && <p className="empty-note" style={{ textAlign: 'center', padding: '16px' }}>No employees match your search.</p>}
    </div>
  );
}

function EmployeesTab({ report, query, onQuery }) {
  const [sortBy, setSortBy] = useState('sales');
  const filtered = useMemo(() => {
    if (!query.trim()) return report.allEmployees;
    const q = query.trim().toLowerCase();
    return report.allEmployees.filter(e => e.name.toLowerCase().includes(q) || e.store.toLowerCase().includes(q));
  }, [report.allEmployees, query]);
  const sorted = useMemo(() => sortByMetric(filtered, sortBy, 'desc'), [filtered, sortBy]);
  const activeMetric = EMPLOYEE_METRICS.find(m => m.key === sortBy);

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search employees or stores…" />
      <div className="ledger-head-row">
        <p className="section-label">{filtered.length} of {report.employeeCount} employees</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {[...EMPLOYEE_METRICS, { key: 'name', label: 'Name (A–Z)' }, { key: 'store', label: 'Store (A–Z)' }]
            .map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      {activeMetric && (
        <div className="leaderboard-grid">
          <Leaderboard rows={filtered} metric={activeMetric.key} formatter={activeMetric.fmt} title={`Top 10 — ${activeMetric.label}`} count={10} order="desc" />
          <Leaderboard rows={filtered} metric={activeMetric.key} formatter={activeMetric.fmt} title={`Bottom 10 — ${activeMetric.label}`} count={10} order="asc" />
        </div>
      )}

      <EmployeeTable rows={sorted} showStoreCol />
    </div>
  );
}

// ─── By Store tab ───────────────────────────────────────────────────────────
function ByStoreTab({ report, query, onQuery }) {
  const groups = useMemo(() => {
    if (!query.trim()) return report.stores;
    const q = query.trim().toLowerCase();
    return report.stores
      .map(s => {
        const storeMatches = s.name.toLowerCase().includes(q);
        const emps = storeMatches ? s.employees : s.employees.filter(e => e.name.toLowerCase().includes(q));
        return { ...s, employees: emps };
      })
      .filter(s => s.employees.length > 0);
  }, [report.stores, query]);

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores or employees…" />
      {!groups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No matches for "{query}".</p>}
      {groups.map(s => (
        <div key={s.name} className="store-group">
          <p className="store-group-title">{s.name} <span className="store-group-count">{s.employees.length} employee{s.employees.length !== 1 ? 's' : ''} · {fmt$(s.totals.sales)} · {fmtRate(s.totals.tsth)} TSTH</span></p>
          <EmployeeTable
            rows={sortByMetric(s.employees, 'sales', 'desc')}
            showStoreCol={false}
            footer={s.totals}
            footerLabel="Total / weighted avg"
          />
        </div>
      ))}
    </div>
  );
}

// ─── Single-focus store tabs (Retail, Color Sales) — grouped by DL ─────────
function StoreMetricTab({ report, query, onQuery, title, metricA, metricB }) {
  const [sortBy, setSortBy] = useState(metricA.key);
  const rows = useMemo(() => report.stores.map(s => ({ name: s.name, code: s.code, ...s.totals })), [report.stores]);
  const groups = useMemo(() => groupStoresByLeader(rows), [rows]);

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.trim().toLowerCase();
    return groups
      .map(g => {
        const leaderMatches = g.leaderName.toLowerCase().includes(q);
        const stores = leaderMatches ? g.stores : g.stores.filter(s => s.name.toLowerCase().includes(q));
        return { ...g, stores };
      })
      .filter(g => g.stores.length > 0);
  }, [groups, query]);

  const t = report.companyTotals;
  const totalStoresShown = filteredGroups.reduce((n, g) => n + g.stores.length, 0);

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores or DL…" />
      <div className="ledger-head-row">
        <p className="section-label">{title} — {totalStoresShown} of {report.storeCount} stores, grouped by DL</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value={metricA.key}>Sort: {metricA.label}</option>
          <option value={metricB.key}>Sort: {metricB.label}</option>
          <option value="name">Sort: Name (A–Z)</option>
        </select>
      </div>

      {filteredGroups.map(g => {
        const groupTotals = rollupRows(g.stores);
        const sortedStores = sortByMetric(g.stores, sortBy, 'desc');
        return (
          <div key={g.leaderName} className="store-group">
            <p className="store-group-title">
              {g.leaderName} <span className="store-group-count">{g.role} · {g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
            </p>
            <div className="ledger-scroll">
              <table className="ledger-table">
                <thead>
                  <tr><th className="ledger-name-col">Store</th><th>{metricA.label}</th><th>{metricB.label}</th></tr>
                </thead>
                <tbody>
                  {sortedStores.map(s => (
                    <tr key={s.name}>
                      <td className="ledger-name-col">{s.name}</td>
                      <td>{metricA.fmt(s[metricA.key])}</td>
                      <td>{metricB.fmt(s[metricB.key])}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="ledger-avg-row">
                    <td className="ledger-name-col">{g.leaderName} total / weighted avg</td>
                    <td>{metricA.fmt(groupTotals[metricA.key])}</td>
                    <td>{metricB.fmt(groupTotals[metricB.key])}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}

      {!filteredGroups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}

      <div className="ledger-scroll">
        <table className="ledger-table">
          <tfoot>
            <tr className="ledger-avg-row">
              <td className="ledger-name-col">Company (weighted)</td>
              <td>{metricA.fmt(t[metricA.key])}</td>
              <td>{metricB.fmt(t[metricB.key])}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── DL tab ─────────────────────────────────────────────────────────────────
function DLTab({ report, query, onQuery }) {
  const [expanded, setExpanded] = useState({});
  const rows = useMemo(() => report.stores.map(s => ({ name: s.name, code: s.code, ...s.totals })), [report.stores]);
  const groups = useMemo(() => groupStoresByLeader(rows), [rows]);

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.trim().toLowerCase();
    return groups
      .map(g => {
        const leaderMatches = g.leaderName.toLowerCase().includes(q);
        const stores = leaderMatches ? g.stores : g.stores.filter(s => s.name.toLowerCase().includes(q));
        return { ...g, stores };
      })
      .filter(g => g.stores.length > 0);
  }, [groups, query]);

  const grouped = useMemo(() => {
    const byRole = new Map();
    filteredGroups.forEach(g => {
      if (!byRole.has(g.role)) byRole.set(g.role, []);
      byRole.get(g.role).push(g);
    });
    return Array.from(byRole.entries());
  }, [filteredGroups]);

  const toggle = name => setExpanded(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search DLs or stores…" />
      {!filteredGroups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No matches for "{query}".</p>}

      {grouped.map(([role, roleGroups]) => (
        <div key={role}>
          <p className="section-label" style={{ marginBottom: 4 }}>{role}</p>
          <div className="dl-list">
            {roleGroups.map(g => {
              const t = rollupRows(g.stores);
              const isOpen = !!expanded[g.leaderName];
              return (
                <div key={g.leaderName} className="dl-card">
                  <button className="dl-card-head" onClick={() => toggle(g.leaderName)}>
                    <div className="dl-card-name-wrap">
                      <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
                      <span className="dl-card-name">{g.leaderName}</span>
                      <span className="dl-card-count">{g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="dl-card-stats">
                      <div className="dl-stat"><span className="dl-stat-label">Sales</span><span className="dl-stat-value">{fmt$(t.sales)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className="dl-stat-value">{fmtRate(t.tsth)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(t.totalHours, 0)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(t.colorSales)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(t.cpc)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(t.retail)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(t.rpc)}</span></div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="ledger-scroll dl-store-table">
                      <table className="ledger-table">
                        <thead>
                          <tr>
                            <th className="ledger-name-col">Store</th>
                            <th>Sales</th><th>TSTH</th><th>Total Hours</th><th>Color Sales</th><th>CPC</th><th>Retail</th><th>RPC</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortByMetric(g.stores, 'sales', 'desc').map(s => (
                            <tr key={s.name}>
                              <td className="ledger-name-col">{s.name}</td>
                              <td>{fmt$(s.sales)}</td>
                              <td className="ledger-rate">{fmtRate(s.tsth)}</td>
                              <td>{fmtNum(s.totalHours, 0)}</td>
                              <td>{fmt$(s.colorSales)}</td>
                              <td>{fmtNum(s.cpc)}</td>
                              <td>{fmt$(s.retail)}</td>
                              <td>{fmtNum(s.rpc)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Setup tab ──────────────────────────────────────────────────────────────
function SetupTab({ configured }) {
  const steps = [
    { n: 1, title: 'Export this week\u2019s stylist report', body: 'Run the report with every store and every employee under it, covering the week you want to see.' },
    { n: 2, title: 'Upload it', body: 'Go to the Upload tab and drop the file in. The date range fills in automatically from the file.' },
    { n: 3, title: 'Explore the tabs', body: 'Overview: tap a metric to see the top/bottom 10 stores. Stores: every location side by side. Employees: every stylist, sortable, searchable. By Store: employees grouped under their store. Every tab has a search box.' },
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
const TABS = ['Overview', 'Stores', 'Employees', 'By Store', 'Retail', 'Color Sales', 'DL', 'Upload', 'Setup'];

export default function App() {
  const [report, setReport] = useState(null);
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('tsth');
  const [queries, setQueries] = useState({ Overview: '', Stores: '', Employees: '', 'By Store': '', Retail: '', 'Color Sales': '', DL: '' });

  useEffect(() => {
    loadReport().then(({ data, source, error }) => {
      if (data) { setReport(data); } else { setTab('Upload'); }
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

  const setQuery = (tabName, val) => setQueries(prev => ({ ...prev, [tabName]: val }));

  const handleFile = useCallback(async file => {
    setUploading(true);
    try {
      const parsed = await parseStylistReport(file);
      setReport(parsed);
      setLabel(parsed.dateRangeLabel || '');
      const result = await saveReport(parsed);
      if (isConfigured() && !result.ok) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
      } else {
        showToast(`Loaded ${file.name} — ${parsed.storeCount} stores, ${parsed.employeeCount} employees`);
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

  const needsReport = !report && tab !== 'Upload' && tab !== 'Setup';

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
        {needsReport && <div className="empty-state"><p className="empty-title">No report yet</p><p>Go to the Upload tab to add this week's report.</p></div>}
        {!needsReport && tab === 'Overview' && report && (
          <OverviewTab report={report} selected={selectedMetric} onSelect={setSelectedMetric} query={queries.Overview} onQuery={v => setQuery('Overview', v)} />
        )}
        {!needsReport && tab === 'Stores' && report && (
          <StoresTab report={report} query={queries.Stores} onQuery={v => setQuery('Stores', v)} />
        )}
        {!needsReport && tab === 'Employees' && report && (
          <EmployeesTab report={report} query={queries.Employees} onQuery={v => setQuery('Employees', v)} />
        )}
        {!needsReport && tab === 'By Store' && report && (
          <ByStoreTab report={report} query={queries['By Store']} onQuery={v => setQuery('By Store', v)} />
        )}
        {!needsReport && tab === 'Retail' && report && (
          <StoreMetricTab
            report={report} query={queries.Retail} onQuery={v => setQuery('Retail', v)}
            title="Retail" metricA={{ key: 'retail', label: 'Retail', fmt: fmt$ }} metricB={{ key: 'rpc', label: 'RPC', fmt: fmtNum }}
          />
        )}
        {!needsReport && tab === 'Color Sales' && report && (
          <StoreMetricTab
            report={report} query={queries['Color Sales']} onQuery={v => setQuery('Color Sales', v)}
            title="Color Sales" metricA={{ key: 'colorSales', label: 'Color Sales', fmt: fmt$ }} metricB={{ key: 'cpc', label: 'CPC', fmt: fmtNum }}
          />
        )}
        {!needsReport && tab === 'DL' && report && (
          <DLTab report={report} query={queries.DL} onQuery={v => setQuery('DL', v)} />
        )}
        {tab === 'Upload' && <UploadTab report={report} uploading={uploading} onFile={handleFile} onClear={handleClearAll} />}
        {tab === 'Setup' && <SetupTab configured={isConfigured()} />}
      </main>
    </div>
  );
}
