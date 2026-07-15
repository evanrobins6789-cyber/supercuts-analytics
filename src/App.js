import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { loadData, saveData, clearData, isConfigured } from './db';
import { parseStylistReport, parseEmployeeStartDates, parseGoalFile, normalizeName } from './parser';
import { LEADER_ROSTER_SECTIONS, getLeaderForStoreCode } from './leaderRoster';
import { getCodeForStoreName } from './storeDirectory';
import './App.css';

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

// Employee-level metrics shown on Employees and within each Stores card.
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
function UploadSlot({ id, title, hint, fileInfo, uploading, onFile }) {
  return (
    <label htmlFor={id} className={`upload-slot ${fileInfo ? 'upload-slot--filled' : ''}`}>
      <input
        id={id} type="file" accept=".xlsx,.xls,.csv"
        onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
      <div className="upload-slot-icon">{uploading ? <span className="spinner small" /> : (fileInfo ? '✓' : '+')}</div>
      <div className="upload-slot-body">
        <p className="upload-slot-title">{title}</p>
        {fileInfo ? (
          <>
            <p className="upload-slot-file">{fileInfo.fileName}</p>
            <p className="upload-slot-sub">{fileInfo.sub}</p>
            <span className="upload-slot-replace">Replace file</span>
          </>
        ) : (
          <p className="upload-slot-hint">{hint}</p>
        )}
      </div>
    </label>
  );
}

function UploadTab({ report, uploading, onFile, onClear, employeeRoster, uploadingRoster, onRosterFile, onClearRoster }) {
  return (
    <div className="tab-content">
      <UploadSlot
        id="weekly-report-file" title="Stylist Report" hint="Upload this week's store + stylist export"
        fileInfo={report ? { fileName: report.fileName, sub: `${report.storeCount} stores · ${report.employeeCount} employees · ${fmt$(report.companyTotals.sales)} total sales` } : null}
        uploading={uploading}
        onFile={onFile}
      />
      {report && <button className="btn-ghost btn-danger" onClick={onClear}>Clear stylist report</button>}

      <UploadSlot
        id="employee-start-file" title="Employee Start Dates" hint="Upload the employee name + start date export"
        fileInfo={employeeRoster ? { fileName: employeeRoster.fileName, sub: `${employeeRoster.employees.length} employees on file` } : null}
        uploading={uploadingRoster}
        onFile={onRosterFile}
      />
      {employeeRoster && <button className="btn-ghost btn-danger" onClick={onClearRoster}>Clear start-date list</button>}
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
  const [expanded, setExpanded] = useState({});
  const storeRows = useMemo(() => report.stores.map(s => ({ name: s.name, code: s.code, employees: s.employees, ...s.totals })), [report.stores]);

  const isSearching = !!query.trim();
  const filtered = useMemo(() => {
    if (!isSearching) return storeRows;
    const q = query.trim().toLowerCase();
    return storeRows
      .map(s => {
        const storeMatches = s.name.toLowerCase().includes(q);
        const employees = storeMatches ? s.employees : s.employees.filter(e => e.name.toLowerCase().includes(q));
        return { ...s, employees, _matched: storeMatches || employees.length > 0 };
      })
      .filter(s => s._matched);
  }, [storeRows, query, isSearching]);
  const sorted = useMemo(() => sortByMetric(filtered, sortBy, 'desc'), [filtered, sortBy]);

  const t = report.companyTotals;
  const toggle = name => setExpanded(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores or employees…" />

      <div className="ledger-head-row">
        <p className="section-label">{filtered.length} of {report.storeCount} stores</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {STORE_METRICS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      <div className="dl-list">
        {sorted.map(s => {
          const isOpen = isSearching || !!expanded[s.name];
          return (
            <div key={s.name} className="dl-card">
              <button className="dl-card-head" onClick={() => toggle(s.name)}>
                <div className="dl-card-name-wrap">
                  <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
                  <span className="dl-card-name">{s.name}</span>
                  <span className="dl-card-count">{s.employees.length} employee{s.employees.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="dl-card-stats">
                  <div className="dl-stat"><span className="dl-stat-label">Sales</span><span className="dl-stat-value">{fmt$(s.sales)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className="dl-stat-value">{fmtRate(s.tsth)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(s.totalHours, 0)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(s.colorSales)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(s.cpc)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(s.retail)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(s.rpc)}</span></div>
                </div>
              </button>
              {isOpen && (
                <div className="dl-store-table">
                  <EmployeeTable
                    rows={sortByMetric(s.employees, 'sales', 'desc')}
                    showStoreCol={false}
                    footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours }}
                    footerLabel="Store total / weighted avg"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!sorted.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}

      <div className="ledger-scroll">
        <table className="ledger-table">
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

// ─── Single-focus store tabs (Retail, Color Sales) — grouped by DL ─────────
function StoreMetricTab({ report, query, onQuery, title, metricA, metricB, goalType, goals }) {
  const [sortBy, setSortBy] = useState(metricA.key);
  const [viewMode, setViewMode] = useState('dl'); // 'dl' | 'flat'
  const [expanded, setExpanded] = useState({});
  const rows = useMemo(() => report.stores.map(s => ({ name: s.name, code: s.code, employees: s.employees, ...s.totals })), [report.stores]);
  const groups = useMemo(() => groupStoresByLeader(rows), [rows]);
  const toggleStore = code => setExpanded(prev => ({ ...prev, [code]: !prev[code] }));

  const getGoal = code => (goalType && goals?.[code]?.[goalType] != null ? goals[code][goalType] : null);
  const showGoals = !!goalType;
  const colCount = 3 + (showGoals ? 2 : 0);

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

  const filteredFlat = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(r => r.name.toLowerCase().includes(q));
  }, [rows, query]);
  const sortedFlat = useMemo(() => sortByMetric(filteredFlat, sortBy, 'desc'), [filteredFlat, sortBy]);

  const t = report.companyTotals;
  const totalStoresShown = viewMode === 'dl'
    ? filteredGroups.reduce((n, g) => n + g.stores.length, 0)
    : filteredFlat.length;

  const groupGoalTotal = storesArr => storesArr.reduce((s, st) => s + (getGoal(st.code) ?? 0), 0);
  const companyGoalTotal = rows.reduce((s, st) => s + (getGoal(st.code) ?? 0), 0);

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder={viewMode === 'dl' ? 'Search stores or DL…' : 'Search stores…'} />

      <div className="view-toggle">
        <button className={`view-toggle-btn ${viewMode === 'dl' ? 'active' : ''}`} onClick={() => setViewMode('dl')}>Grouped by DL</button>
        <button className={`view-toggle-btn ${viewMode === 'flat' ? 'active' : ''}`} onClick={() => setViewMode('flat')}>All Stores</button>
      </div>

      <div className="ledger-head-row">
        <p className="section-label">{title} — {totalStoresShown} of {report.storeCount} stores{viewMode === 'dl' ? ', grouped by DL' : ''}</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value={metricA.key}>Sort: {metricA.label}</option>
          <option value={metricB.key}>Sort: {metricB.label}</option>
          <option value="name">Sort: Name (A–Z)</option>
        </select>
      </div>

      {viewMode === 'dl' && filteredGroups.map(g => {
        const groupTotals = rollupRows(g.stores);
        const sortedStores = sortByMetric(g.stores, sortBy, 'desc');
        const goalTotal = groupGoalTotal(g.stores);
        return (
          <div key={g.leaderName} className="store-group">
            <p className="store-group-title">
              {g.leaderName} <span className="store-group-count">{g.role} · {g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
            </p>
            <div className="ledger-scroll">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="ledger-name-col">Store</th><th>{metricA.label}</th><th>{metricB.label}</th>
                    {showGoals && <><th>Goal</th><th>vs Goal</th></>}
                  </tr>
                </thead>
                <tbody>
                  {sortedStores.map(s => {
                    const goal = getGoal(s.code);
                    const diff = goal != null ? s[metricA.key] - goal : null;
                    const isOpen = !!expanded[s.code];
                    return (
                      <React.Fragment key={s.name}>
                        <tr className="store-row-clickable" onClick={() => toggleStore(s.code)}>
                          <td className="ledger-name-col">
                            <span className={`mini-chevron ${isOpen ? 'mini-chevron--open' : ''}`}>▸</span> {s.name}
                          </td>
                          <td>{metricA.fmt(s[metricA.key])}</td>
                          <td>{metricB.fmt(s[metricB.key])}</td>
                          {showGoals && (
                            <>
                              <td>{goal != null ? fmt$(goal) : '—'}</td>
                              <td className={diff != null && diff < 0 ? 'ledger-margin-neg' : ''}>{diff != null ? `${diff >= 0 ? '+' : ''}${fmt$(diff)}` : '—'}</td>
                            </>
                          )}
                        </tr>
                        {isOpen && (
                          <tr className="store-expand-row">
                            <td colSpan={colCount}>
                              <EmployeeTable
                                rows={sortByMetric(s.employees, 'sales', 'desc')}
                                showStoreCol={false}
                                footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours }}
                                footerLabel="Store total / weighted avg"
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="ledger-avg-row">
                    <td className="ledger-name-col">{g.leaderName} total / weighted avg</td>
                    <td>{metricA.fmt(groupTotals[metricA.key])}</td>
                    <td>{metricB.fmt(groupTotals[metricB.key])}</td>
                    {showGoals && (
                      <>
                        <td>{goalTotal > 0 ? fmt$(goalTotal) : '—'}</td>
                        <td className={goalTotal > 0 && groupTotals[metricA.key] - goalTotal < 0 ? 'ledger-margin-neg' : ''}>
                          {goalTotal > 0 ? `${groupTotals[metricA.key] - goalTotal >= 0 ? '+' : ''}${fmt$(groupTotals[metricA.key] - goalTotal)}` : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}

      {viewMode === 'flat' && (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="ledger-name-col">Store</th><th>{metricA.label}</th><th>{metricB.label}</th>
                {showGoals && <><th>Goal</th><th>vs Goal</th></>}
              </tr>
            </thead>
            <tbody>
              {sortedFlat.map(s => {
                const goal = getGoal(s.code);
                const diff = goal != null ? s[metricA.key] - goal : null;
                const isOpen = !!expanded[s.code];
                return (
                  <React.Fragment key={s.name}>
                    <tr className="store-row-clickable" onClick={() => toggleStore(s.code)}>
                      <td className="ledger-name-col">
                        <span className={`mini-chevron ${isOpen ? 'mini-chevron--open' : ''}`}>▸</span> {s.name}
                      </td>
                      <td>{metricA.fmt(s[metricA.key])}</td>
                      <td>{metricB.fmt(s[metricB.key])}</td>
                      {showGoals && (
                        <>
                          <td>{goal != null ? fmt$(goal) : '—'}</td>
                          <td className={diff != null && diff < 0 ? 'ledger-margin-neg' : ''}>{diff != null ? `${diff >= 0 ? '+' : ''}${fmt$(diff)}` : '—'}</td>
                        </>
                      )}
                    </tr>
                    {isOpen && (
                      <tr className="store-expand-row">
                        <td colSpan={colCount}>
                          <EmployeeTable
                            rows={sortByMetric(s.employees, 'sales', 'desc')}
                            showStoreCol={false}
                            footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours }}
                            footerLabel="Store total / weighted avg"
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="ledger-avg-row">
                <td className="ledger-name-col">Company (weighted)</td>
                <td>{metricA.fmt(t[metricA.key])}</td>
                <td>{metricB.fmt(t[metricB.key])}</td>
                {showGoals && (
                  <>
                    <td>{companyGoalTotal > 0 ? fmt$(companyGoalTotal) : '—'}</td>
                    <td className={companyGoalTotal > 0 && t[metricA.key] - companyGoalTotal < 0 ? 'ledger-margin-neg' : ''}>
                      {companyGoalTotal > 0 ? `${t[metricA.key] - companyGoalTotal >= 0 ? '+' : ''}${fmt$(t[metricA.key] - companyGoalTotal)}` : '—'}
                    </td>
                  </>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {viewMode === 'dl' && !filteredGroups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}
      {viewMode === 'flat' && !sortedFlat.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}

      {viewMode === 'dl' && (
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
      )}
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

// ─── 60 Day Employee tab ────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;

function buildNewHireRows(report, employeeRoster) {
  const now = Date.now();
  const byName = new Map();
  if (report) {
    report.allEmployees.forEach(e => byName.set(normalizeName(e.name), e));
  }
  const codeToStore = new Map();
  if (report) {
    report.stores.forEach(s => codeToStore.set(s.code, s));
  }

  const rows = [];
  (employeeRoster?.employees || []).forEach(e => {
    const start = new Date(e.startDate).getTime();
    const daysAgo = Math.floor((now - start) / DAY_MS);
    if (daysAgo < 0 || daysAgo > 60) return;

    const match = byName.get(normalizeName(e.name));
    let storeName = null, leaderInfo = null, metrics = {};
    if (match) {
      storeName = match.store;
      const storeObj = report.stores.find(s => s.name === match.store);
      leaderInfo = storeObj ? getLeaderForStoreCode(storeObj.code) : null;
      metrics = match;
    }

    rows.push({
      name: e.name,
      startDate: e.startDate,
      daysAgo,
      store: storeName,
      dl: leaderInfo ? leaderInfo.leaderName : null,
      matched: !!match,
      sales: metrics.sales ?? null,
      colorSales: metrics.colorSales ?? null,
      retail: metrics.retail ?? null,
      cpc: metrics.cpc ?? null,
      rpc: metrics.rpc ?? null,
      tsth: metrics.tsth ?? null,
      totalHours: metrics.totalHours ?? null,
    });
  });
  return rows;
}

const NEW_HIRE_SORT_OPTIONS = [
  { key: 'daysAgo', label: 'Newest first' },
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'store', label: 'Store (A–Z)' },
  { key: 'sales', label: 'Sales' },
  { key: 'tsth', label: 'TSTH' },
];

function NewHireTab({ report, employeeRoster, query, onQuery }) {
  const [sortBy, setSortBy] = useState('daysAgo');
  const rows = useMemo(() => buildNewHireRows(report, employeeRoster), [report, employeeRoster]);
  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.store || '').toLowerCase().includes(q) ||
      (r.dl || '').toLowerCase().includes(q)
    );
  }, [rows, query]);
  const sorted = useMemo(() => {
    if (sortBy === 'daysAgo') return [...filtered].sort((a, b) => a.daysAgo - b.daysAgo);
    return sortByMetric(filtered, sortBy, sortBy === 'name' || sortBy === 'store' ? 'asc' : 'desc');
  }, [filtered, sortBy]);

  const unmatchedCount = filtered.filter(r => !r.matched).length;

  if (!employeeRoster) {
    return (
      <div className="empty-state">
        <p className="empty-title">No employee start-date file uploaded</p>
        <p>Go to the Upload tab and add the "Employee Start Dates" file to see who's new.</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={onQuery} placeholder="Search employees, stores, or DL…" />
      <div className="ledger-head-row">
        <p className="section-label">{filtered.length} employee{filtered.length !== 1 ? 's' : ''} hired in the last 60 days</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {NEW_HIRE_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Employee</th>
              <th>Start Date</th><th>Days</th>
              <th className="ledger-store-col">Store</th><th className="ledger-store-col">DL</th>
              <th>Sales</th><th>Color Sales</th><th>Retail</th><th>CPC</th><th>RPC</th><th>TSTH</th><th>Hours</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.name}-${i}`}>
                <td className="ledger-name-col">{r.name}</td>
                <td>{new Date(r.startDate).toLocaleDateString('en-US')}</td>
                <td>{r.daysAgo}</td>
                <td className="ledger-store-col">{r.store || '—'}</td>
                <td className="ledger-store-col">{r.dl || '—'}</td>
                <td>{r.sales != null ? fmt$(r.sales) : '—'}</td>
                <td>{r.colorSales != null ? fmt$(r.colorSales) : '—'}</td>
                <td>{r.retail != null ? fmt$(r.retail) : '—'}</td>
                <td>{r.cpc != null ? fmtNum(r.cpc) : '—'}</td>
                <td>{r.rpc != null ? fmtNum(r.rpc) : '—'}</td>
                <td className="ledger-rate">{r.tsth != null ? fmtRate(r.tsth) : '—'}</td>
                <td>{r.totalHours != null ? fmtNum(r.totalHours, 1) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!sorted.length && <p className="empty-note" style={{ textAlign: 'center' }}>No new hires match "{query}".</p>}
      {unmatchedCount > 0 && (
        <p className="ledger-footnote">
          ⚠ {unmatchedCount} of these {unmatchedCount === 1 ? "person isn't" : "people aren't"} matched in the current Stylist Report yet (no store/sales data) — likely because they haven't had a shift with sales logged, or their name is spelled slightly differently between the two files.
        </p>
      )}
    </div>
  );
}

// ─── Goals tab (password protected) ────────────────────────────────────────
const GOALS_PASSWORD = '2124';

function GoalsTab({ report, goals, onSaveGoal, onImportGoals }) {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState(false);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState({}); // { code: { colorGoal, retailGoal } } — in-progress edits
  const [importing, setImporting] = useState(null); // 'colorGoal' | 'retailGoal' | null

  const tryUnlock = () => {
    if (pwInput === GOALS_PASSWORD) { setUnlocked(true); setPwError(false); }
    else { setPwError(true); }
  };

  const handleImportFile = async (field, file) => {
    setImporting(field);
    await onImportGoals(field, file);
    setImporting(null);
  };

  if (!report) {
    return <div className="empty-state"><p className="empty-title">No report yet</p><p>Upload a stylist report first, so there's a store list to set goals for.</p></div>;
  }

  if (!unlocked) {
    return (
      <div className="tab-content">
        <div className="password-gate">
          <p className="password-gate-title">🔒 Goals</p>
          <p className="password-gate-hint">This section is password protected. Enter the password to continue.</p>
          <input
            type="password" className="password-input" placeholder="Password" value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false); }}
            onKeyDown={e => { if (e.key === 'Enter') tryUnlock(); }}
          />
          <button className="btn-primary" onClick={tryUnlock}>Unlock</button>
          {pwError && <p className="password-error">Incorrect password.</p>}
        </div>
      </div>
    );
  }

  const stores = report.stores
    .map(s => ({ name: s.name, code: s.code }))
    .filter(s => !query.trim() || s.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const getVal = (code, field) => {
    if (drafts[code]?.[field] !== undefined) return drafts[code][field];
    return goals?.[code]?.[field] ?? '';
  };

  const handleChange = (code, field, value) => {
    setDrafts(prev => ({ ...prev, [code]: { ...prev[code], [field]: value } }));
  };

  const handleBlur = (code, field) => {
    const raw = drafts[code]?.[field];
    if (raw === undefined) return;
    const num = raw === '' ? null : Number(raw);
    onSaveGoal(code, field, isNaN(num) ? null : num);
  };

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={setQuery} placeholder="Search stores…" />
      <p className="section-hint">Set a weekly Color and Retail sales goal per store. These show up as "Goal" and "vs Goal" columns on the Retail and Color Sales tabs.</p>

      <div className="goal-import-row">
        <label className="goal-import-btn">
          <input
            type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files[0]) handleImportFile('colorGoal', e.target.files[0]); e.target.value = ''; }}
          />
          {importing === 'colorGoal' ? <span className="spinner small" /> : '📥'} Import Color Goals from file
        </label>
        <label className="goal-import-btn">
          <input
            type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files[0]) handleImportFile('retailGoal', e.target.files[0]); e.target.value = ''; }}
          />
          {importing === 'retailGoal' ? <span className="spinner small" /> : '📥'} Import Retail Goals from file
        </label>
      </div>

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Store</th>
              <th>Color Goal</th>
              <th>Retail Goal</th>
            </tr>
          </thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.code}>
                <td className="ledger-name-col">{s.name}</td>
                <td>
                  <input
                    type="number" className="goal-input" placeholder="$0"
                    value={getVal(s.code, 'colorGoal')}
                    onChange={e => handleChange(s.code, 'colorGoal', e.target.value)}
                    onBlur={() => handleBlur(s.code, 'colorGoal')}
                  />
                </td>
                <td>
                  <input
                    type="number" className="goal-input" placeholder="$0"
                    value={getVal(s.code, 'retailGoal')}
                    onChange={e => handleChange(s.code, 'retailGoal', e.target.value)}
                    onBlur={() => handleBlur(s.code, 'retailGoal')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!stores.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match "{query}".</p>}
    </div>
  );
}

// ─── Setup tab ──────────────────────────────────────────────────────────────
function SetupTab({ configured }) {
  const steps = [
    { n: 1, title: 'Export this week\u2019s stylist report', body: 'Run the report with every store and every employee under it, covering the week you want to see.' },
    { n: 2, title: 'Upload it', body: 'Go to the Upload tab and drop it into the "Stylist Report" slot. The date range fills in automatically.' },
    { n: 3, title: 'Optionally upload employee start dates', body: 'A simple Employee Name + Start Date export. Drop it into the "Employee Start Dates" slot to power the "60 Day Employee" tab, which shows anyone hired in the last 60 days along with their store, DL, and sales — even if they don\u2019t have sales data yet.' },
    { n: 4, title: 'Explore the tabs', body: 'Overview: tap a metric to see the top/bottom 10 stores. Stores: every location, click one to see its employees. Employees: every stylist company-wide. Retail / Color Sales: grouped by DL, or toggle to a flat list. DL: rolled-up totals per leader, click to expand their stores. 60 Day Employee: recent hires. Every tab has a search box.' },
    { n: 5, title: 'Next week', body: 'Just upload a new stylist report the same way \u2014 it replaces this week\u2019s data for everyone viewing the site.' },
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
const TABS = ['Overview', 'Stores', 'Employees', 'Retail', 'Color Sales', 'DL', '60 Day Employee', 'Goals', 'Upload', 'Setup'];

export default function App() {
  const [report, setReport] = useState(null);
  const [employeeRoster, setEmployeeRoster] = useState(null);
  const [goals, setGoals] = useState({});
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingRoster, setUploadingRoster] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('tsth');
  const [queries, setQueries] = useState({ Overview: '', Stores: '', Employees: '', Retail: '', 'Color Sales': '', DL: '', '60 Day Employee': '' });

  useEffect(() => {
    Promise.all([loadData('stylist_report'), loadData('employee_start_dates'), loadData('store_goals')]).then(([reportRes, rosterRes, goalsRes]) => {
      if (reportRes.data) setReport(reportRes.data); else setTab('Upload');
      if (rosterRes.data) setEmployeeRoster(rosterRes.data);
      if (goalsRes.data) setGoals(goalsRes.data);
      setLoading(false);
      if (isConfigured() && (reportRes.source === 'local' || rosterRes.source === 'local' || goalsRes.source === 'local')) {
        const err = reportRes.error || rosterRes.error || goalsRes.error;
        showToast(`Couldn't reach Supabase (${err || 'unknown error'}) — showing this device's local data only`, 'error');
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
      const result = await saveData('stylist_report', parsed);
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

  const handleRosterFile = useCallback(async file => {
    setUploadingRoster(true);
    try {
      const parsed = await parseEmployeeStartDates(file);
      setEmployeeRoster(parsed);
      const result = await saveData('employee_start_dates', parsed);
      if (isConfigured() && !result.ok) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
      } else {
        showToast(`Loaded ${file.name} — ${parsed.employees.length} employees on file`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploadingRoster(false);
    }
  }, []);

  const handleClearAll = async () => {
    if (!window.confirm('Clear the uploaded stylist report and start over? This cannot be undone.')) return;
    await clearData('stylist_report');
    setReport(null);
    setLabel('');
    setTab('Upload');
    showToast('Stylist report cleared');
  };

  const handleClearRoster = async () => {
    if (!window.confirm('Clear the employee start-date list? This cannot be undone.')) return;
    await clearData('employee_start_dates');
    setEmployeeRoster(null);
    showToast('Start-date list cleared');
  };

  const handleSaveGoal = useCallback((storeCode, field, value) => {
    setGoals(prev => {
      const next = { ...prev, [storeCode]: { ...prev[storeCode], [field]: value } };
      saveData('store_goals', next).then(result => {
        if (isConfigured() && !result.ok) {
          showToast(`Goal saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
        }
      });
      return next;
    });
  }, []);

  const handleImportGoals = useCallback(async (field, file) => {
    try {
      const parsed = await parseGoalFile(file);
      const next = { ...goals };
      let matched = 0;
      const unmatched = [];
      parsed.entries.forEach(e => {
        const code = getCodeForStoreName(e.storeName);
        if (code) { next[code] = { ...next[code], [field]: e.amount }; matched++; }
        else unmatched.push(e.storeName);
      });
      setGoals(next);
      const result = await saveData('store_goals', next);
      const label = field === 'colorGoal' ? 'color' : 'retail';
      if (isConfigured() && !result.ok) {
        showToast(`Imported ${matched} ${label} goals, but couldn't sync to Supabase (${result.error})`, 'error');
      } else if (unmatched.length) {
        showToast(`Imported ${matched} ${label} goals from ${file.name} — ${unmatched.length} store name${unmatched.length > 1 ? 's' : ''} not recognized: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}`, 'error');
      } else {
        showToast(`Imported ${matched} ${label} goals from ${file.name} (${parsed.periodLabel.trim()})`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [goals]);

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  const needsReport = !report && tab !== 'Upload' && tab !== 'Setup' && tab !== '60 Day Employee' && tab !== 'Goals';

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
        {!needsReport && tab === 'Retail' && report && (
          <StoreMetricTab
            report={report} query={queries.Retail} onQuery={v => setQuery('Retail', v)}
            title="Retail" metricA={{ key: 'retail', label: 'Retail', fmt: fmt$ }} metricB={{ key: 'rpc', label: 'RPC', fmt: fmtNum }}
            goalType="retailGoal" goals={goals}
          />
        )}
        {!needsReport && tab === 'Color Sales' && report && (
          <StoreMetricTab
            report={report} query={queries['Color Sales']} onQuery={v => setQuery('Color Sales', v)}
            title="Color Sales" metricA={{ key: 'colorSales', label: 'Color Sales', fmt: fmt$ }} metricB={{ key: 'cpc', label: 'CPC', fmt: fmtNum }}
            goalType="colorGoal" goals={goals}
          />
        )}
        {!needsReport && tab === 'DL' && report && (
          <DLTab report={report} query={queries.DL} onQuery={v => setQuery('DL', v)} />
        )}
        {tab === '60 Day Employee' && (
          <NewHireTab report={report} employeeRoster={employeeRoster} query={queries['60 Day Employee']} onQuery={v => setQuery('60 Day Employee', v)} />
        )}
        {tab === 'Goals' && (
          <GoalsTab report={report} goals={goals} onSaveGoal={handleSaveGoal} onImportGoals={handleImportGoals} />
        )}
        {tab === 'Upload' && (
          <UploadTab
            report={report} uploading={uploading} onFile={handleFile} onClear={handleClearAll}
            employeeRoster={employeeRoster} uploadingRoster={uploadingRoster} onRosterFile={handleRosterFile} onClearRoster={handleClearRoster}
          />
        )}
        {tab === 'Setup' && <SetupTab configured={isConfigured()} />}
      </main>
    </div>
  );
}
