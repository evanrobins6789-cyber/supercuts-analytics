import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { loadData, saveData, clearData, isConfigured, loadDataByPrefix, clearDataByPrefix } from './db';
import {
  parseStylistReport, parseEmployeeStartDates, parseGoalFile, parseReviews, normalizeName,
  parseSalesAccrualFile, parseAttendanceHistoryFile, mergeSalesIntoHistory, mergeAttendanceIntoHistory,
  buildWeeklyRecord, mergeWeeklyIntoHistory,
} from './parser';
import { LEADER_ROSTER_SECTIONS, getLeaderForStoreCode } from './leaderRoster';
import { getCodeForStoreName, STORE_CODE_TO_NAME } from './storeDirectory';
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
  { key: 'haircuts', label: 'Cuts', fmt: fmtInt },
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
  { key: 'haircuts', label: 'Cuts', fmt: fmtInt },
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

// Green when at/above goal, red when under — used everywhere a "vs Goal" cell renders.
function vsGoalClass(diff) { return diff == null ? '' : diff < 0 ? 'ledger-margin-neg' : 'ledger-margin-pos'; }

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

// ─── Historical date-range querying (shared by Stores/Retail/Color/DL) ─────
// Same "don't double-count" rule as the Weekly tab: a week only counts from
// an uploaded weekly report if its whole range sits inside the query range;
// any day already covered by SOME weekly report is skipped from the daily
// (Sales-Accrual/Attendance) bucket either way, so nothing is ever counted twice.
const EMPTY_RANGE_TOTALS = { service: 0, retail: 0, color: 0, hours: 0, giftCards: 0, haircuts: 0 };
function addRangeInto(target, src) {
  target.service += src.service || 0;
  target.retail += src.retail || 0;
  target.color += src.color || 0;
  target.hours += src.hours || 0;
  target.giftCards += src.giftCards || 0;
  target.haircuts += src.haircuts || 0;
}
function expandDateRangeDays(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  let guard = 0;
  while (d <= endD && guard < 1200) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return dates;
}
// Employee-level detail comes from weekly Stylist Report uploads AND from
// the Sales-Accrual/Attendance historical backfill (both attribute rows to
// a Stylist/Employee Name, so both can populate per-employee totals).
// Merges by name across every week in range, summing raw totals and
// recomputing tsth/cpc/rpc from those sums — never averaging ratios.
function mergeEmployeesInto(targetMap, employees) {
  employees.forEach(e => {
    if (!targetMap[e.name]) targetMap[e.name] = { name: e.name, sales: 0, colorSales: 0, retail: 0, haircuts: 0, totalHours: 0 };
    const t = targetMap[e.name];
    t.sales += e.sales || 0;
    t.colorSales += e.colorSales || 0;
    t.retail += e.retail || 0;
    t.haircuts += e.haircuts || 0;
    t.totalHours += e.totalHours || 0;
  });
}
function finalizeEmployee(e) {
  return {
    ...e,
    tsth: e.totalHours > 0 ? e.sales / e.totalHours : null,
    cpc: e.haircuts > 0 ? e.colorSales / e.haircuts : null,
    rpc: e.haircuts > 0 ? e.retail / e.haircuts : null,
  };
}
function getRangeTotals(history, weeklyHistory, startISO, endISO) {
  const weeklyEntries = Object.values(weeklyHistory || {});
  const covered = new Set();
  weeklyEntries.forEach(w => expandDateRangeDays(w.startDate, w.endDate).forEach(d => covered.add(d)));

  const byStore = {};
  const employeesByStore = {};
  const addTo = (code, src) => {
    if (!byStore[code]) byStore[code] = { ...EMPTY_RANGE_TOTALS };
    addRangeInto(byStore[code], src);
  };
  weeklyEntries.forEach(w => {
    if (w.startDate >= startISO && w.endDate <= endISO) {
      Object.entries(w.stores).forEach(([code, v]) => {
        addTo(code, v);
        if (v.employees && v.employees.length) {
          if (!employeesByStore[code]) employeesByStore[code] = {};
          mergeEmployeesInto(employeesByStore[code], v.employees);
        }
      });
    }
  });
  Object.values(history || {}).forEach(r => {
    if (r.date < startISO || r.date > endISO) return;
    if (covered.has(r.date)) return;
    addTo(r.code, r);
    if (r.employees && Object.keys(r.employees).length) {
      if (!employeesByStore[r.code]) employeesByStore[r.code] = {};
      const asArray = Object.entries(r.employees).map(([name, v]) => ({ name, ...v }));
      mergeEmployeesInto(employeesByStore[r.code], asArray);
    }
  });
  Object.keys(byStore).forEach(code => {
    byStore[code].employees = employeesByStore[code]
      ? Object.values(employeesByStore[code]).map(finalizeEmployee)
      : [];
  });
  return byStore;
}
// Adapts history's {service,retail,color,hours,giftCards,haircuts,employees}
// shape into the same shape a live Stylist Report uses, so the exact same
// tables/columns can render either one. haircuts/employees come through
// whenever the Sales-Accrual/Attendance backfill (or a weekly Stylist Report)
// covered that period; otherwise they come back null/empty rather than a
// made-up number.
function historyTotalsToReportShape(t) {
  const hours = t?.hours || 0;
  const service = t?.service || 0;
  const haircuts = t?.haircuts || 0;
  return {
    sales: service,
    totalHours: hours,
    colorSales: t?.color || 0,
    retail: t?.retail || 0,
    giftCards: t?.giftCards || 0,
    haircuts: haircuts || null,
    tsth: hours > 0 ? service / hours : null,
    cpc: haircuts > 0 ? (t.color || 0) / haircuts : null,
    rpc: haircuts > 0 ? (t.retail || 0) / haircuts : null,
    employees: t?.employees || [],
  };
}

function getCurrentMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const toISO = d => d.toISOString().slice(0, 10);
  return { start: toISO(first), end: toISO(now) };
}

function DateRangeBar({ start, end, onChange }) {
  const applyCurrentMonth = () => { const r = getCurrentMonthRange(); onChange(r.start, r.end); };
  return (
    <div className="date-range-bar">
      <span className="date-range-label">Date range:</span>
      <input type="date" className="date-range-input" value={start || ''} onChange={e => onChange(e.target.value || null, end)} />
      <span className="date-range-to">to</span>
      <input type="date" className="date-range-input" value={end || ''} onChange={e => onChange(start, e.target.value || null)} />
      <button className="date-range-quick-btn" onClick={applyCurrentMonth}>Current Month</button>
      {(start || end) && (
        <button className="btn-ghost date-range-clear" onClick={() => onChange(null, null)}>Clear — use current report</button>
      )}
      {(start && end) && <span className="date-range-note">Showing historical data for this range. Employee-level detail is included wherever your Sales-Accrual/Attendance imports cover these dates.</span>}
    </div>
  );
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

function UploadTab({ report, uploading, onFile, onClear, employeeRoster, uploadingRoster, onRosterFile, onClearRoster, reviews, uploadingReviews, onReviewsFile, onClearReviews }) {
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

      <UploadSlot
        id="reviews-file" title="Reviews Export" hint="Upload the reviews export (CSV)"
        fileInfo={reviews ? { fileName: reviews.fileName, sub: `${reviews.reviews.length} reviews on file` } : null}
        uploading={uploadingReviews}
        onFile={onReviewsFile}
      />
      {reviews && <button className="btn-ghost btn-danger" onClick={onClearReviews}>Clear reviews</button>}
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
function StoresTab({ report, query, onQuery, history, weeklyHistory, dateRange, onDateRangeChange }) {
  const [sortBy, setSortBy] = useState('tsth');
  const [expanded, setExpanded] = useState({});
  const isHistorical = !!(dateRange.start && dateRange.end);

  const storeRows = useMemo(() => {
    if (isHistorical) {
      const totals = getRangeTotals(history, weeklyHistory, dateRange.start, dateRange.end);
      return Object.entries(totals).map(([code, t]) => {
        const shape = historyTotalsToReportShape(t);
        return { name: STORE_CODE_TO_NAME[code] || `Store ${code}`, code, ...shape, employees: shape.employees };
      });
    }
    return report.stores.map(s => ({ name: s.name, code: s.code, employees: s.employees, ...s.totals }));
  }, [isHistorical, history, weeklyHistory, dateRange, report.stores]);

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

  const t = isHistorical ? rollupRows(storeRows) : report.companyTotals;
  const toggle = name => setExpanded(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <div className="tab-content">
      <DateRangeBar start={dateRange.start} end={dateRange.end} onChange={onDateRangeChange} />
      <SearchBox value={query} onChange={onQuery} placeholder="Search stores or employees…" />

      <div className="ledger-head-row">
        <p className="section-label">{filtered.length} of {storeRows.length} stores{isHistorical ? ' (historical)' : ''}</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {STORE_METRICS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      <div className="dl-list">
        {sorted.map(s => {
          const hasEmployeeData = s.employees.length > 0;
          const isOpen = isSearching || !!expanded[s.name];
          return (
            <div key={s.name} className="dl-card">
              <button className="dl-card-head" onClick={() => toggle(s.name)} disabled={!hasEmployeeData}>
                <div className="dl-card-name-wrap">
                  {hasEmployeeData && <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>}
                  <span className="dl-card-name">{s.name}</span>
                  <span className="dl-card-count">
                    {hasEmployeeData ? `${s.employees.length} employee${s.employees.length !== 1 ? 's' : ''}` : (isHistorical ? 'no employee data for this range' : '')}
                  </span>
                </div>
                <div className="dl-card-stats">
                  <div className="dl-stat"><span className="dl-stat-label">Sales</span><span className="dl-stat-value">{fmt$(s.sales)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className="dl-stat-value">{fmtRate(s.tsth)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(s.totalHours, 0)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(s.colorSales)}</span></div>
                  {s.cpc != null && <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(s.cpc)}</span></div>}
                  <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(s.retail)}</span></div>
                  {s.rpc != null && <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(s.rpc)}</span></div>}
                  <div className="dl-stat"><span className="dl-stat-label">Cuts</span><span className="dl-stat-value">{fmtInt(s.haircuts)}</span></div>
                </div>
              </button>
              {isOpen && hasEmployeeData && (
                <div className="dl-store-table">
                  <EmployeeTable
                    rows={sortByMetric(s.employees, 'sales', 'desc')}
                    showStoreCol={false}
                    footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts }}
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
function EmployeeTable({ rows, showStoreCol = true, footer = null, footerLabel = 'Total / Avg (weighted)', focused = null, onFocus = null }) {
  return (
    <div className="ledger-scroll">
      <table className={`ledger-table ${focused ? 'ledger-table--focus-mode' : ''}`}>
        <thead>
          <tr>
            <th className="ledger-name-col">Employee</th>
            {showStoreCol && <th className="ledger-store-col">Store</th>}
            {EMPLOYEE_METRICS.map(m => <th key={m.key}>{m.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr
              key={`${e.name}-${e.store}-${i}`}
              className={onFocus ? `ledger-row-clickable ${focused === e.name ? 'ledger-row-focused' : ''}` : ''}
              onClick={onFocus ? () => onFocus(focused === e.name ? null : e.name) : undefined}
            >
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
  const [focused, setFocused] = useState(null);
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

      {focused && (
        <p className="section-hint">
          Focused on <strong>{focused}</strong> — everyone else is dimmed. <button className="btn-ghost" onClick={() => setFocused(null)}>Clear focus</button>
        </p>
      )}
      <EmployeeTable rows={sorted} showStoreCol focused={focused} onFocus={setFocused} />
    </div>
  );
}

function getPrevMonthRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const toISO = d => d.toISOString().slice(0, 10);
  return { start: toISO(first), end: toISO(last) };
}

// ─── Single-focus store tabs (Retail, Color Sales) — grouped by DL ─────────
function StoreMetricTab({ report, query, onQuery, title, metricA, metricB, goalType, goals, history, weeklyHistory, dateRange, onDateRangeChange, showPrevMonthColor }) {
  const [sortBy, setSortBy] = useState(metricA.key);
  const [viewMode, setViewMode] = useState('dl'); // 'dl' | 'flat'
  const [expanded, setExpanded] = useState({});
  const [expandedLeader, setExpandedLeader] = useState({});
  const isHistorical = !!(dateRange?.start && dateRange?.end);
  const getGoal = code => (goalType && goals?.[code]?.[goalType] != null ? goals[code][goalType] : null);
  const showGoals = !!goalType;
  const colCount = 3 + (showGoals ? 2 : 0) + (showPrevMonthColor ? 1 : 0);

  const prevMonthColorByCode = useMemo(() => {
    if (!showPrevMonthColor) return {};
    const { start, end } = getPrevMonthRange();
    const totals = getRangeTotals(history, weeklyHistory, start, end);
    const map = {};
    Object.entries(totals).forEach(([code, t]) => { map[code] = t.color; });
    return map;
  }, [showPrevMonthColor, history, weeklyHistory]);

  const rows = useMemo(() => {
    if (isHistorical) {
      const totals = getRangeTotals(history, weeklyHistory, dateRange.start, dateRange.end);
      return Object.entries(totals).map(([code, t]) => {
        const shape = historyTotalsToReportShape(t);
        const goal = getGoal(code);
        return {
          name: STORE_CODE_TO_NAME[code] || `Store ${code}`, code, ...shape, employees: shape.employees,
          vsGoal: goal != null ? shape[metricA.key] - goal : null,
          prevMonthColor: showPrevMonthColor ? prevMonthColorByCode[code] : undefined,
        };
      });
    }
    return report.stores.map(s => {
      const goal = getGoal(s.code);
      return {
        name: s.name, code: s.code, employees: s.employees, ...s.totals,
        vsGoal: goal != null ? s.totals[metricA.key] - goal : null,
        prevMonthColor: showPrevMonthColor ? prevMonthColorByCode[s.code] : undefined,
      };
    });
  }, [isHistorical, history, weeklyHistory, dateRange, report.stores, goals, goalType, showPrevMonthColor, prevMonthColorByCode]);
  const groups = useMemo(() => groupStoresByLeader(rows), [rows]);
  const toggleStore = code => setExpanded(prev => ({ ...prev, [code]: !prev[code] }));
  const toggleLeader = name => setExpandedLeader(prev => ({ ...prev, [name]: !prev[name] }));

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

  const t = isHistorical ? rollupRows(rows) : report.companyTotals;
  const totalStoresShown = viewMode === 'dl'
    ? filteredGroups.reduce((n, g) => n + g.stores.length, 0)
    : filteredFlat.length;

  const groupGoalTotal = storesArr => storesArr.reduce((s, st) => s + (getGoal(st.code) ?? 0), 0);
  const companyGoalTotal = rows.reduce((s, st) => s + (getGoal(st.code) ?? 0), 0);
  const prevMonthColSum = arr => arr.reduce((s, st) => s + (st.prevMonthColor || 0), 0);

  return (
    <div className="tab-content">
      {onDateRangeChange && <DateRangeBar start={dateRange.start} end={dateRange.end} onChange={onDateRangeChange} />}
      <SearchBox value={query} onChange={onQuery} placeholder={viewMode === 'dl' ? 'Search stores or DL…' : 'Search stores…'} />

      <div className="view-toggle">
        <button className={`view-toggle-btn ${viewMode === 'dl' ? 'active' : ''}`} onClick={() => setViewMode('dl')}>Grouped by DL</button>
        <button className={`view-toggle-btn ${viewMode === 'flat' ? 'active' : ''}`} onClick={() => setViewMode('flat')}>All Stores</button>
      </div>

      <div className="ledger-head-row">
        <p className="section-label">{title} — {totalStoresShown} stores{viewMode === 'dl' ? ', grouped by DL' : ''}{isHistorical ? ' (historical)' : ''}</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value={metricA.key}>Sort: {metricA.label}</option>
          <option value={metricB.key}>Sort: {metricB.label}</option>
          {showGoals && <option value="vsGoal">Sort: vs Goal</option>}
          <option value="name">Sort: Name (A–Z)</option>
        </select>
      </div>

      {viewMode === 'dl' && (
        <div className="dl-list">
          {filteredGroups.map(g => {
            const groupTotals = rollupRows(g.stores);
            const sortedStores = sortByMetric(g.stores, sortBy, 'desc');
            const goalTotal = groupGoalTotal(g.stores);
            const groupDiff = goalTotal > 0 ? groupTotals[metricA.key] - goalTotal : null;
            const isLeaderOpen = !!expandedLeader[g.leaderName];
            return (
              <div key={g.leaderName} className="dl-card">
                <button className="dl-card-head" onClick={() => toggleLeader(g.leaderName)}>
                  <div className="dl-card-name-wrap">
                    <span className={`dl-chevron ${isLeaderOpen ? 'dl-chevron--open' : ''}`}>▸</span>
                    <span className="dl-card-name">{g.leaderName}</span>
                    <span className="dl-card-count">{g.role} · {g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="dl-card-stats">
                    <div className="dl-stat"><span className="dl-stat-label">{metricA.label}</span><span className="dl-stat-value">{metricA.fmt(groupTotals[metricA.key])}</span></div>
                    <div className="dl-stat"><span className="dl-stat-label">{metricB.label}</span><span className="dl-stat-value">{metricB.fmt(groupTotals[metricB.key])}</span></div>
                    {showPrevMonthColor && <div className="dl-stat"><span className="dl-stat-label">Prev Month Color</span><span className="dl-stat-value">{fmt$(prevMonthColSum(g.stores))}</span></div>}
                    {showGoals && <div className="dl-stat"><span className="dl-stat-label">Goal</span><span className="dl-stat-value">{goalTotal > 0 ? fmt$(goalTotal) : '—'}</span></div>}
                    {showGoals && (
                      <div className="dl-stat">
                        <span className="dl-stat-label">vs Goal</span>
                        <span className={`dl-stat-value ${vsGoalClass(groupDiff)}`}>{groupDiff != null ? `${groupDiff >= 0 ? '+' : ''}${fmt$(groupDiff)}` : '—'}</span>
                      </div>
                    )}
                  </div>
                </button>
                {isLeaderOpen && (
                  <div className="ledger-scroll dl-store-table">
                    <table className="ledger-table">
                      <thead>
                        <tr>
                          <th className="ledger-name-col">Store</th><th>{metricA.label}</th><th>{metricB.label}</th>
                          {showPrevMonthColor && <th>Prev Month Color</th>}
                          {showGoals && <><th>Goal</th><th>vs Goal</th></>}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedStores.map(s => {
                          const goal = getGoal(s.code);
                          const diff = s.vsGoal;
                          const isOpen = !!expanded[s.code];
                          const hasEmployeeData = s.employees.length > 0;
                          return (
                            <React.Fragment key={s.name}>
                              <tr className={hasEmployeeData ? 'store-row-clickable' : ''} onClick={hasEmployeeData ? () => toggleStore(s.code) : undefined}>
                                <td className="ledger-name-col">
                                  {hasEmployeeData && <span className={`mini-chevron ${isOpen ? 'mini-chevron--open' : ''}`}>▸</span>} {s.name}
                                </td>
                                <td>{metricA.fmt(s[metricA.key])}</td>
                                <td>{metricB.fmt(s[metricB.key])}</td>
                                {showPrevMonthColor && <td>{s.prevMonthColor != null ? fmt$(s.prevMonthColor) : '—'}</td>}
                                {showGoals && (
                                  <>
                                    <td>{goal != null ? fmt$(goal) : '—'}</td>
                                    <td className={vsGoalClass(diff)}>{diff != null ? `${diff >= 0 ? '+' : ''}${fmt$(diff)}` : '—'}</td>
                                  </>
                                )}
                              </tr>
                              {isOpen && s.employees.length > 0 && (
                                <tr className="store-expand-row">
                                  <td colSpan={colCount}>
                                    <EmployeeTable
                                      rows={sortByMetric(s.employees, 'sales', 'desc')}
                                      showStoreCol={false}
                                      footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts }}
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
                          {showPrevMonthColor && <td>{fmt$(prevMonthColSum(g.stores))}</td>}
                          {showGoals && (
                            <>
                              <td>{goalTotal > 0 ? fmt$(goalTotal) : '—'}</td>
                              <td className={vsGoalClass(groupDiff)}>
                                {groupDiff != null ? `${groupDiff >= 0 ? '+' : ''}${fmt$(groupDiff)}` : '—'}
                              </td>
                            </>
                          )}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {viewMode === 'flat' && (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="ledger-name-col">Store</th><th>{metricA.label}</th><th>{metricB.label}</th>
                {showPrevMonthColor && <th>Prev Month Color</th>}
                {showGoals && <><th>Goal</th><th>vs Goal</th></>}
              </tr>
            </thead>
            <tbody>
              {sortedFlat.map(s => {
                const goal = getGoal(s.code);
                const diff = s.vsGoal;
                const isOpen = !!expanded[s.code];
                const hasEmployeeData = s.employees.length > 0;
                return (
                  <React.Fragment key={s.name}>
                    <tr className={hasEmployeeData ? 'store-row-clickable' : ''} onClick={hasEmployeeData ? () => toggleStore(s.code) : undefined}>
                      <td className="ledger-name-col">
                        {hasEmployeeData && <span className={`mini-chevron ${isOpen ? 'mini-chevron--open' : ''}`}>▸</span>} {s.name}
                      </td>
                      <td>{metricA.fmt(s[metricA.key])}</td>
                      <td>{metricB.fmt(s[metricB.key])}</td>
                      {showPrevMonthColor && <td>{s.prevMonthColor != null ? fmt$(s.prevMonthColor) : '—'}</td>}
                      {showGoals && (
                        <>
                          <td>{goal != null ? fmt$(goal) : '—'}</td>
                          <td className={vsGoalClass(diff)}>{diff != null ? `${diff >= 0 ? '+' : ''}${fmt$(diff)}` : '—'}</td>
                        </>
                      )}
                    </tr>
                    {isOpen && s.employees.length > 0 && (
                      <tr className="store-expand-row">
                        <td colSpan={colCount}>
                          <EmployeeTable
                            rows={sortByMetric(s.employees, 'sales', 'desc')}
                            showStoreCol={false}
                            footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts }}
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
                {showPrevMonthColor && <td>{fmt$(prevMonthColSum(sortedFlat))}</td>}
                {showGoals && (
                  <>
                    <td>{companyGoalTotal > 0 ? fmt$(companyGoalTotal) : '—'}</td>
                    <td className={companyGoalTotal > 0 ? vsGoalClass(t[metricA.key] - companyGoalTotal) : ''}>
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
function DLTab({ report, query, onQuery, history, weeklyHistory, dateRange, onDateRangeChange }) {
  const [expanded, setExpanded] = useState({});
  const [expandedStore, setExpandedStore] = useState({});
  const isHistorical = !!(dateRange.start && dateRange.end);
  const rows = useMemo(() => {
    if (isHistorical) {
      const totals = getRangeTotals(history, weeklyHistory, dateRange.start, dateRange.end);
      return Object.entries(totals).map(([code, t]) => {
        const shape = historyTotalsToReportShape(t);
        return { name: STORE_CODE_TO_NAME[code] || `Store ${code}`, code, ...shape, employees: shape.employees };
      });
    }
    return report.stores.map(s => ({ name: s.name, code: s.code, employees: s.employees, ...s.totals }));
  }, [isHistorical, history, weeklyHistory, dateRange, report.stores]);
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
  const toggleStoreRow = code => setExpandedStore(prev => ({ ...prev, [code]: !prev[code] }));

  return (
    <div className="tab-content">
      <DateRangeBar start={dateRange.start} end={dateRange.end} onChange={onDateRangeChange} />
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
                      <div className="dl-stat"><span className="dl-stat-label">Cuts</span><span className="dl-stat-value">{fmtInt(t.haircuts)}</span></div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="ledger-scroll dl-store-table">
                      <table className="ledger-table">
                        <thead>
                          <tr>
                            <th className="ledger-name-col">Store</th>
                            <th>Sales</th><th>TSTH</th><th>Total Hours</th><th>Color Sales</th>
                            <th>CPC</th>
                            <th>Retail</th>
                            <th>RPC</th>
                            <th>Cuts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortByMetric(g.stores, 'sales', 'desc').map(s => {
                            const isStoreOpen = !!expandedStore[s.code];
                            const hasEmployeeData = s.employees.length > 0;
                            return (
                              <React.Fragment key={s.name}>
                                <tr className={hasEmployeeData ? 'store-row-clickable' : ''} onClick={hasEmployeeData ? () => toggleStoreRow(s.code) : undefined}>
                                  <td className="ledger-name-col">
                                    {hasEmployeeData && <span className={`mini-chevron ${isStoreOpen ? 'mini-chevron--open' : ''}`}>▸</span>} {s.name}
                                  </td>
                                  <td>{fmt$(s.sales)}</td>
                                  <td className="ledger-rate">{fmtRate(s.tsth)}</td>
                                  <td>{fmtNum(s.totalHours, 0)}</td>
                                  <td>{fmt$(s.colorSales)}</td>
                                  <td>{fmtNum(s.cpc)}</td>
                                  <td>{fmt$(s.retail)}</td>
                                  <td>{fmtNum(s.rpc)}</td>
                                  <td>{fmtInt(s.haircuts)}</td>
                                </tr>
                                {isStoreOpen && hasEmployeeData && (
                                  <tr className="store-expand-row">
                                    <td colSpan={9}>
                                      <EmployeeTable
                                        rows={sortByMetric(s.employees, 'sales', 'desc')}
                                        showStoreCol={false}
                                        footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts }}
                                        footerLabel="Store total / weighted avg"
                                      />
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
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
        <p>Go to the Setup tab's Upload section and add the "Employee Start Dates" file to see who's new.</p>
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

// ─── Reviews tab ────────────────────────────────────────────────────────────
const REVIEW_CATEGORIES = [
  { key: 'atmosphere', label: 'Atmosphere', keywords: ['atmosphere', 'dirty', 'messy', 'smell', 'unclean', 'environment', 'decor', 'uncomfortable', 'cluttered', 'disorganized', 'filthy', 'run down', 'outdated'] },
  { key: 'quality', label: 'Quality of Service', keywords: ['haircut', 'botched', 'uneven', 'ruined', 'unprofessional', 'rude', 'bad job', 'poor service', 'disappointed', 'messed up', 'terrible', 'awful', 'horrible', 'sloppy', 'incompetent', 'butchered', 'awful cut', 'bad cut'] },
  { key: 'waitTime', label: 'Wait Time', keywords: ['wait', 'waiting', 'hours', 'long time', 'slow', 'line', 'queue', 'understaffed', 'short staffed', 'short-staffed', 'took forever'] },
  { key: 'cancellations', label: 'Cancellations', keywords: ['cancel', 'cancelled', 'canceled', 'no show', "didn't show", 'rescheduled', 'reschedule', 'no call', 'walked out', 'closed early', 'no one there', 'turned away', 'turns customers away'] },
];

function reviewMatchesCategory(message, categoryKey) {
  const cat = REVIEW_CATEGORIES.find(c => c.key === categoryKey);
  if (!cat || !message) return false;
  const text = message.toLowerCase();
  return cat.keywords.some(kw => text.includes(kw));
}

// The review file's own "location" text is a verbose listing name that
// doesn't match our store naming, so we resolve by code instead — falling
// back to whatever's in the raw location text if a code isn't recognized,
// rather than hiding the review.
function resolveStoreName(code, rawLocation) {
  if (STORE_CODE_TO_NAME[code]) return { name: STORE_CODE_TO_NAME[code], matched: true };
  const m = String(rawLocation || '').match(/\(([^)]+)\)/);
  return { name: m ? m[1] : `Store ${code}`, matched: false };
}

// Only checks employees who actually work at that specific store, to avoid
// false positives from common first names matching unrelated people.
function detectEmployeeMention(message, employees) {
  if (!employees || !message) return null;
  const text = message.toLowerCase();
  for (const emp of employees) {
    const firstName = emp.name.trim().split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');
    if (firstName.length < 3) continue;
    const re = new RegExp(`\\b${firstName.toLowerCase()}\\b`);
    if (re.test(text)) return emp.name;
  }
  return null;
}

function StarRating({ value }) {
  return <span className="star-rating">{'★'.repeat(value)}{'☆'.repeat(Math.max(0, 5 - value))}</span>;
}

// Reviews have no id from the source export — this composite is stable
// across reloads/re-uploads (unlike an array index) so notes can survive
// a fresh reviews-file upload without being tied to array position.
function reviewKey(r) { return `${r.code}|${r.postedAt}|${r.userName}|${r.rating}`; }

function ReviewNotes({ notes, onAdd }) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    setDraft('');
  };
  return (
    <div className="review-notes">
      {notes.length > 0 && (
        <div className="review-notes-list">
          {[...notes].reverse().map((n, i) => (
            <div key={i} className="review-notes-entry">
              <span className="review-notes-entry-date">{new Date(n.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span className="review-notes-entry-text">{n.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className="review-notes-input-row">
        <input
          className="review-notes-input" value={draft} placeholder='Add a note (e.g. "Called 7/22 - resolved - EJ")…'
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        />
        <button className="review-notes-add" onClick={submit} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}

function ReviewCard({ review, employeeMatch, notes, onAddNote }) {
  const tone = review.rating <= 2 ? 'neg' : review.rating >= 4 ? 'pos' : 'neu';
  return (
    <div className={`review-card review-card--${tone}`}>
      <div className="review-card-head">
        <StarRating value={review.rating} />
        <span className="review-user">{review.userName || 'Anonymous'}</span>
        <span className="review-date">{review.postedAt ? review.postedAt.slice(0, 10) : ''}</span>
      </div>
      {review.message && <p className="review-message">{review.message}</p>}
      {employeeMatch && <p className="review-employee-tag">👤 Mentions: {employeeMatch}</p>}
      {onAddNote && <ReviewNotes notes={notes || []} onAdd={text => onAddNote(reviewKey(review), text)} />}
    </div>
  );
}

function isNegativeReview(r) { return r.rating <= 3; }
function isPositiveReview(r) { return r.rating >= 4; }
function ratingClass(avg) { return avg >= 4.8 ? 'rating-good' : 'rating-bad'; }

const REVIEW_SORT_OPTIONS = [
  { key: 'reviews', label: 'Total Reviews' },
  { key: 'negative', label: 'Most Negative' },
  { key: 'positive', label: 'Most Positive' },
];

function ReviewsTab({ report, reviews, query, onQuery, reviewNotes, onAddReviewNote }) {
  const [viewMode, setViewMode] = useState('flat'); // 'flat' | 'dl'
  const [category, setCategory] = useState(null);
  const [sentiment, setSentiment] = useState(null); // null | 'pos' | 'neg'
  const [expandedStore, setExpandedStore] = useState({});
  const [expandedLeader, setExpandedLeader] = useState({});
  const [sortBy, setSortBy] = useState('reviews');

  const selectCategory = key => { setCategory(prev => prev === key ? null : key); setSentiment(null); };
  const selectSentiment = key => { setSentiment(prev => prev === key ? null : key); setCategory(null); };

  if (!reviews) {
    return <div className="empty-state"><p className="empty-title">No reviews uploaded yet</p><p>Go to the Setup tab's Upload section and add the reviews export.</p></div>;
  }

  const allReviews = reviews.reviews;
  const totalCount = allReviews.length;
  const overallAvg = totalCount ? allReviews.reduce((s, r) => s + r.rating, 0) / totalCount : 0;
  const positive = allReviews.filter(isPositiveReview);
  const negative = allReviews.filter(isNegativeReview);
  const posAvg = positive.length ? positive.reduce((s, r) => s + r.rating, 0) / positive.length : 0;
  const negAvg = negative.length ? negative.reduce((s, r) => s + r.rating, 0) / negative.length : 0;

  const storeMap = useMemo(() => {
    const map = new Map();
    allReviews.forEach(r => {
      if (!map.has(r.code)) {
        const { name, matched } = resolveStoreName(r.code, r.rawLocation);
        map.set(r.code, { code: r.code, name, matched, reviews: [] });
      }
      map.get(r.code).reviews.push(r);
    });
    return map;
  }, [allReviews]);

  const categoryCounts = useMemo(() => {
    const counts = {};
    REVIEW_CATEGORIES.forEach(c => { counts[c.key] = negative.filter(r => reviewMatchesCategory(r.message, c.key)).length; });
    return counts;
  }, [negative]);

  const storeRows = useMemo(() => {
    const matcher = category
      ? r => isNegativeReview(r) && reviewMatchesCategory(r.message, category)
      : sentiment === 'pos' ? isPositiveReview
      : sentiment === 'neg' ? isNegativeReview
      : null;
    return Array.from(storeMap.values())
      .map(s => {
        const matching = matcher ? s.reviews.filter(matcher) : null;
        const avg = s.reviews.length ? s.reviews.reduce((a, r) => a + r.rating, 0) / s.reviews.length : 0;
        return {
          ...s, avg,
          negCount: s.reviews.filter(isNegativeReview).length,
          posCount: s.reviews.filter(isPositiveReview).length,
          matchCount: matching ? matching.length : null,
        };
      })
      .filter(s => !matcher || s.matchCount > 0);
  }, [storeMap, category, sentiment]);

  const filteredStores = useMemo(() => {
    if (!query.trim()) return storeRows;
    const q = query.trim().toLowerCase();
    return storeRows.filter(s => s.name.toLowerCase().includes(q));
  }, [storeRows, query]);

  const sortStores = arr => {
    const a2 = [...arr];
    if (sortBy === 'negative') a2.sort((a, b) => b.negCount - a.negCount);
    else if (sortBy === 'positive') a2.sort((a, b) => b.posCount - a.posCount);
    else a2.sort((a, b) => b.reviews.length - a.reviews.length);
    return a2;
  };

  const groups = useMemo(() => {
    if (viewMode !== 'dl') return null;
    return groupStoresByLeader(filteredStores).map(g => {
      const totalReviews = g.stores.reduce((s, st) => s + st.reviews.length, 0);
      const totalRating = g.stores.reduce((s, st) => s + st.reviews.reduce((a, r) => a + r.rating, 0), 0);
      return {
        ...g,
        totalReviews,
        avg: totalReviews ? totalRating / totalReviews : 0,
        neg: g.stores.reduce((s, st) => s + st.negCount, 0),
        pos: g.stores.reduce((s, st) => s + st.posCount, 0),
      };
    });
  }, [filteredStores, viewMode]);

  const sortedGroups = useMemo(() => {
    if (!groups) return null;
    const g2 = [...groups];
    if (sortBy === 'negative') g2.sort((a, b) => b.neg - a.neg);
    else if (sortBy === 'positive') g2.sort((a, b) => b.pos - a.pos);
    else g2.sort((a, b) => b.totalReviews - a.totalReviews);
    return g2;
  }, [groups, sortBy]);

  const toggleStore = code => setExpandedStore(prev => ({ ...prev, [code]: !prev[code] }));
  const toggleLeader = name => setExpandedLeader(prev => ({ ...prev, [name]: !prev[name] }));
  const activeCat = REVIEW_CATEGORIES.find(c => c.key === category);

  const renderReviewList = s => {
    const employeesForStore = report?.stores.find(st => st.code === s.code)?.employees || null;
    let reviewList = [...s.reviews].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    if (category) reviewList = reviewList.filter(r => isNegativeReview(r) && reviewMatchesCategory(r.message, category));
    else if (sentiment === 'pos') reviewList = reviewList.filter(isPositiveReview);
    else if (sentiment === 'neg') reviewList = reviewList.filter(isNegativeReview);
    return (
      <div className="dl-store-table review-list">
        {reviewList.map((r, i) => (
          <ReviewCard
            key={i} review={r} employeeMatch={detectEmployeeMention(r.message, employeesForStore)}
            notes={reviewNotes?.[reviewKey(r)]} onAddNote={onAddReviewNote}
          />
        ))}
        {!reviewList.length && <p className="empty-note" style={{ padding: '12px' }}>No reviews to show here.</p>}
      </div>
    );
  };

  // Flat "List Stores" view — one card per store
  const renderStoreCard = s => {
    const isOpen = !!expandedStore[s.code];
    return (
      <div key={s.code} className="dl-card">
        <button className="dl-card-head" onClick={() => toggleStore(s.code)}>
          <div className="dl-card-name-wrap">
            <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
            <span className="dl-card-name">{s.name}</span>
            {!s.matched && <span className="store-unmatched-flag">⚠ unrecognized code {s.code}</span>}
            <span className="dl-card-count">{s.reviews.length} review{s.reviews.length !== 1 ? 's' : ''} ({s.negCount} neg · {s.posCount} pos)</span>
          </div>
          <div className="dl-card-stats">
            <div className="dl-stat"><span className="dl-stat-label">Avg Rating</span><span className={`dl-stat-value ${ratingClass(s.avg)}`}>{s.avg.toFixed(2)}★</span></div>
            <div className="dl-stat"><span className="dl-stat-label">Negative (1–3★)</span><span className="dl-stat-value">{s.negCount}</span></div>
            <div className="dl-stat"><span className="dl-stat-label">Positive (4–5★)</span><span className="dl-stat-value">{s.posCount}</span></div>
            {category && <div className="dl-stat"><span className="dl-stat-label">{activeCat.label}</span><span className="dl-stat-value">{s.matchCount}</span></div>}
          </div>
        </button>
        {isOpen && renderReviewList(s)}
      </div>
    );
  };

  // "By DL" view — leader card (rolled-up totals) expands to a table of
  // stores, and each store row expands further into its review list —
  // same two-level pattern as the DL tab.
  const renderLeaderCard = g => {
    const isOpen = !!expandedLeader[g.leaderName];
    const sortedStores = sortStores(g.stores);
    return (
      <div key={g.leaderName} className="dl-card">
        <button className="dl-card-head" onClick={() => toggleLeader(g.leaderName)}>
          <div className="dl-card-name-wrap">
            <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
            <span className="dl-card-name">{g.leaderName}</span>
            <span className="dl-card-count">{g.role} · {g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="dl-card-stats">
            <div className="dl-stat"><span className="dl-stat-label">Avg Rating</span><span className={`dl-stat-value ${ratingClass(g.avg)}`}>{g.avg.toFixed(2)}★</span></div>
            <div className="dl-stat"><span className="dl-stat-label">Negative (1–3★)</span><span className="dl-stat-value">{g.neg}</span></div>
            <div className="dl-stat"><span className="dl-stat-label">Positive (4–5★)</span><span className="dl-stat-value">{g.pos}</span></div>
          </div>
        </button>
        {isOpen && (
          <div className="ledger-scroll dl-store-table">
            <table className="ledger-table">
              <thead>
                <tr><th className="ledger-name-col">Store</th><th>Reviews</th><th>Negative</th><th>Positive</th><th>Avg Rating</th></tr>
              </thead>
              <tbody>
                {sortedStores.map(s => {
                  const isStoreOpen = !!expandedStore[s.code];
                  return (
                    <React.Fragment key={s.code}>
                      <tr className="store-row-clickable" onClick={() => toggleStore(s.code)}>
                        <td className="ledger-name-col">
                          <span className={`mini-chevron ${isStoreOpen ? 'mini-chevron--open' : ''}`}>▸</span> {s.name}
                          {!s.matched && <span className="store-unmatched-flag"> ⚠</span>}
                        </td>
                        <td>{s.reviews.length}</td>
                        <td>{s.negCount}</td>
                        <td>{s.posCount}</td>
                        <td className={ratingClass(s.avg)}>{s.avg.toFixed(2)}★</td>
                      </tr>
                      {isStoreOpen && (
                        <tr className="store-expand-row">
                          <td colSpan={5}>{renderReviewList(s)}</td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="tab-content">
      <div className="summary-grid">
        <div className="summary-tile"><p className="summary-tile-label">Total Reviews</p><p className="summary-tile-value">{totalCount}</p></div>
        <div className="summary-tile"><p className="summary-tile-label">Overall Average</p><p className={`summary-tile-value ${ratingClass(overallAvg)}`}>{overallAvg.toFixed(2)}★</p></div>
        <button className={`summary-tile ${sentiment === 'pos' ? 'summary-tile--active' : ''}`} onClick={() => selectSentiment('pos')}>
          <p className="summary-tile-label">Positive (4–5★)</p><p className="summary-tile-value">{positive.length}<span className={`summary-tile-sub ${ratingClass(posAvg)}`}> · {posAvg.toFixed(2)}★ avg</span></p>
        </button>
        <button className={`summary-tile ${sentiment === 'neg' ? 'summary-tile--active' : ''}`} onClick={() => selectSentiment('neg')}>
          <p className="summary-tile-label">Negative (1–3★)</p><p className="summary-tile-value">{negative.length}<span className={`summary-tile-sub ${ratingClass(negAvg)}`}> · {negAvg.toFixed(2)}★ avg</span></p>
        </button>
      </div>
      {sentiment && <button className="btn-ghost btn-clear-filter" onClick={() => setSentiment(null)}>Clear "{sentiment === 'pos' ? 'Positive' : 'Negative'}" filter</button>}

      <p className="section-hint">Tap a category to see negative (1–3★) reviews mentioning it, grouped by store.</p>
      <div className="summary-grid">
        {REVIEW_CATEGORIES.map(c => (
          <button key={c.key} className={`summary-tile ${category === c.key ? 'summary-tile--active' : ''}`} onClick={() => selectCategory(c.key)}>
            <p className="summary-tile-label">{c.label}</p>
            <p className="summary-tile-value">{categoryCounts[c.key]}</p>
          </button>
        ))}
      </div>
      {category && <button className="btn-ghost btn-clear-filter" onClick={() => setCategory(null)}>Clear "{activeCat.label}" filter</button>}

      <SearchBox value={query} onChange={onQuery} placeholder="Search stores…" />
      <div className="ledger-head-row">
        <div className="view-toggle">
          <button className={`view-toggle-btn ${viewMode === 'flat' ? 'active' : ''}`} onClick={() => setViewMode('flat')}>List Stores</button>
          <button className={`view-toggle-btn ${viewMode === 'dl' ? 'active' : ''}`} onClick={() => setViewMode('dl')}>By DL</button>
        </div>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {REVIEW_SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
        </select>
      </div>

      {viewMode === 'flat' && (
        <div className="dl-list">
          {sortStores(filteredStores).map(renderStoreCard)}
          {!filteredStores.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match.</p>}
        </div>
      )}
      {viewMode === 'dl' && (
        <div className="dl-list">
          {sortedGroups.map(renderLeaderCard)}
          {!sortedGroups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No stores match.</p>}
        </div>
      )}
    </div>
  );
}

// ─── Historical Import tab ──────────────────────────────────────────────────
function historySummary(history) {
  const records = Object.values(history || {});
  if (!records.length) return null;
  const stores = new Set(records.map(r => r.code));
  const dates = records.map(r => r.date).sort();
  const sum = key => records.reduce((s, r) => s + (r[key] || 0), 0);
  return {
    dayCount: records.length,
    storeCount: stores.size,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    totalService: sum('service'),
    totalRetail: sum('retail'),
    totalColor: sum('color'),
    totalHours: sum('hours'),
    missingHours: records.filter(r => r.hours == null).length,
    missingSales: records.filter(r => r.service == null).length,
  };
}

function historyByStore(history) {
  const records = Object.values(history || {});
  const byCode = new Map();
  records.forEach(r => {
    if (!byCode.has(r.code)) byCode.set(r.code, { code: r.code, service: 0, retail: 0, color: 0, hours: 0, days: 0 });
    const s = byCode.get(r.code);
    s.service += r.service || 0;
    s.retail += r.retail || 0;
    s.color += r.color || 0;
    s.hours += r.hours || 0;
    s.days += 1;
  });
  return Array.from(byCode.values())
    .map(s => ({ ...s, name: STORE_CODE_TO_NAME[s.code] || null }))
    .sort((a, b) => b.retail - a.retail);
}

// For every calendar day in the covered range, is there ANY record at all
// (any store)? Grouped by month, so a partially-missed file jumps out
// immediately as "24/28 days" instead of just a mysteriously low total.
function historyMonthCoverage(history) {
  const records = Object.values(history || {});
  if (!records.length) return [];
  const dateSet = new Set(records.map(r => r.date));
  const dates = Array.from(dateSet).sort();
  const start = new Date(dates[0] + 'T00:00:00');
  const end = new Date(dates[dates.length - 1] + 'T00:00:00');

  const monthMap = new Map();
  const cur = new Date(start);
  while (cur <= end) {
    const monthKey = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    const iso = cur.toISOString().slice(0, 10);
    if (!monthMap.has(monthKey)) monthMap.set(monthKey, { expected: 0, present: 0 });
    const rec = monthMap.get(monthKey);
    rec.expected += 1;
    if (dateSet.has(iso)) rec.present += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return Array.from(monthMap.entries())
    .map(([month, v]) => ({ month, ...v, missing: v.expected - v.present }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function HistoricalImportTab({ history, onImportSalesBatch, onImportAttendanceBatch, onClearHistory }) {
  const [processingSales, setProcessingSales] = useState(false);
  const [processingAttendance, setProcessingAttendance] = useState(false);
  const [log, setLog] = useState([]);

  const handleSalesFiles = async fileList => {
    setProcessingSales(true);
    const lines = await onImportSalesBatch(fileList);
    setLog(prev => [...lines, ...prev]);
    setProcessingSales(false);
  };

  const handleAttendanceFiles = async fileList => {
    setProcessingAttendance(true);
    const lines = await onImportAttendanceBatch(fileList);
    setLog(prev => [...lines, ...prev]);
    setProcessingAttendance(false);
  };

  const summary = historySummary(history);
  const storeBreakdown = summary ? historyByStore(history) : [];
  const unrecognized = storeBreakdown.filter(s => !s.name);
  const monthCoverage = summary ? historyMonthCoverage(history) : [];
  const incompleteMonths = monthCoverage.filter(m => m.missing > 0);

  return (
    <div className="tab-content">
      <p className="section-hint">
        One-time historical backfill. Upload as many Sales-Accrual and Attendance files as you have — each gets
        boiled down to daily totals per store and added permanently to your history. Re-uploading a file you've
        already done is safe; it just overwrites those exact days with the same numbers.
      </p>

      <div className="history-upload-row">
        <label className={`upload-slot history-upload-slot ${processingSales ? 'upload-slot--filled' : ''}`}>
          <input
            type="file" accept=".xlsx,.xls,.csv" multiple style={{ display: 'none' }}
            onChange={e => { const files = Array.from(e.target.files); if (files.length) handleSalesFiles(files); e.target.value = ''; }}
          />
          <div className="upload-slot-icon">{processingSales ? <span className="spinner small" /> : '📥'}</div>
          <div className="upload-slot-body">
            <p className="upload-slot-title">Sales-Accrual Files</p>
            <p className="upload-slot-hint">Select all your Sales-Accrual exports at once (Sales, Retail, Color)</p>
          </div>
        </label>

        <label className={`upload-slot history-upload-slot ${processingAttendance ? 'upload-slot--filled' : ''}`}>
          <input
            type="file" accept=".xlsx,.xls,.csv" multiple style={{ display: 'none' }}
            onChange={e => { const files = Array.from(e.target.files); if (files.length) handleAttendanceFiles(files); e.target.value = ''; }}
          />
          <div className="upload-slot-icon">{processingAttendance ? <span className="spinner small" /> : '📥'}</div>
          <div className="upload-slot-body">
            <p className="upload-slot-title">Attendance Files</p>
            <p className="upload-slot-hint">Select all your Attendance exports at once (Hours)</p>
          </div>
        </label>
      </div>

      {summary && (
        <div className="summary-grid">
          <div className="summary-tile"><p className="summary-tile-label">Days of History</p><p className="summary-tile-value">{summary.dayCount}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Stores Covered</p><p className="summary-tile-value">{summary.storeCount}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Date Range</p><p className="summary-tile-value" style={{ fontSize: 15 }}>{summary.firstDate} → {summary.lastDate}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Total Hours</p><p className="summary-tile-value">{fmtNum(summary.totalHours, 0)}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Total Service Sales</p><p className="summary-tile-value">{fmt$(summary.totalService)}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Total Retail</p><p className="summary-tile-value">{fmt$(summary.totalRetail)}</p></div>
          <div className="summary-tile"><p className="summary-tile-label">Total Color</p><p className="summary-tile-value">{fmt$(summary.totalColor)}</p></div>
          {(summary.missingHours > 0 || summary.missingSales > 0) && (
            <div className="summary-tile">
              <p className="summary-tile-label">Incomplete Days</p>
              <p className="summary-tile-value" style={{ fontSize: 13 }}>{summary.missingHours} missing hours, {summary.missingSales} missing sales</p>
            </div>
          )}
        </div>
      )}
      {!summary && <p className="empty-note">No historical data stored yet — upload files above to get started.</p>}

      {unrecognized.length > 0 && (
        <div className="unmatched-box">
          <p className="unmatched-title">⚠ {unrecognized.length} store code{unrecognized.length > 1 ? 's' : ''} in your history don't match any known store</p>
          <p className="unmatched-hint">These are likely bad rows (a total/summary line picked up as a store, a typo in a store code, etc.) inflating your totals:</p>
          <ul>
            {unrecognized.map(s => (
              <li key={s.code}>Code {s.code} — {s.days} day{s.days !== 1 ? 's' : ''}, {fmt$(s.service)} service, {fmt$(s.retail)} retail, {fmt$(s.color)} color, {fmtNum(s.hours, 0)} hours</li>
            ))}
          </ul>
        </div>
      )}

      {summary && (
        <>
          <p className="section-label">Calendar coverage by month (any store present that day)</p>
          <div className="ledger-scroll">
            <table className="ledger-table">
              <thead><tr><th className="ledger-name-col">Month</th><th>Days Present</th><th>Days Expected</th><th>Missing</th></tr></thead>
              <tbody>
                {monthCoverage.map(m => (
                  <tr key={m.month}>
                    <td className="ledger-name-col">{m.month}</td>
                    <td>{m.present}</td>
                    <td>{m.expected}</td>
                    <td className={m.missing > 0 ? 'ledger-margin-neg' : ''}>{m.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {incompleteMonths.length === 0 && <p className="empty-note">Every month in your range has full calendar coverage — no whole days missing.</p>}
        </>
      )}

      {summary && (
        <>
          <p className="section-label">All stores in history (sorted by retail)</p>
          <div className="ledger-scroll">
            <table className="ledger-table">
              <thead>
                <tr><th className="ledger-name-col">Store</th><th>Days</th><th>Service</th><th>Retail</th><th>Color</th><th>Hours</th></tr>
              </thead>
              <tbody>
                {storeBreakdown.map(s => (
                  <tr key={s.code}>
                    <td className="ledger-name-col">{s.name || `⚠ Code ${s.code} (unrecognized)`}</td>
                    <td>{s.days}</td>
                    <td>{fmt$(s.service)}</td>
                    <td>{fmt$(s.retail)}</td>
                    <td>{fmt$(s.color)}</td>
                    <td>{fmtNum(s.hours, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {summary && <button className="btn-ghost btn-danger" onClick={onClearHistory}>Clear all historical data</button>}

      {log.length > 0 && (
        <div className="history-log">
          <p className="chart-title">Import log</p>
          {log.map((line, i) => <p key={i} className={`history-log-line ${line.startsWith('✗') ? 'history-log-line--error' : ''}`}>{line}</p>)}
        </div>
      )}
    </div>
  );
}

// ─── Weekly tab ─────────────────────────────────────────────────────────────
function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function expandDateRange(start, end) {
  const dates = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 400) {
    dates.push(cur);
    cur = addDaysISO(cur, 1);
    guard++;
  }
  return dates;
}
const EMPTY_TOTALS = { service: 0, retail: 0, color: 0, hours: 0, giftCards: 0, haircuts: 0 };
function addInto(target, src) {
  target.service += src.service || 0;
  target.retail += src.retail || 0;
  target.color += src.color || 0;
  target.hours += src.hours || 0;
  target.giftCards += src.giftCards || 0;
  target.haircuts += src.haircuts || 0;
}

// Builds one row per week — a real uploaded Stylist Report week where one
// exists, otherwise a Mon–Sun bucket of the daily historical-import data.
// Days already covered by an uploaded weekly report are excluded from the
// daily bucketing, so the two sources can never double-count each other.
function buildWeeklySnapshots(dailyHistory, weeklyHistory) {
  const weeklyEntries = Object.values(weeklyHistory || {});
  const covered = new Set();
  weeklyEntries.forEach(w => expandDateRange(w.startDate, w.endDate).forEach(d => covered.add(d)));

  const dailyWeeks = new Map();
  Object.values(dailyHistory || {}).forEach(r => {
    if (covered.has(r.date)) return;
    const ws = isoWeekStart(r.date);
    if (!dailyWeeks.has(ws)) dailyWeeks.set(ws, { startDate: ws, endDate: addDaysISO(ws, 6), source: 'daily', stores: {} });
    const wk = dailyWeeks.get(ws);
    if (!wk.stores[r.code]) wk.stores[r.code] = { ...EMPTY_TOTALS };
    addInto(wk.stores[r.code], r);
  });

  const weeks = [
    ...weeklyEntries.map(w => ({ startDate: w.startDate, endDate: w.endDate, source: 'weekly', stores: w.stores })),
    ...Array.from(dailyWeeks.values()),
  ];
  weeks.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return weeks;
}

// Attributes each week to the calendar month its start date falls in.
function buildMonthlySnapshots(weeks) {
  const months = new Map();
  weeks.forEach(w => {
    const monthKey = w.startDate.slice(0, 7);
    if (!months.has(monthKey)) months.set(monthKey, { month: monthKey, stores: {} });
    const m = months.get(monthKey);
    Object.entries(w.stores).forEach(([code, v]) => {
      if (!m.stores[code]) m.stores[code] = { ...EMPTY_TOTALS };
      addInto(m.stores[code], v);
    });
  });
  return Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function periodTotals(stores) {
  const t = { ...EMPTY_TOTALS };
  Object.values(stores).forEach(v => addInto(t, v));
  return t;
}

function WeeklyTab({ dailyHistory, weeklyHistory }) {
  const [granularity, setGranularity] = useState('week'); // 'week' | 'month'
  const [grouping, setGrouping] = useState('total'); // 'total' | 'dl'
  const [expandedLeader, setExpandedLeader] = useState({});

  const weeks = useMemo(() => buildWeeklySnapshots(dailyHistory, weeklyHistory), [dailyHistory, weeklyHistory]);
  const months = useMemo(() => buildMonthlySnapshots(weeks), [weeks]);
  const periods = granularity === 'week' ? weeks : months;

  if (!periods.length) {
    return <div className="empty-state"><p className="empty-title">No data yet</p><p>Upload a stylist report or run a historical import to see weekly/monthly snapshots.</p></div>;
  }

  const toggleLeader = name => setExpandedLeader(prev => ({ ...prev, [name]: !prev[name] }));
  const labelFor = p => (granularity === 'week' ? `${p.startDate} → ${p.endDate}` : p.month);

  // For "By DL": every store that appears in ANY period, grouped by leader once — then each period's totals are looked up per leader.
  const dlGroups = useMemo(() => {
    if (grouping !== 'dl') return [];
    const allCodes = new Set();
    periods.forEach(p => Object.keys(p.stores).forEach(c => allCodes.add(c)));
    const rows = Array.from(allCodes).map(code => ({ code }));
    const groups = groupStoresByLeader(rows);
    return groups.map(g => ({ leaderName: g.leaderName, role: g.role, codes: g.stores.map(s => s.code) }));
  }, [periods, grouping]);

  return (
    <div className="tab-content">
      <p className="section-hint">
        Permanent snapshot fed by your weekly Stylist Report uploads (going forward) and the historical import (backfill).
        Re-uploading the same week is always safe — it just replaces that one week's numbers, it never adds on top.
      </p>
      <div className="ledger-head-row">
        <div className="view-toggle">
          <button className={`view-toggle-btn ${granularity === 'week' ? 'active' : ''}`} onClick={() => setGranularity('week')}>By Week</button>
          <button className={`view-toggle-btn ${granularity === 'month' ? 'active' : ''}`} onClick={() => setGranularity('month')}>By Month</button>
        </div>
        <div className="view-toggle">
          <button className={`view-toggle-btn ${grouping === 'total' ? 'active' : ''}`} onClick={() => setGrouping('total')}>Company Total</button>
          <button className={`view-toggle-btn ${grouping === 'dl' ? 'active' : ''}`} onClick={() => setGrouping('dl')}>By DL</button>
        </div>
      </div>

      {grouping === 'total' && (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead><tr><th className="ledger-name-col">{granularity === 'week' ? 'Week' : 'Month'}</th><th>Service Sales</th><th>Color</th><th>Retail</th><th>Gift Cards</th><th>Cuts</th></tr></thead>
            <tbody>
              {[...periods].reverse().map(p => {
                const t = periodTotals(p.stores);
                return (
                  <tr key={granularity === 'week' ? p.startDate : p.month}>
                    <td className="ledger-name-col">{labelFor(p)}{p.source === 'daily' && granularity === 'week' && <span className="store-unmatched-flag"> (backfilled)</span>}</td>
                    <td>{fmt$(t.service)}</td>
                    <td>{fmt$(t.color)}</td>
                    <td>{fmt$(t.retail)}</td>
                    <td>{t.giftCards > 0 ? fmt$(t.giftCards) : '—'}</td>
                    <td>{fmtInt(t.haircuts)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {grouping === 'dl' && (
        <div className="dl-list">
          {dlGroups.map(g => {
            const isOpen = !!expandedLeader[g.leaderName];
            return (
              <div key={g.leaderName} className="dl-card">
                <button className="dl-card-head" onClick={() => toggleLeader(g.leaderName)}>
                  <div className="dl-card-name-wrap">
                    <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
                    <span className="dl-card-name">{g.leaderName}</span>
                    <span className="dl-card-count">{g.role} · {g.codes.length} store{g.codes.length !== 1 ? 's' : ''}</span>
                  </div>
                </button>
                {isOpen && (
                  <div className="ledger-scroll dl-store-table">
                    <table className="ledger-table">
                      <thead><tr><th className="ledger-name-col">{granularity === 'week' ? 'Week' : 'Month'}</th><th>Service Sales</th><th>Color</th><th>Retail</th><th>Gift Cards</th><th>Cuts</th></tr></thead>
                      <tbody>
                        {[...periods].reverse().map(p => {
                          const subset = {};
                          g.codes.forEach(c => { if (p.stores[c]) subset[c] = p.stores[c]; });
                          const t = periodTotals(subset);
                          return (
                            <tr key={granularity === 'week' ? p.startDate : p.month}>
                              <td className="ledger-name-col">{labelFor(p)}</td>
                              <td>{fmt$(t.service)}</td>
                              <td>{fmt$(t.color)}</td>
                              <td>{fmt$(t.retail)}</td>
                              <td>{t.giftCards > 0 ? fmt$(t.giftCards) : '—'}</td>
                              <td>{fmtInt(t.haircuts)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── AI Chat widget ("Tilly") ───────────────────────────────────────────────
// Summarizes what's currently loaded into a compact text blob sent alongside
// each question, so the AI answers from your real numbers instead of guessing.
// Covers the live report AND the full permanent history (every Historical
// Import + every weekly upload, ever), rolled up by month so it stays compact.
function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const start = `${monthKey}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}
// Compact "who sold the most X" lookup: top 5 names by Sales/Retail/Color,
// one line per month, built from the same per-employee data the date-range
// tabs use (getRangeTotals + mergeEmployeesInto/finalizeEmployee) — without
// this, Tilly has zero visibility into any employee, historical or current.
function topEmployeeLine(employees) {
  if (!employees.length) return null;
  const topBy = key => [...employees].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 5)
    .map(e => `${e.name} $${Math.round(e[key] || 0)}`).join(', ');
  return `Sales: ${topBy('sales')} | Retail: ${topBy('retail')} | Color: ${topBy('colorSales')}`;
}
function buildAIContext(report, history, weeklyHistory, goals, reviews) {
  const lines = [];

  if (report) {
    const t = report.companyTotals;
    lines.push(`CURRENT REPORT PERIOD: ${report.dateRangeLabel || 'unknown'}`);
    lines.push(`Company totals — Sales: $${Math.round(t.sales)}, TSTH: $${t.tsth != null ? t.tsth.toFixed(2) : 'n/a'}, Total Hours: ${Math.round(t.totalHours)}, Color Sales: $${Math.round(t.colorSales)}, Retail: $${Math.round(t.retail)}, CPC: ${t.cpc != null ? t.cpc.toFixed(2) : 'n/a'}, RPC: ${t.rpc != null ? t.rpc.toFixed(2) : 'n/a'}`);
    lines.push('');
    lines.push('Per-store totals for the CURRENT period (Store: Sales, TSTH, Hours, Color, Retail, CPC, RPC, goals if set):');
    report.stores.forEach(s => {
      const st = s.totals;
      const goal = goals?.[s.code];
      const goalStr = goal ? ` | Color Goal: ${goal.colorGoal ?? 'none'}, Retail Goal: ${goal.retailGoal ?? 'none'}` : '';
      lines.push(`${s.name}: Sales $${Math.round(st.sales)}, TSTH $${st.tsth != null ? st.tsth.toFixed(2) : 'n/a'}, Hours ${Math.round(st.totalHours)}, Color $${Math.round(st.colorSales)}, Retail $${Math.round(st.retail)}, CPC ${st.cpc != null ? st.cpc.toFixed(2) : 'n/a'}, RPC ${st.rpc != null ? st.rpc.toFixed(2) : 'n/a'}${goalStr}`);
    });
    if (report.allEmployees?.length) {
      const line = topEmployeeLine(report.allEmployees);
      if (line) { lines.push(''); lines.push(`TOP EMPLOYEES THIS PERIOD (top 5 each) — ${line}`); }
    }
  } else {
    lines.push('No current stylist report is loaded on the site right now.');
  }

  // Full permanent history — every Sales-Accrual/Attendance historical import
  // plus every regular weekly upload, ever — rolled up by calendar month so
  // it covers everything without sending years of daily rows.
  const weeks = buildWeeklySnapshots(history, weeklyHistory);
  const months = buildMonthlySnapshots(weeks);
  if (months.length) {
    lines.push('');
    lines.push('COMPANY-WIDE HISTORY BY MONTH (covers every report ever uploaded — Historical Import backfill and every weekly upload):');
    months.forEach(m => {
      const t = periodTotals(m.stores);
      lines.push(`${m.month}: Sales $${Math.round(t.service)}, Color $${Math.round(t.color)}, Retail $${Math.round(t.retail)}, Gift Cards $${Math.round(t.giftCards)}, Hours ${Math.round(t.hours)}`);
    });

    lines.push('');
    lines.push('TOP EMPLOYEES BY MONTH (top 5 each for Sales, Retail, Color Sales — covers every store, from weekly uploads and Sales-Accrual/Attendance historical imports; a name/month missing here means no per-employee data exists for that period):');
    months.forEach(m => {
      const { start, end } = monthRange(m.month);
      const totals = getRangeTotals(history, weeklyHistory, start, end);
      const companyEmployees = {};
      Object.values(totals).forEach(t => { if (t.employees?.length) mergeEmployeesInto(companyEmployees, t.employees); });
      const line = topEmployeeLine(Object.values(companyEmployees).map(finalizeEmployee));
      if (line) lines.push(`${m.month} — ${line}`);
    });
  }

  if (reviews?.reviews?.length) {
    const all = reviews.reviews;
    const avg = all.reduce((s, r) => s + r.rating, 0) / all.length;
    const neg = all.filter(r => r.rating <= 3).length;
    const pos = all.filter(r => r.rating >= 4).length;
    lines.push('');
    lines.push(`REVIEWS: ${all.length} total, average rating ${avg.toFixed(2)}★, ${pos} positive (4-5★), ${neg} negative (1-3★).`);
  }

  return lines.join('\n');
}

// Small badge for the header, next to the title — a scissors mark in the
// app's own navy/red/gold palette (ties into "Supercuts" and the Cuts metric).
function HeaderLogo({ size = 36 }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill="#C23B3B" stroke="#C9A227" strokeWidth="1.5" />
      <g stroke="#fff" strokeWidth="2.1" strokeLinecap="round" fill="none">
        <line x1="14" y1="14" x2="26" y2="26" />
        <line x1="26" y1="14" x2="14" y2="26" />
      </g>
      <circle cx="13" cy="13" r="2.6" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="13" cy="27" r="2.6" fill="none" stroke="#fff" strokeWidth="1.8" />
    </svg>
  );
}

function RobinNestIcon({ size = 28 }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="robinBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6B8CA3" />
          <stop offset="100%" stopColor="#3F5A6E" />
        </linearGradient>
      </defs>
      <ellipse cx="20" cy="31" rx="16" ry="5.5" fill="#B5722F" />
      <path d="M5 30.5 Q20 25 35 30.5" stroke="#8A5423" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M7 28 Q20 23.5 33 28" stroke="#8A5423" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M9.5 25.8 Q20 22 30.5 25.8" stroke="#8A5423" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M8 21 Q3 22.5 4 26 Q8.5 24.5 11 21.5 Z" fill="#3F5A6E" />
      <ellipse cx="20.5" cy="20" rx="9.5" ry="8.5" fill="url(#robinBody)" />
      <ellipse cx="20" cy="24" rx="6.2" ry="5.2" fill="#D9714B" />
      <circle cx="21" cy="11.5" r="6.2" fill="url(#robinBody)" />
      <circle cx="23" cy="10.5" r="1.7" fill="#fff" />
      <circle cx="23.4" cy="10.5" r="0.9" fill="#1A1A1A" />
      <path d="M27 11.8 L31 12.8 L27 14 Z" fill="#E8A33D" />
    </svg>
  );
}

function AIChatWidget({ report, history, weeklyHistory, goals, reviews }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const send = async () => {
    const question = input.trim();
    if (!question || loading) return;
    setMessages(prev => [...prev, { role: 'user', text: question }]);
    setInput('');
    setLoading(true);
    try {
      const context = buildAIContext(report, history, weeklyHistory, goals, reviews);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, context }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', text: res.ok ? data.answer : `Error: ${data.error || 'something went wrong'}` }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Error: couldn't reach Tilly (${err.message})` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button className="ai-chat-fab" onClick={() => setOpen(o => !o)} aria-label="Chat with Tilly">
        {open ? <span className="ai-chat-fab-close">✕</span> : <RobinNestIcon size={38} />}
      </button>
      {open && (
        <div className="ai-chat-panel">
          <p className="ai-chat-header">🪺 Tilly — ask about your metrics</p>
          <div className="ai-chat-messages">
            {!messages.length && <p className="ai-chat-empty">Try: "which store has the lowest TSTH right now?" or "how did color sales trend over the last few months?"</p>}
            {messages.map((m, i) => <div key={i} className={`ai-chat-msg ai-chat-msg--${m.role}`}>{m.text}</div>)}
            {loading && <div className="ai-chat-msg ai-chat-msg--assistant">Tilly is thinking…</div>}
          </div>
          <div className="ai-chat-input-row">
            <input
              className="ai-chat-input" value={input} placeholder="Ask Tilly a question…"
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send(); }}
            />
            <button className="ai-chat-send" onClick={send} disabled={loading}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Setup tab ──────────────────────────────────────────────────────────────
const SETUP_SECTIONS = [
  { key: 'guide', label: 'Guide' },
  { key: 'goals', label: 'Goals' },
  { key: 'history', label: 'Historical Import' },
  { key: 'upload', label: 'Upload' },
];

function SetupTab({ configured, section, onSection, goalsProps, historyProps, uploadProps }) {
  const steps = [
    { n: 1, title: 'Export this week\u2019s stylist report', body: 'Run the report with every store and every employee under it, covering the week you want to see.' },
    { n: 2, title: 'Upload it', body: 'Go to the Upload section below and drop it into the "Stylist Report" slot. The date range fills in automatically.' },
    { n: 3, title: 'Optionally upload employee start dates', body: 'A simple Employee Name + Start Date export. Drop it into the "Employee Start Dates" slot to power the "60 Day Employee" tab, which shows anyone hired in the last 60 days along with their store, DL, and sales — even if they don\u2019t have sales data yet.' },
    { n: 4, title: 'Explore the tabs', body: 'Overview: tap a metric to see the top/bottom 10 stores. Stores: every location, click one to see its employees. Employees: every stylist company-wide. Retail / Color Sales: grouped by DL, or toggle to a flat list. DL: rolled-up totals per leader, click to expand their stores. 60 Day Employee: recent hires. Reviews: totals, negative-review categories, and per-store review lists with employee call-outs. Every tab has a search box.' },
    { n: 5, title: 'Next week', body: 'Just upload a new stylist report the same way \u2014 it replaces this week\u2019s data for everyone viewing the site.' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className="setup-status setup-status--warn">
        If your name doesn't start with Evan and end in Robins, you're not supposed to be here.
      </div>
      <div className={`setup-status ${configured ? 'setup-status--ok' : 'setup-status--warn'}`}>
        {configured
          ? '✓ Connected to Supabase — your data syncs across devices.'
          : '⚠ Supabase not connected — data is only saved on this device.'}
      </div>

      <div className="view-toggle">
        {SETUP_SECTIONS.map(s => (
          <button key={s.key} className={`view-toggle-btn ${section === s.key ? 'active' : ''}`} onClick={() => onSection(s.key)}>{s.label}</button>
        ))}
      </div>

      {section === 'goals' && <GoalsTab {...goalsProps} />}
      {section === 'history' && <HistoricalImportTab {...historyProps} />}
      {section === 'upload' && <UploadTab {...uploadProps} />}

      {section === 'guide' && <>
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
      </>}
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Stores', 'Employees', 'Retail', 'Color Sales', 'DL', '60 Day Employee', 'Reviews', 'Weekly', 'Setup'];

export default function App() {
  const [report, setReport] = useState(null);
  const [employeeRoster, setEmployeeRoster] = useState(null);
  const [goals, setGoals] = useState({});
  const [reviews, setReviews] = useState(null);
  const [reviewNotes, setReviewNotes] = useState({});
  const [history, setHistory] = useState({});
  const [weeklyHistory, setWeeklyHistory] = useState({});
  const [dateRange, setDateRangeState] = useState({ start: null, end: null });
  const setDateRange = (start, end) => setDateRangeState({ start, end });
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [setupSection, setSetupSection] = useState('guide');
  const [toast, setToast] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingRoster, setUploadingRoster] = useState(false);
  const [uploadingReviews, setUploadingReviews] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('tsth');
  const [queries, setQueries] = useState({ Overview: '', Stores: '', Employees: '', Retail: '', 'Color Sales': '', DL: '', '60 Day Employee': '', Reviews: '' });

  useEffect(() => {
    Promise.all([
      loadData('stylist_report'), loadData('employee_start_dates'), loadData('store_goals'), loadData('reviews'), loadData('review_notes'),
      loadDataByPrefix('daily_history_'), loadDataByPrefix('weekly_history_'),
      loadData('daily_history'), loadData('weekly_history'), // legacy single-row format, if anything was saved before chunking
    ]).then(([reportRes, rosterRes, goalsRes, reviewsRes, reviewNotesRes, dailyChunksRes, weeklyChunksRes, legacyDailyRes, legacyWeeklyRes]) => {
      if (reportRes.data) setReport(reportRes.data); else { setTab('Setup'); setSetupSection('upload'); }
      if (rosterRes.data) setEmployeeRoster(rosterRes.data);
      if (goalsRes.data) setGoals(goalsRes.data);
      if (reviewsRes.data) setReviews(reviewsRes.data);
      if (reviewNotesRes.data) setReviewNotes(reviewNotesRes.data);

      const mergedDaily = {};
      (dailyChunksRes.data || []).forEach(chunk => Object.assign(mergedDaily, chunk.payload));
      if (legacyDailyRes.data) Object.assign(mergedDaily, legacyDailyRes.data);
      setHistory(mergedDaily);

      const mergedWeekly = {};
      (weeklyChunksRes.data || []).forEach(chunk => Object.assign(mergedWeekly, chunk.payload));
      if (legacyWeeklyRes.data) Object.assign(mergedWeekly, legacyWeeklyRes.data);
      setWeeklyHistory(mergedWeekly);

      setLoading(false);
      if (isConfigured() && (reportRes.source === 'local' || rosterRes.source === 'local' || goalsRes.source === 'local' || reviewsRes.source === 'local' || dailyChunksRes.source === 'local' || weeklyChunksRes.source === 'local')) {
        const err = reportRes.error || rosterRes.error || goalsRes.error || reviewsRes.error || dailyChunksRes.error || weeklyChunksRes.error;
        showToast(`Couldn't reach Supabase (${err || 'unknown error'}) — showing this device's local data only`, 'error');
      }

      // Some chunks can exist only in this device's local backup — e.g. a
      // prior historical-import save that timed out against Supabase (large
      // payload) but still wrote to localStorage. Re-push those now so the
      // gap is healed for every device, not just this one.
      const recoveredDaily = dailyChunksRes.localOnlyKeys || [];
      const recoveredWeekly = weeklyChunksRes.localOnlyKeys || [];
      if (isConfigured() && (recoveredDaily.length || recoveredWeekly.length)) {
        Promise.all([
          ...recoveredDaily.map(key => {
            const chunk = {};
            Object.entries(mergedDaily).forEach(([k, rec]) => { if (`daily_history_${rec.date.slice(0, 7)}` === key) chunk[k] = rec; });
            return saveData(key, chunk);
          }),
          ...recoveredWeekly.map(key => {
            const chunk = {};
            Object.entries(mergedWeekly).forEach(([k, rec]) => { if (`weekly_history_${rec.startDate.slice(0, 7)}` === key) chunk[k] = rec; });
            return saveData(key, chunk);
          }),
        ]).then(results => {
          const failed = results.filter(r => !r.ok);
          if (failed.length) {
            showToast(`Found ${recoveredDaily.length + recoveredWeekly.length} month(s) of history that only existed on this device — some still won't sync to Supabase (${failed[0].error}). Keep using this device for now.`, 'error');
          } else {
            showToast(`Recovered and re-synced ${recoveredDaily.length + recoveredWeekly.length} month(s) of history that had failed to sync earlier.`);
          }
        });
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

      // Also feed this week into the permanent weekly history. Keyed by the
      // report's own start/end dates, so re-uploading the same week just
      // overwrites that one entry — it can never double-count. Saved as one
      // small chunk per month rather than the whole growing history at once,
      // so this never risks a Supabase statement timeout as it accumulates.
      const weekRecord = buildWeeklyRecord(parsed);
      let weeklyResult = { ok: true };
      if (weekRecord) {
        const nextWeekly = mergeWeeklyIntoHistory(weeklyHistory, weekRecord);
        setWeeklyHistory(nextWeekly);
        const month = weekRecord.startDate.slice(0, 7);
        const chunk = {};
        Object.entries(nextWeekly).forEach(([key, rec]) => { if (rec.startDate.slice(0, 7) === month) chunk[key] = rec; });
        weeklyResult = await saveData(`weekly_history_${month}`, chunk);
      }

      if (isConfigured() && (!result.ok || !weeklyResult.ok)) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error || weeklyResult.error}) — only visible on this device`, 'error');
      } else {
        showToast(`Loaded ${file.name} — ${parsed.storeCount} stores, ${parsed.employeeCount} employees`);
      }
      setTab('Overview');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }, [weeklyHistory]);

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
    setTab('Setup');
    setSetupSection('upload');
    showToast('Stylist report cleared');
  };

  const handleClearRoster = async () => {
    if (!window.confirm('Clear the employee start-date list? This cannot be undone.')) return;
    await clearData('employee_start_dates');
    setEmployeeRoster(null);
    showToast('Start-date list cleared');
  };

  const handleReviewsFile = useCallback(async file => {
    setUploadingReviews(true);
    try {
      const parsed = await parseReviews(file);
      setReviews(parsed);
      const result = await saveData('reviews', parsed);
      if (isConfigured() && !result.ok) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
      } else {
        showToast(`Loaded ${file.name} — ${parsed.reviews.length} reviews on file`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploadingReviews(false);
    }
  }, []);

  const handleClearReviews = async () => {
    if (!window.confirm('Clear the uploaded reviews? This cannot be undone.')) return;
    await clearData('reviews');
    setReviews(null);
    showToast('Reviews cleared');
  };

  // Notes live in their own db key (not inside reviews.reviews) so they
  // survive a fresh re-upload of the reviews export, which rebuilds that
  // array from scratch every time.
  const handleAddReviewNote = useCallback((key, text) => {
    setReviewNotes(prev => {
      const next = { ...prev, [key]: [...(prev[key] || []), { text, at: new Date().toISOString() }] };
      saveData('review_notes', next).then(result => {
        if (isConfigured() && !result.ok) {
          showToast(`Note saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
        }
      });
      return next;
    });
  }, []);

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

  const saveHistoryMonthChunks = async (working, touchedMonths) => {
    let ok = true;
    let lastError = null;
    const failedMonths = [];
    for (const month of touchedMonths) {
      const chunk = {};
      Object.entries(working).forEach(([key, rec]) => { if (rec.date.slice(0, 7) === month) chunk[key] = rec; });
      const result = await saveData(`daily_history_${month}`, chunk);
      if (!result.ok) { ok = false; lastError = result.error; failedMonths.push(month); }
    }
    return { ok, error: lastError, failedMonths };
  };

  const handleImportSalesBatch = useCallback(async fileList => {
    let working = history;
    const touchedMonths = new Set();
    const lines = [];
    for (const file of fileList) {
      try {
        const parsed = await parseSalesAccrualFile(file);
        working = mergeSalesIntoHistory(working, parsed.records);
        parsed.records.forEach(r => touchedMonths.add(r.date.slice(0, 7)));
        lines.push(`✓ ${file.name} — ${parsed.records.length} store-days`);
      } catch (err) {
        lines.push(`✗ ${file.name} — ${err.message}`);
      }
    }
    setHistory(working);
    const result = await saveHistoryMonthChunks(working, touchedMonths);
    if (isConfigured() && !result.ok) {
      lines.push(`✗ Couldn't sync ${result.failedMonths.join(', ')} to Supabase (${result.error}) — this data is safe on this device (it'll auto-retry syncing next time you load the app), but won't show up on other devices until it does. Try the import again or reload the page to trigger a retry.`);
      showToast(`Imported, but couldn't sync to Supabase (${result.error})`, 'error');
    } else {
      showToast(`Processed ${fileList.length} sales file${fileList.length !== 1 ? 's' : ''}`);
    }
    return lines;
  }, [history]);

  const handleImportAttendanceBatch = useCallback(async fileList => {
    let working = history;
    const touchedMonths = new Set();
    const lines = [];
    for (const file of fileList) {
      try {
        const parsed = await parseAttendanceHistoryFile(file);
        working = mergeAttendanceIntoHistory(working, parsed.records);
        parsed.records.forEach(r => touchedMonths.add(r.date.slice(0, 7)));
        lines.push(`✓ ${file.name} — ${parsed.records.length} store-days`);
      } catch (err) {
        lines.push(`✗ ${file.name} — ${err.message}`);
      }
    }
    setHistory(working);
    const result = await saveHistoryMonthChunks(working, touchedMonths);
    if (isConfigured() && !result.ok) {
      lines.push(`✗ Couldn't sync ${result.failedMonths.join(', ')} to Supabase (${result.error}) — this data is safe on this device (it'll auto-retry syncing next time you load the app), but won't show up on other devices until it does. Try the import again or reload the page to trigger a retry.`);
      showToast(`Imported, but couldn't sync to Supabase (${result.error})`, 'error');
    } else {
      showToast(`Processed ${fileList.length} attendance file${fileList.length !== 1 ? 's' : ''}`);
    }
    return lines;
  }, [history]);

  const handleClearHistory = async () => {
    if (!window.confirm('Clear all historical data? This cannot be undone.')) return;
    await clearDataByPrefix('daily_history_');
    await clearData('daily_history'); // legacy single-row format, if it exists
    setHistory({});
    showToast('Historical data cleared');
  };

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  const needsReport = !report && tab !== 'Setup' && tab !== '60 Day Employee' && tab !== 'Reviews' && tab !== 'Weekly';

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="app-header">
        <div className="header-left">
          <HeaderLogo />
          <div>
            <h1 className="app-title">Supercuts Metrics</h1>
            <p className="app-subtitle">{label || 'Weekly performance across every location'}</p>
          </div>
        </div>
      </header>

      <nav className="tab-nav">
        {TABS.map(t => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <main className="app-main">
        {needsReport && <div className="empty-state"><p className="empty-title">No report yet</p><p>Go to the Setup tab's Upload section to add this week's report.</p></div>}
        {!needsReport && tab === 'Overview' && report && (
          <OverviewTab report={report} selected={selectedMetric} onSelect={setSelectedMetric} query={queries.Overview} onQuery={v => setQuery('Overview', v)} />
        )}
        {!needsReport && tab === 'Stores' && report && (
          <StoresTab report={report} query={queries.Stores} onQuery={v => setQuery('Stores', v)} history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange} />
        )}
        {!needsReport && tab === 'Employees' && report && (
          <EmployeesTab report={report} query={queries.Employees} onQuery={v => setQuery('Employees', v)} />
        )}
        {!needsReport && tab === 'Retail' && report && (
          <StoreMetricTab
            report={report} query={queries.Retail} onQuery={v => setQuery('Retail', v)}
            title="Retail" metricA={{ key: 'retail', label: 'Retail', fmt: fmt$ }} metricB={{ key: 'rpc', label: 'RPC', fmt: fmtNum }}
            goalType="retailGoal" goals={goals}
            history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange}
          />
        )}
        {!needsReport && tab === 'Color Sales' && report && (
          <StoreMetricTab
            report={report} query={queries['Color Sales']} onQuery={v => setQuery('Color Sales', v)}
            title="Color Sales" metricA={{ key: 'colorSales', label: 'Color Sales', fmt: fmt$ }} metricB={{ key: 'cpc', label: 'CPC', fmt: fmtNum }}
            goalType="colorGoal" goals={goals}
            history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange}
            showPrevMonthColor
          />
        )}
        {!needsReport && tab === 'DL' && report && (
          <DLTab report={report} query={queries.DL} onQuery={v => setQuery('DL', v)} history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange} />
        )}
        {tab === '60 Day Employee' && (
          <NewHireTab report={report} employeeRoster={employeeRoster} query={queries['60 Day Employee']} onQuery={v => setQuery('60 Day Employee', v)} />
        )}
        {tab === 'Reviews' && (
          <ReviewsTab
            report={report} reviews={reviews} query={queries.Reviews} onQuery={v => setQuery('Reviews', v)}
            reviewNotes={reviewNotes} onAddReviewNote={handleAddReviewNote}
          />
        )}
        {tab === 'Weekly' && (
          <WeeklyTab dailyHistory={history} weeklyHistory={weeklyHistory} />
        )}
        {tab === 'Setup' && (
          <SetupTab
            configured={isConfigured()} section={setupSection} onSection={setSetupSection}
            goalsProps={{ report, goals, onSaveGoal: handleSaveGoal, onImportGoals: handleImportGoals }}
            historyProps={{ history, onImportSalesBatch: handleImportSalesBatch, onImportAttendanceBatch: handleImportAttendanceBatch, onClearHistory: handleClearHistory }}
            uploadProps={{
              report, uploading, onFile: handleFile, onClear: handleClearAll,
              employeeRoster, uploadingRoster, onRosterFile: handleRosterFile, onClearRoster: handleClearRoster,
              reviews, uploadingReviews, onReviewsFile: handleReviewsFile, onClearReviews: handleClearReviews,
            }}
          />
        )}
      </main>
      <AIChatWidget report={report} history={history} weeklyHistory={weeklyHistory} goals={goals} reviews={reviews} />
    </div>
  );
}
