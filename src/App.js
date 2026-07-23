import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { loadData, saveData, clearData, isConfigured, loadDataByPrefix, clearDataByPrefix } from './db';
import {
  parseStylistReport, parseEmployeeStartDates, parseGoalFile, parseManagerFile, parseMilestoneGoalFile, parseReviews, normalizeName,
  parseSalesAccrualFile, parseAttendanceHistoryFile, mergeSalesIntoHistory, mergeAttendanceIntoHistory,
  buildWeeklyRecord, mergeWeeklyIntoHistory,
} from './parser';
import { LEADER_ROSTER_SECTIONS, getLeaderForStoreCode } from './leaderRoster';
import { getCodeForStoreName, STORE_CODE_TO_NAME } from './storeDirectory';
import './App.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip);

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = n => Number(n || 0).toLocaleString('en-US');
const fmtRate = n => (n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`);
const fmtNum = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));

// ─── Date display — named months everywhere, instead of raw ISO numbers ────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "2026-05-14..." -> "May 14, 2026"
function fmtDateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}
// "2026-05" -> "May 2026"
function fmtMonthLong(monthKey) {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
// "2026-05-01" + "2026-05-07" -> "May 1 – May 7, 2026" (or across months/years, spells both out)
function fmtDateRangeLong(startISO, endISO) {
  if (!startISO || !endISO) return '';
  const [sy, sm, sd] = startISO.slice(0, 10).split('-').map(Number);
  const [ey, em, ed] = endISO.slice(0, 10).split('-').map(Number);
  if (!sy || !ey) return `${startISO} – ${endISO}`;
  const startPart = sy === ey ? `${MONTH_NAMES[sm - 1]} ${sd}` : `${MONTH_NAMES[sm - 1]} ${sd}, ${sy}`;
  return `${startPart} – ${MONTH_NAMES[em - 1]} ${ed}, ${ey}`;
}

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
  { key: 'cph', label: 'CPH', fmt: n => fmtNum(n, 2) },
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
  { key: 'cph', label: 'CPH', fmt: n => fmtNum(n, 2) },
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

// TSTH of 54+ is green, under 54 is red — used everywhere a TSTH value renders.
const TSTH_TARGET = 54;
function tsthClass(value) { return value == null ? '' : value >= TSTH_TARGET ? 'tsth-good' : 'tsth-bad'; }

// Manager tagging — `managers` is a { storeCode: managerName } map the user
// maintains in Setup. Matched by normalized name against that store's
// employee rows so the MANAGER tag follows whoever's currently assigned,
// even if the manager's own sales/hours row is present or not that week.
function withManagerFlag(employees, managers, code) {
  const managerName = managers?.[code];
  if (!managerName) return employees;
  const target = normalizeName(managerName);
  return employees.map(e => ({ ...e, isManager: normalizeName(e.name) === target }));
}

// Sideways progress bar toward a Milestone (stretch) goal, with a tick mark
// showing where the Goal (the number they HAVE to hit) sits along the same
// bar, and the exact % off to the right — % is against Milestone specifically
// (not Goal), and is allowed to read over 100% rather than clamping the label
// once a store blows past its stretch target.
function MilestoneThermometer({ actual, goal, milestone }) {
  if (milestone == null || milestone <= 0) return <span className="empty-note">—</span>;
  const pct = actual != null ? (actual / milestone) * 100 : null;
  const fillPct = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  const goalPct = goal != null ? Math.max(0, Math.min(100, (goal / milestone) * 100)) : null;
  const status = pct == null ? 'none' : goal != null && actual < goal ? 'behind' : pct < 100 ? 'onpace' : 'hit';
  return (
    <div className="thermo-wrap">
      <div className={`thermo-bar thermo-bar--${status}`}>
        <div className="thermo-fill" style={{ width: `${fillPct}%` }} />
        {goalPct != null && <div className="thermo-goal-tick" style={{ left: `${goalPct}%` }} title={`Goal: ${fmt$(goal)}`} />}
      </div>
      <span className="thermo-pct">{pct != null ? `${Math.round(pct)}%` : '—'}</span>
    </div>
  );
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
    cph: totalHours > 0 ? totalHaircuts / totalHours : null,
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
    cph: e.totalHours > 0 ? e.haircuts / e.totalHours : null,
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
    cph: hours > 0 ? haircuts / hours : null,
    employees: t?.employees || [],
  };
}

// A `report` blob cached before CPH existed (e.g. sitting in Supabase from
// an old upload) won't have `.cph` on its stores/employees — it's baked in
// at parse time, not recomputed on load, unlike the historical/date-range
// paths above which always derive it fresh. Patch it in here so CPH shows
// up immediately rather than only after the next weekly upload.
function ensureReportCph(report) {
  if (!report) return report;
  report.stores.forEach(s => {
    s.employees.forEach(e => { e.cph = e.totalHours > 0 ? e.haircuts / e.totalHours : null; });
    s.totals.cph = s.totals.totalHours > 0 ? s.totals.haircuts / s.totals.totalHours : null;
  });
  report.allEmployees = report.stores.flatMap(s => s.employees.map(e => ({ ...e, store: s.name })));
  report.companyTotals.cph = report.companyTotals.totalHours > 0 ? report.companyTotals.haircuts / report.companyTotals.totalHours : null;
  return report;
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

// ─── Homepage — Top 10 widgets ─────────────────────────────────────────────
// Paints a plain white rect behind the chart on every frame — a chart.js
// canvas is transparent by default, so without this the exported PNG has no
// background and looks broken when dropped into a dark Slack/email client.
const homepagePngBg = {
  id: 'homepagePngBg',
  beforeDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, chart.width, chart.height);
    ctx.restore();
  },
};

const TOP_TEN_METRICS = [
  { key: 'retail', label: 'Retail', emoji: '🛍️', color: '#2E7D4F' },
  { key: 'colorSales', label: 'Color Sales', emoji: '🎨', color: '#9B2E2E' },
  { key: 'cph', label: 'CPH', emoji: '✂️', color: '#1F3A63' },
  { key: 'tsth', label: 'TSTH', emoji: '⭐', color: '#C9A227' },
];

// One store-per-bar leaderboard chart. Single series (one metric) so no
// legend box is needed — the title already says what's plotted; the top 3
// bars get a medal emoji baked into their label for a little personality.
function TopTenChart({ title, emoji, rows, metricKey, formatter, color }) {
  const chartRef = useRef(null);
  const ranked = useMemo(() => sortByMetric(rows, metricKey, 'desc').filter(r => r[metricKey] != null).slice(0, 10), [rows, metricKey]);
  const medal = i => (i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '');

  const data = useMemo(() => ({
    labels: ranked.map((r, i) => `${medal(i)}${r.name}`),
    datasets: [{ data: ranked.map(r => r[metricKey] || 0), backgroundColor: color, borderRadius: 4, barThickness: 18, maxBarThickness: 20 }],
  }), [ranked, metricKey, color]);

  // Draws the value at the tip of each bar (bar → value at the tip) in ink
  // color, never the series color — the layout.padding.right below reserves
  // room for it so it's never clipped even when a bar reaches the max.
  const valueLabelPlugin = useMemo(() => ({
    id: `value-label-${metricKey}`,
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      const { ctx } = chart;
      ctx.save();
      ctx.font = "600 11px 'IBM Plex Mono', monospace";
      ctx.fillStyle = '#142A4A';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      meta.data.forEach((bar, i) => {
        const val = ranked[i]?.[metricKey];
        if (val == null) return;
        ctx.fillText(formatter(val), bar.x + 6, bar.y);
      });
      ctx.restore();
    },
  }), [ranked, metricKey, formatter]);

  const options = useMemo(() => ({
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: { right: 52 } },
    animation: { duration: 650, easing: 'easeOutQuart' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#142A4A', titleColor: '#fff', bodyColor: '#fff',
        titleFont: { family: 'Inter', size: 12, weight: '600' }, bodyFont: { family: 'IBM Plex Mono', size: 12 },
        padding: 10, cornerRadius: 8, displayColors: false,
        callbacks: {
          title: items => ranked[items[0].dataIndex]?.name || '',
          label: item => formatter(item.raw),
        },
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        grid: { color: '#E1E7ED' }, border: { display: false },
        ticks: { font: { family: 'IBM Plex Mono', size: 10 }, color: '#5A6B80', callback: v => formatter(v) },
      },
      y: {
        grid: { display: false }, border: { display: false },
        ticks: { font: { family: 'Inter', size: 11.5 }, color: '#142A4A' },
      },
    },
  }), [ranked, formatter]);

  const handleExport = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.toBase64Image('image/png', 1);
    const a = document.createElement('a');
    a.href = url;
    a.download = `top10-${title.replace(/\s+/g, '-').toLowerCase()}.png`;
    a.click();
  };

  return (
    <div className="homepage-widget">
      <div className="homepage-widget-head">
        <p className="homepage-widget-title">{emoji} Top 10 — {title}</p>
        <button className="homepage-export-btn" onClick={handleExport} disabled={!ranked.length}>⬇ PNG</button>
      </div>
      {ranked.length ? (
        <div className="homepage-widget-chart">
          <Bar ref={chartRef} data={data} options={options} plugins={[homepagePngBg, valueLabelPlugin]} />
        </div>
      ) : <p className="empty-note">No data yet.</p>}
    </div>
  );
}

// Reads an uploaded image, downscales it to a reasonable header-banner size,
// and re-encodes as a JPEG data URL — a phone photo can be several MB, and
// these get stored inline in the same Supabase jsonb payload as everything
// else, so an unresized image would bloat every load/save. maxDim 960 / 0.72
// quality lands most photos in the tens-of-KB range, plenty for a banner.
function readImageAsDataURL(file, maxDim = 960, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Could not read this image — try a different file.'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error('Failed to read the image file.'));
    reader.readAsDataURL(file);
  });
}

function ImageUploadField({ value, onChange, label, onError }) {
  const [busy, setBusy] = useState(false);
  const handleFile = async file => {
    setBusy(true);
    try {
      onChange(await readImageAsDataURL(file));
    } catch (err) {
      if (onError) onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="homepage-image-field">
      <label className="homepage-image-upload">
        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; }} />
        {busy ? <span className="spinner small" /> : (value ? '🖼 Replace image' : `🖼 ${label}`)}
      </label>
      {value && (
        <div className="homepage-image-preview-wrap">
          <img className="homepage-image-preview" src={value} alt="" />
          <button type="button" className="homepage-delete-btn" onClick={() => onChange(null)} title="Remove image">✕</button>
        </div>
      )}
    </div>
  );
}

function NewsComposer({ onAdd, onImageError }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const submit = e => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim(), body.trim(), image);
    setTitle(''); setBody(''); setImage(null);
  };
  return (
    <form className="homepage-composer" onSubmit={submit}>
      <input className="homepage-input" placeholder="Headline…" value={title} onChange={e => setTitle(e.target.value)} />
      <textarea className="homepage-textarea" placeholder="Details (optional)…" value={body} onChange={e => setBody(e.target.value)} rows={2} />
      <ImageUploadField value={image} onChange={setImage} onError={onImageError} label="Header image (optional)" />
      <button type="submit" className="btn-primary homepage-post-btn" disabled={!title.trim()}>Post update</button>
    </form>
  );
}

function EventComposer({ onAdd, onImageError }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState(null);
  const submit = e => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    onAdd(title.trim(), date, description.trim(), image);
    setTitle(''); setDate(''); setDescription(''); setImage(null);
  };
  return (
    <form className="homepage-composer" onSubmit={submit}>
      <input className="homepage-input" placeholder="Event name…" value={title} onChange={e => setTitle(e.target.value)} />
      <input type="date" className="date-range-input" value={date} onChange={e => setDate(e.target.value)} />
      <textarea className="homepage-textarea" placeholder="Details (optional)…" value={description} onChange={e => setDescription(e.target.value)} rows={2} />
      <ImageUploadField value={image} onChange={setImage} onError={onImageError} label="Header image (optional)" />
      <button type="submit" className="btn-primary homepage-post-btn" disabled={!title.trim() || !date}>Add event</button>
    </form>
  );
}

// The 3 soonest upcoming events, shown as large banner cards above the
// calendar grid — the "featured" strip the user asked for.
function FeaturedEvents({ events, todayISO }) {
  const upcoming = useMemo(
    () => events.filter(ev => ev.date >= todayISO).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3),
    [events, todayISO]
  );
  const daysUntil = iso => {
    const diff = Math.round((new Date(`${iso}T00:00:00`) - new Date(`${todayISO}T00:00:00`)) / 86400000);
    if (diff === 0) return 'Today 🎉';
    if (diff === 1) return 'Tomorrow';
    return `In ${diff} days`;
  };
  if (!upcoming.length) return <p className="empty-note">No upcoming events on the calendar.</p>;
  return (
    <div className="homepage-featured-events">
      {upcoming.map(ev => (
        <div key={ev.id} className="homepage-featured-card" style={ev.headerImage ? { backgroundImage: `url(${ev.headerImage})` } : undefined}>
          <div className="homepage-featured-overlay">
            <span className="homepage-featured-badge">{daysUntil(ev.date)}</span>
            <p className="homepage-featured-title">{ev.title}</p>
            <p className="homepage-featured-date">{fmtDateLong(ev.date)}</p>
            {ev.description && <p className="homepage-featured-desc">{ev.description}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

const CAL_WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Plain month-grid calendar — Sun-start, prev/next nav, a colored pill per
// event landing on that day (capped at 2 visible + an overflow count).
function EventsCalendar({ events, todayISO }) {
  const [cal, setCal] = useState(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; });
  const monthLabel = fmtMonthLong(`${cal.y}-${String(cal.m + 1).padStart(2, '0')}`);

  const eventsByDay = useMemo(() => {
    const map = {};
    const monthKey = `${cal.y}-${String(cal.m + 1).padStart(2, '0')}`;
    events.forEach(ev => {
      if (!ev.date || !ev.date.startsWith(monthKey)) return;
      const day = Number(ev.date.slice(8, 10));
      (map[day] = map[day] || []).push(ev);
    });
    return map;
  }, [events, cal]);

  const cells = useMemo(() => {
    const firstWeekday = new Date(cal.y, cal.m, 1).getDay();
    const daysInMonth = new Date(cal.y, cal.m + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < firstWeekday; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [cal]);

  const prevMonth = () => setCal(c => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const nextMonth = () => setCal(c => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));

  return (
    <div className="homepage-calendar">
      <div className="homepage-calendar-head">
        <button type="button" className="homepage-cal-nav" onClick={prevMonth} aria-label="Previous month">‹</button>
        <p className="homepage-calendar-month">{monthLabel}</p>
        <button type="button" className="homepage-cal-nav" onClick={nextMonth} aria-label="Next month">›</button>
      </div>
      <div className="homepage-calendar-weekdays">
        {CAL_WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="homepage-calendar-grid">
        {cells.map((day, i) => {
          if (day == null) return <div key={i} className="homepage-cal-cell homepage-cal-cell--empty" />;
          const iso = `${cal.y}-${String(cal.m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const dayEvents = eventsByDay[day] || [];
          return (
            <div key={i} className={`homepage-cal-cell ${iso === todayISO ? 'homepage-cal-cell--today' : ''}`}>
              <span className="homepage-cal-daynum">{day}</span>
              {dayEvents.slice(0, 2).map(ev => <span key={ev.id} className="homepage-cal-pill" title={ev.title}>{ev.title}</span>)}
              {dayEvents.length > 2 && <span className="homepage-cal-more">+{dayEvents.length - 2} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HomepageTab({ report, news, events }) {
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const sortedNews = useMemo(() => [...news].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')), [news]);
  const storeRows = useMemo(() => report ? report.stores.map(s => ({ name: s.name, code: s.code, ...s.totals })) : [], [report]);

  return (
    <div className="tab-content">
      <div className="homepage-hero">
        <p className="homepage-hero-eyebrow">{fmtDateLong(todayISO)}</p>
        <p className="homepage-hero-title">Welcome back 👋</p>
        <p className="homepage-hero-sub">Here's what's new, what's coming up, and who's leading the pack this period.</p>
      </div>

      <div className="homepage-grid">
        <div className="homepage-main">
          <div className="homepage-section">
            <p className="section-label">📣 News &amp; Updates</p>
            <div className="homepage-feed">
              {sortedNews.map(n => (
                <div className="homepage-feed-item" key={n.id}>
                  {n.headerImage && <img className="homepage-feed-item-image" src={n.headerImage} alt="" />}
                  <p className="homepage-feed-item-title">{n.title}</p>
                  {n.body && <p className="homepage-feed-item-body">{n.body}</p>}
                  <p className="homepage-feed-item-date">{fmtDateLong(n.date)}</p>
                </div>
              ))}
              {!sortedNews.length && <p className="empty-note">No news posted yet — post one from Setup → Homepage.</p>}
            </div>
          </div>

          <div className="homepage-section">
            <p className="section-label">📅 Upcoming Events</p>
            <FeaturedEvents events={events} todayISO={todayISO} />
            <EventsCalendar events={events} todayISO={todayISO} />
          </div>
        </div>

        <div className="homepage-sidebar">
          {report ? TOP_TEN_METRICS.map(m => (
            <TopTenChart
              key={m.key} title={m.label} emoji={m.emoji} rows={storeRows} metricKey={m.key}
              formatter={STORE_METRICS.find(sm => sm.key === m.key).fmt} color={m.color}
            />
          )) : (
            <div className="homepage-widget"><p className="empty-note">Upload a stylist report to see the Top 10 leaderboards.</p></div>
          )}
        </div>
      </div>
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
function StoresTab({ report, query, onQuery, history, weeklyHistory, dateRange, onDateRangeChange, managers }) {
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
                  <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className={`dl-stat-value ${tsthClass(s.tsth)}`}>{fmtRate(s.tsth)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(s.totalHours, 0)}</span></div>
                  <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(s.colorSales)}</span></div>
                  {s.cpc != null && <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(s.cpc)}</span></div>}
                  <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(s.retail)}</span></div>
                  {s.rpc != null && <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(s.rpc)}</span></div>}
                  <div className="dl-stat"><span className="dl-stat-label">Cuts</span><span className="dl-stat-value">{fmtInt(s.haircuts)}</span></div>
                  {s.cph != null && <div className="dl-stat"><span className="dl-stat-label">CPH</span><span className="dl-stat-value">{fmtNum(s.cph)}</span></div>}
                </div>
              </button>
              {isOpen && hasEmployeeData && (
                <div className="dl-store-table">
                  <EmployeeTable
                    rows={sortByMetric(withManagerFlag(s.employees, managers, s.code), 'sales', 'desc')}
                    showStoreCol={false}
                    footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts, cph: s.cph }}
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
              <td className={`ledger-rate ${tsthClass(t.tsth)}`}>{fmtRate(t.tsth)}</td>
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
              <td className="ledger-name-col">{e.name}{e.isManager && <span className="manager-tag"> MANAGER</span>}</td>
              {showStoreCol && <td className="ledger-store-col">{e.store}</td>}
              {EMPLOYEE_METRICS.map(m => (
                <td key={m.key} className={m.key === 'tsth' ? `ledger-rate ${tsthClass(e[m.key])}` : ''}>{m.fmt(e[m.key])}</td>
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
                <td key={m.key} className={m.key === 'tsth' ? `ledger-rate ${tsthClass(footer[m.key])}` : ''}>{m.fmt(footer[m.key])}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {!rows.length && <p className="empty-note" style={{ textAlign: 'center', padding: '16px' }}>No employees match your search.</p>}
    </div>
  );
}

function EmployeesTab({ report, query, onQuery, managers }) {
  const [sortBy, setSortBy] = useState('sales');
  const [focused, setFocused] = useState(null);
  // Store code isn't on the flat allEmployees rows (only the store NAME is),
  // so resolve it via the same name->code lookup goals/reviews already use.
  const allEmployeesWithManagerFlag = useMemo(() => {
    return report.allEmployees.map(e => {
      const code = getCodeForStoreName(e.store);
      const managerName = code ? managers?.[code] : null;
      return { ...e, isManager: !!managerName && normalizeName(managerName) === normalizeName(e.name) };
    });
  }, [report.allEmployees, managers]);
  const filtered = useMemo(() => {
    if (!query.trim()) return allEmployeesWithManagerFlag;
    const q = query.trim().toLowerCase();
    return allEmployeesWithManagerFlag.filter(e => e.name.toLowerCase().includes(q) || e.store.toLowerCase().includes(q));
  }, [allEmployeesWithManagerFlag, query]);
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
function StoreMetricTab({ report, query, onQuery, title, metricA, metricB, goalType, goals, history, weeklyHistory, dateRange, onDateRangeChange, showPrevMonthColor, managers }) {
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
                                      rows={sortByMetric(withManagerFlag(s.employees, managers, s.code), 'sales', 'desc')}
                                      showStoreCol={false}
                                      footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts, cph: s.cph }}
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
                            rows={sortByMetric(withManagerFlag(s.employees, managers, s.code), 'sales', 'desc')}
                            showStoreCol={false}
                            footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts, cph: s.cph }}
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
function DLTab({ report, query, onQuery, history, weeklyHistory, dateRange, onDateRangeChange, managers, milestoneGoals }) {
  const [expanded, setExpanded] = useState({});
  const [expandedStore, setExpandedStore] = useState({});
  const [showManagers, setShowManagers] = useState(false);
  const isHistorical = !!(dateRange.start && dateRange.end);

  // Milestone goals are monthly, so "actual" for the thermometer is always
  // month-to-date sales — independent of whatever the DL tab's own date
  // range filter is set to (same reasoning as Retail/Color's Prev Month
  // Color stat).
  const monthToDateSalesByCode = useMemo(() => {
    const { start, end } = getCurrentMonthRange();
    const totals = getRangeTotals(history, weeklyHistory, start, end);
    const map = {};
    Object.entries(totals).forEach(([code, t]) => { map[code] = historyTotalsToReportShape(t).sales; });
    return map;
  }, [history, weeklyHistory]);
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

      <div className="view-toggle">
        <button className={`view-toggle-btn ${!showManagers ? 'active' : ''}`} onClick={() => setShowManagers(false)}>Full Stats</button>
        <button className={`view-toggle-btn ${showManagers ? 'active' : ''}`} onClick={() => setShowManagers(true)}>👔 Managers</button>
      </div>

      {!filteredGroups.length && <p className="empty-note" style={{ textAlign: 'center' }}>No matches for "{query}".</p>}

      {showManagers && grouped.map(([role, roleGroups]) => (
        <div key={role}>
          <p className="section-label" style={{ marginBottom: 4 }}>{role}</p>
          <div className="dl-list">
            {roleGroups.map(g => {
              const t = rollupRows(g.stores);
              const groupGoal = g.stores.reduce((s, st) => s + (milestoneGoals?.[st.code]?.goal ?? 0), 0);
              const groupMilestone = g.stores.reduce((s, st) => s + (milestoneGoals?.[st.code]?.milestone ?? 0), 0);
              const groupActual = g.stores.reduce((s, st) => s + (monthToDateSalesByCode[st.code] ?? 0), 0);
              return (
                <div key={g.leaderName} className="dl-card">
                  <div className="dl-card-head" style={{ cursor: 'default' }}>
                    <div className="dl-card-name-wrap">
                      <span className="dl-card-name">{g.leaderName}</span>
                      <span className="dl-card-count">{g.stores.length} store{g.stores.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="dl-card-stats">
                      <div className="dl-stat"><span className="dl-stat-label">Sales</span><span className="dl-stat-value">{fmt$(t.sales)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className={`dl-stat-value ${tsthClass(t.tsth)}`}>{fmtRate(t.tsth)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(t.totalHours, 0)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(t.colorSales)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(t.cpc)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(t.retail)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(t.rpc)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Cuts</span><span className="dl-stat-value">{fmtInt(t.haircuts)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">CPH</span><span className="dl-stat-value">{fmtNum(t.cph)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Goal</span><span className="dl-stat-value">{groupGoal > 0 ? fmt$(groupGoal) : '—'}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Milestone</span><span className="dl-stat-value">{groupMilestone > 0 ? fmt$(groupMilestone) : '—'}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Progress</span><MilestoneThermometer actual={groupActual} goal={groupGoal} milestone={groupMilestone} /></div>
                    </div>
                  </div>
                  <div className="ledger-scroll dl-store-table">
                    <table className="ledger-table">
                      <thead>
                        <tr>
                          <th className="ledger-name-col">Store</th><th className="ledger-name-col">Manager</th>
                          <th>Sales</th><th>TSTH</th><th>Total Hours</th><th>Color Sales</th>
                          <th>CPC</th><th>Retail</th><th>RPC</th><th>Cuts</th><th>CPH</th>
                          <th>Goal</th><th>Milestone</th><th>Progress</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortByMetric(g.stores, 'sales', 'desc').map(s => (
                          <tr key={s.code}>
                            <td className="ledger-name-col">{s.name}</td>
                            <td className="ledger-name-col">{managers?.[s.code] || <span className="empty-note">not set</span>}</td>
                            <td>{fmt$(s.sales)}</td>
                            <td className={`ledger-rate ${tsthClass(s.tsth)}`}>{fmtRate(s.tsth)}</td>
                            <td>{fmtNum(s.totalHours, 0)}</td>
                            <td>{fmt$(s.colorSales)}</td>
                            <td>{fmtNum(s.cpc)}</td>
                            <td>{fmt$(s.retail)}</td>
                            <td>{fmtNum(s.rpc)}</td>
                            <td>{fmtInt(s.haircuts)}</td>
                            <td>{fmtNum(s.cph)}</td>
                            <td>{milestoneGoals?.[s.code]?.goal != null ? fmt$(milestoneGoals[s.code].goal) : '—'}</td>
                            <td>{milestoneGoals?.[s.code]?.milestone != null ? fmt$(milestoneGoals[s.code].milestone) : '—'}</td>
                            <td><MilestoneThermometer actual={monthToDateSalesByCode[s.code]} goal={milestoneGoals?.[s.code]?.goal} milestone={milestoneGoals?.[s.code]?.milestone} /></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="ledger-avg-row">
                          <td className="ledger-name-col">{g.leaderName} total / weighted avg</td>
                          <td className="ledger-name-col"></td>
                          <td>{fmt$(t.sales)}</td>
                          <td className={`ledger-rate ${tsthClass(t.tsth)}`}>{fmtRate(t.tsth)}</td>
                          <td>{fmtNum(t.totalHours, 0)}</td>
                          <td>{fmt$(t.colorSales)}</td>
                          <td>{fmtNum(t.cpc)}</td>
                          <td>{fmt$(t.retail)}</td>
                          <td>{fmtNum(t.rpc)}</td>
                          <td>{fmtInt(t.haircuts)}</td>
                          <td>{fmtNum(t.cph)}</td>
                          <td>{groupGoal > 0 ? fmt$(groupGoal) : '—'}</td>
                          <td>{groupMilestone > 0 ? fmt$(groupMilestone) : '—'}</td>
                          <td><MilestoneThermometer actual={groupActual} goal={groupGoal} milestone={groupMilestone} /></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!showManagers && grouped.map(([role, roleGroups]) => (
        <div key={role}>
          <p className="section-label" style={{ marginBottom: 4 }}>{role}</p>
          <div className="dl-list">
            {roleGroups.map(g => {
              const t = rollupRows(g.stores);
              const isOpen = !!expanded[g.leaderName];
              const groupGoal = g.stores.reduce((s, st) => s + (milestoneGoals?.[st.code]?.goal ?? 0), 0);
              const groupMilestone = g.stores.reduce((s, st) => s + (milestoneGoals?.[st.code]?.milestone ?? 0), 0);
              const groupActual = g.stores.reduce((s, st) => s + (monthToDateSalesByCode[st.code] ?? 0), 0);
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
                      <div className="dl-stat"><span className="dl-stat-label">TSTH</span><span className={`dl-stat-value ${tsthClass(t.tsth)}`}>{fmtRate(t.tsth)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Hours</span><span className="dl-stat-value">{fmtNum(t.totalHours, 0)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Color</span><span className="dl-stat-value">{fmt$(t.colorSales)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">CPC</span><span className="dl-stat-value">{fmtNum(t.cpc)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Retail</span><span className="dl-stat-value">{fmt$(t.retail)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">RPC</span><span className="dl-stat-value">{fmtNum(t.rpc)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Cuts</span><span className="dl-stat-value">{fmtInt(t.haircuts)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">CPH</span><span className="dl-stat-value">{fmtNum(t.cph)}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Goal</span><span className="dl-stat-value">{groupGoal > 0 ? fmt$(groupGoal) : '—'}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Milestone</span><span className="dl-stat-value">{groupMilestone > 0 ? fmt$(groupMilestone) : '—'}</span></div>
                      <div className="dl-stat"><span className="dl-stat-label">Progress</span><MilestoneThermometer actual={groupActual} goal={groupGoal} milestone={groupMilestone} /></div>
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
                            <th>CPH</th>
                            <th>Goal</th>
                            <th>Milestone</th>
                            <th>Progress</th>
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
                                  <td className={`ledger-rate ${tsthClass(s.tsth)}`}>{fmtRate(s.tsth)}</td>
                                  <td>{fmtNum(s.totalHours, 0)}</td>
                                  <td>{fmt$(s.colorSales)}</td>
                                  <td>{fmtNum(s.cpc)}</td>
                                  <td>{fmt$(s.retail)}</td>
                                  <td>{fmtNum(s.rpc)}</td>
                                  <td>{fmtInt(s.haircuts)}</td>
                                  <td>{fmtNum(s.cph)}</td>
                                  <td>{milestoneGoals?.[s.code]?.goal != null ? fmt$(milestoneGoals[s.code].goal) : '—'}</td>
                                  <td>{milestoneGoals?.[s.code]?.milestone != null ? fmt$(milestoneGoals[s.code].milestone) : '—'}</td>
                                  <td><MilestoneThermometer actual={monthToDateSalesByCode[s.code]} goal={milestoneGoals?.[s.code]?.goal} milestone={milestoneGoals?.[s.code]?.milestone} /></td>
                                </tr>
                                {isStoreOpen && hasEmployeeData && (
                                  <tr className="store-expand-row">
                                    <td colSpan={13}>
                                      <EmployeeTable
                                        rows={sortByMetric(withManagerFlag(s.employees, managers, s.code), 'sales', 'desc')}
                                        showStoreCol={false}
                                        footer={{ sales: s.sales, colorSales: s.colorSales, retail: s.retail, cpc: s.cpc, rpc: s.rpc, tsth: s.tsth, totalHours: s.totalHours, haircuts: s.haircuts, cph: s.cph }}
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
                <td>{fmtDateLong(r.startDate)}</td>
                <td>{r.daysAgo}</td>
                <td className="ledger-store-col">{r.store || '—'}</td>
                <td className="ledger-store-col">{r.dl || '—'}</td>
                <td>{r.sales != null ? fmt$(r.sales) : '—'}</td>
                <td>{r.colorSales != null ? fmt$(r.colorSales) : '—'}</td>
                <td>{r.retail != null ? fmt$(r.retail) : '—'}</td>
                <td>{r.cpc != null ? fmtNum(r.cpc) : '—'}</td>
                <td>{r.rpc != null ? fmtNum(r.rpc) : '—'}</td>
                <td className={`ledger-rate ${tsthClass(r.tsth)}`}>{r.tsth != null ? fmtRate(r.tsth) : '—'}</td>
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

// ─── Managers tab (store → manager assignment, powers the MANAGER tag) ─────
function ManagersTab({ report, managers, onSaveManager, onImportManagers }) {
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState({}); // { code: name } — in-progress edits
  const [importing, setImporting] = useState(false);

  if (!report) {
    return <div className="empty-state"><p className="empty-title">No report yet</p><p>Upload a stylist report first, so there's a store list to assign managers to.</p></div>;
  }

  const stores = report.stores
    .map(s => ({ name: s.name, code: s.code }))
    .filter(s => !query.trim() || s.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const getVal = code => (drafts[code] !== undefined ? drafts[code] : (managers?.[code] || ''));
  const handleChange = (code, value) => setDrafts(prev => ({ ...prev, [code]: value }));
  const handleBlur = code => {
    const raw = drafts[code];
    if (raw === undefined) return;
    onSaveManager(code, raw.trim() || null);
  };
  const handleImportFile = async file => {
    setImporting(true);
    await onImportManagers(file);
    setImporting(false);
  };

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={setQuery} placeholder="Search stores…" />
      <p className="section-hint">Assign who manages each store — type their name exactly as it appears in the stylist report so it gets a MANAGER tag wherever employees are listed (Stores, Employees, DL, Retail, Color Sales). The DL tab's "Managers" view rolls this up by DL, and this always saves even if the name doesn't match yet.</p>

      {onImportManagers && (
        <div className="goal-import-row">
          <label className="goal-import-btn">
            <input
              type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value = ''; }}
            />
            {importing ? <span className="spinner small" /> : '📥'} Import Managers from file (Store | Manager columns)
          </label>
        </div>
      )}

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Store</th>
              <th className="ledger-name-col">Manager</th>
            </tr>
          </thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.code}>
                <td className="ledger-name-col">{s.name}</td>
                <td className="ledger-name-col">
                  <input
                    type="text" className="goal-input" placeholder="Manager name"
                    value={getVal(s.code)}
                    onChange={e => handleChange(s.code, e.target.value)}
                    onBlur={() => handleBlur(s.code)}
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

// ─── Homepage admin (Setup > Homepage) — compose/manage News & Events ──────
// Posting lives here, not on the Homepage tab itself, so the public-facing
// landing page stays read-only and can't be edited by accident — same split
// as Goals/Managers (edit in Setup, display everywhere else).
function HomepageAdminTab({ news, events, onAddNews, onDeleteNews, onAddEvent, onDeleteEvent, onImageError }) {
  const sortedNews = useMemo(() => [...news].sort((a, b) => (b.date || '').localeCompare(a.date || '')), [news]);
  const sortedEvents = useMemo(() => [...events].sort((a, b) => (a.date || '').localeCompare(b.date || '')), [events]);

  return (
    <div className="tab-content">
      <p className="section-hint">Post News &amp; Updates and log Events here — both support an optional header image. They show up on the Homepage tab; events also appear on its calendar, with the 3 soonest featured above it.</p>

      <div className="homepage-admin-columns">
        <div className="homepage-section">
          <p className="section-label">📣 News &amp; Updates</p>
          <NewsComposer onAdd={onAddNews} onImageError={onImageError} />
          <div className="homepage-admin-list">
            {sortedNews.map(n => (
              <div className="homepage-admin-row" key={n.id}>
                {n.headerImage && <img className="homepage-admin-thumb" src={n.headerImage} alt="" />}
                <div className="homepage-admin-row-body">
                  <p className="homepage-admin-row-title">{n.title}</p>
                  <p className="homepage-admin-row-date">{fmtDateLong(n.date)}</p>
                </div>
                <button className="homepage-delete-btn" onClick={() => onDeleteNews(n.id)} title="Delete">✕</button>
              </div>
            ))}
            {!sortedNews.length && <p className="empty-note">Nothing posted yet.</p>}
          </div>
        </div>

        <div className="homepage-section">
          <p className="section-label">📅 Events</p>
          <EventComposer onAdd={onAddEvent} onImageError={onImageError} />
          <div className="homepage-admin-list">
            {sortedEvents.map(ev => (
              <div className="homepage-admin-row" key={ev.id}>
                {ev.headerImage && <img className="homepage-admin-thumb" src={ev.headerImage} alt="" />}
                <div className="homepage-admin-row-body">
                  <p className="homepage-admin-row-title">{ev.title}</p>
                  <p className="homepage-admin-row-date">{fmtDateLong(ev.date)}</p>
                </div>
                <button className="homepage-delete-btn" onClick={() => onDeleteEvent(ev.id)} title="Delete">✕</button>
              </div>
            ))}
            {!sortedEvents.length && <p className="empty-note">No events logged yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Milestone Goals tab (Goal | Milestone per store, powers the DL tab thermometer) ─
function MilestoneGoalsTab({ report, milestoneGoals, onSaveMilestoneGoal, onImportMilestoneGoals }) {
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState({}); // { code: { goal, milestone } } — in-progress edits
  const [importing, setImporting] = useState(false);

  if (!report) {
    return <div className="empty-state"><p className="empty-title">No report yet</p><p>Upload a stylist report first, so there's a store list to set milestone goals for.</p></div>;
  }

  const stores = report.stores
    .map(s => ({ name: s.name, code: s.code }))
    .filter(s => !query.trim() || s.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const getVal = (code, field) => {
    if (drafts[code]?.[field] !== undefined) return drafts[code][field];
    return milestoneGoals?.[code]?.[field] ?? '';
  };
  const handleChange = (code, field, value) => setDrafts(prev => ({ ...prev, [code]: { ...prev[code], [field]: value } }));
  const handleBlur = (code, field) => {
    const raw = drafts[code]?.[field];
    if (raw === undefined) return;
    const num = raw === '' ? null : Number(raw);
    onSaveMilestoneGoal(code, field, isNaN(num) ? null : num);
  };
  const handleImportFile = async file => {
    setImporting(true);
    await onImportMilestoneGoals(file);
    setImporting(false);
  };

  return (
    <div className="tab-content">
      <SearchBox value={query} onChange={setQuery} placeholder="Search stores…" />
      <p className="section-hint">Goal is the number a store HAS to hit this month; Milestone is a stretch target above it. These power the "Progress" thermometer on the DL tab, compared against each store's month-to-date sales. Updated monthly.</p>

      {onImportMilestoneGoals && (
        <div className="goal-import-row">
          <label className="goal-import-btn">
            <input
              type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value = ''; }}
            />
            {importing ? <span className="spinner small" /> : '📥'} Import Milestone Goals from file (Salon | Goal | Milestone columns)
          </label>
        </div>
      )}

      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th className="ledger-name-col">Store</th>
              <th>Goal</th>
              <th>Milestone</th>
            </tr>
          </thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.code}>
                <td className="ledger-name-col">{s.name}</td>
                <td>
                  <input
                    type="number" className="goal-input" placeholder="$0"
                    value={getVal(s.code, 'goal')}
                    onChange={e => handleChange(s.code, 'goal', e.target.value)}
                    onBlur={() => handleBlur(s.code, 'goal')}
                  />
                </td>
                <td>
                  <input
                    type="number" className="goal-input" placeholder="$0"
                    value={getVal(s.code, 'milestone')}
                    onChange={e => handleChange(s.code, 'milestone', e.target.value)}
                    onBlur={() => handleBlur(s.code, 'milestone')}
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

function ReviewCard({ review, employeeMatch, notes, onAddNote, goldComb, onToggleGoldComb }) {
  const tone = review.rating <= 2 ? 'neg' : review.rating >= 4 ? 'pos' : 'neu';
  return (
    <div className={`review-card review-card--${tone}${goldComb ? ' review-card--gold' : ''}`}>
      <div className="review-card-head">
        <StarRating value={review.rating} />
        <span className="review-user">{review.userName || 'Anonymous'}</span>
        <span className="review-date">{review.postedAt ? fmtDateLong(review.postedAt) : ''}</span>
        {onToggleGoldComb && (
          <button
            className={`gold-comb-btn${goldComb ? ' gold-comb-btn--active' : ''}`}
            onClick={onToggleGoldComb}
            title={goldComb ? 'Remove Gold Comb acknowledgment' : 'Award this review a Gold Comb'}
          >
            🏆 {goldComb ? 'Gold Comb' : 'Give Gold Comb'}
          </button>
        )}
      </div>
      {review.message && <p className="review-message">{review.message}</p>}
      {employeeMatch && <p className="review-employee-tag">👤 Mentions: {employeeMatch}</p>}
      {onAddNote && <ReviewNotes notes={notes || []} onAdd={text => onAddNote(reviewKey(review), text)} />}
    </div>
  );
}

const GOLD_CELEBRATION_STARS = ['⭐', '🌟', '⭐', '🌟', '⭐'];
function GoldCombCelebration() {
  return (
    <div className="gold-celebration" role="status">
      <div className="gold-celebration-card">
        <div className="gold-celebration-stars">
          {GOLD_CELEBRATION_STARS.map((star, i) => (
            <span key={i} className="gold-celebration-star" style={{ animationDelay: `${i * 0.12}s` }}>{star}</span>
          ))}
        </div>
        <p className="gold-celebration-text">Great Job! 🏆</p>
      </div>
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
  { key: 'noNotes', label: 'No Notes' },
];

function ReviewsTab({ report, reviews, query, onQuery, reviewNotes, onAddReviewNote, goldCombs, onToggleGoldComb }) {
  const [viewMode, setViewMode] = useState('flat'); // 'flat' | 'dl'
  const [category, setCategory] = useState(null);
  const [sentiment, setSentiment] = useState(null); // null | 'pos' | 'neg'
  const [expandedStore, setExpandedStore] = useState({});
  const [expandedLeader, setExpandedLeader] = useState({});
  const [sortBy, setSortBy] = useState('reviews');
  const [mentionedOnly, setMentionedOnly] = useState(false);

  const selectCategory = key => { setCategory(prev => prev === key ? null : key); setSentiment(null); };
  const selectSentiment = key => { setSentiment(prev => prev === key ? null : key); setCategory(null); };
  const employeesForCode = code => report?.stores.find(st => st.code === code)?.employees || null;
  const reviewHasMention = r => !!detectEmployeeMention(r.message, employeesForCode(r.code));

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
    const sentimentMatcher = category
      ? r => isNegativeReview(r) && reviewMatchesCategory(r.message, category)
      : sentiment === 'pos' ? isPositiveReview
      : sentiment === 'neg' ? isNegativeReview
      : null;
    const matcher = (sentimentMatcher || mentionedOnly)
      ? r => (!sentimentMatcher || sentimentMatcher(r)) && (!mentionedOnly || reviewHasMention(r))
      : null;
    return Array.from(storeMap.values())
      .map(s => {
        const matching = matcher ? s.reviews.filter(matcher) : null;
        const avg = s.reviews.length ? s.reviews.reduce((a, r) => a + r.rating, 0) / s.reviews.length : 0;
        return {
          ...s, avg,
          negCount: s.reviews.filter(isNegativeReview).length,
          posCount: s.reviews.filter(isPositiveReview).length,
          noNotesCount: s.reviews.filter(r => !(reviewNotes?.[reviewKey(r)]?.length)).length,
          matchCount: matching ? matching.length : null,
        };
      })
      .filter(s => !matcher || s.matchCount > 0);
  }, [storeMap, category, sentiment, mentionedOnly, reviewNotes, report]);

  const filteredStores = useMemo(() => {
    if (!query.trim()) return storeRows;
    const q = query.trim().toLowerCase();
    return storeRows.filter(s => s.name.toLowerCase().includes(q));
  }, [storeRows, query]);

  const sortStores = arr => {
    const a2 = [...arr];
    if (sortBy === 'negative') a2.sort((a, b) => b.negCount - a.negCount);
    else if (sortBy === 'positive') a2.sort((a, b) => b.posCount - a.posCount);
    else if (sortBy === 'noNotes') a2.sort((a, b) => b.noNotesCount - a.noNotesCount);
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
        noNotes: g.stores.reduce((s, st) => s + st.noNotesCount, 0),
      };
    });
  }, [filteredStores, viewMode]);

  const sortedGroups = useMemo(() => {
    if (!groups) return null;
    const g2 = [...groups];
    if (sortBy === 'negative') g2.sort((a, b) => b.neg - a.neg);
    else if (sortBy === 'positive') g2.sort((a, b) => b.pos - a.pos);
    else if (sortBy === 'noNotes') g2.sort((a, b) => b.noNotes - a.noNotes);
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
    if (mentionedOnly) reviewList = reviewList.filter(r => !!detectEmployeeMention(r.message, employeesForStore));
    return (
      <div className="dl-store-table review-list">
        {reviewList.map((r, i) => (
          <ReviewCard
            key={i} review={r} employeeMatch={detectEmployeeMention(r.message, employeesForStore)}
            notes={reviewNotes?.[reviewKey(r)]} onAddNote={onAddReviewNote}
            goldComb={!!goldCombs?.[reviewKey(r)]} onToggleGoldComb={onToggleGoldComb ? () => onToggleGoldComb(reviewKey(r)) : undefined}
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
            <div className="dl-stat"><span className="dl-stat-label">No Notes</span><span className="dl-stat-value">{s.noNotesCount}</span></div>
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
            <div className="dl-stat"><span className="dl-stat-label">No Notes</span><span className="dl-stat-value">{g.noNotes}</span></div>
          </div>
        </button>
        {isOpen && (
          <div className="ledger-scroll dl-store-table">
            <table className="ledger-table">
              <thead>
                <tr><th className="ledger-name-col">Store</th><th>Reviews</th><th>Negative</th><th>Positive</th><th>No Notes</th><th>Avg Rating</th></tr>
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
                        <td>{s.noNotesCount}</td>
                        <td className={ratingClass(s.avg)}>{s.avg.toFixed(2)}★</td>
                      </tr>
                      {isStoreOpen && (
                        <tr className="store-expand-row">
                          <td colSpan={6}>{renderReviewList(s)}</td>
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

      <div className="view-toggle" style={{ alignSelf: 'flex-start' }}>
        <button className={`view-toggle-btn ${mentionedOnly ? 'active' : ''}`} onClick={() => setMentionedOnly(v => !v)}>
          {mentionedOnly ? '✓ ' : ''}Only reviews mentioning an employee by name
        </button>
      </div>

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

  // try/catch here is defense-in-depth: onImportSalesBatch/onImportAttendanceBatch
  // already catch their own errors, but if anything unexpected still throws,
  // this guarantees the spinner clears and something is shown instead of the
  // UI silently hanging with no feedback at all.
  const handleSalesFiles = async fileList => {
    setProcessingSales(true);
    try {
      const lines = await onImportSalesBatch(fileList);
      setLog(prev => [...lines, ...prev]);
    } catch (err) {
      setLog(prev => [`✗ Unexpected error: ${err.message}`, ...prev]);
    } finally {
      setProcessingSales(false);
    }
  };

  const handleAttendanceFiles = async fileList => {
    setProcessingAttendance(true);
    try {
      const lines = await onImportAttendanceBatch(fileList);
      setLog(prev => [...lines, ...prev]);
    } catch (err) {
      setLog(prev => [`✗ Unexpected error: ${err.message}`, ...prev]);
    } finally {
      setProcessingAttendance(false);
    }
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
          <div className="summary-tile"><p className="summary-tile-label">Date Range</p><p className="summary-tile-value" style={{ fontSize: 15 }}>{fmtDateLong(summary.firstDate)} → {fmtDateLong(summary.lastDate)}</p></div>
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
                    <td className="ledger-name-col">{fmtMonthLong(m.month)}</td>
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

// ISO week number + ISO week-year (Monday-start weeks, matching isoWeekStart
// above), so "week 12" of one year lines up with "week 12" of another for a
// fair side-by-side comparison instead of drifting with where Jan 1 falls.
function isoWeekInfo(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  d.setDate(d.getDate() - day + 3); // Thursday of this week
  const isoYear = d.getFullYear();
  const yearStart = new Date(isoYear, 0, 1);
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { isoYear, week };
}
// Inverse of isoWeekInfo — the Monday (ISO date) that starts week N of a
// given ISO week-year. Jan 4th always falls in week 1, so week 1's Monday
// is the Monday of the week containing Jan 4th.
function isoWeekToMonday(isoYear, week) {
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7; // Mon=0..Sun=6
  const week1Monday = addDaysISO(jan4.toISOString().slice(0, 10), -jan4Day);
  return addDaysISO(week1Monday, (week - 1) * 7);
}

const WEEKLY_METRICS = [
  { key: 'service', label: 'Service Sales', fmt: fmt$ },
  { key: 'color', label: 'Color Sales', fmt: fmt$ },
  { key: 'retail', label: 'Retail', fmt: fmt$ },
  { key: 'giftCards', label: 'Gift Cards', fmt: fmt$ },
  { key: 'hours', label: 'Total Hours', fmt: n => fmtNum(n, 0) },
  { key: 'haircuts', label: 'Cuts', fmt: fmtInt },
  { key: 'cph', label: 'CPH (Cuts per Hour)', fmt: n => fmtNum(n, 2) },
];
function weeklyMetricValue(t, key) {
  if (key === 'cph') return t.hours > 0 ? t.haircuts / t.hours : null;
  return t[key];
}

// One row per week-of-year (1–53) or month-of-year (1–12), with the current
// and previous calendar year's totals for the chosen metric side by side —
// only rows where at least one of the two years has data are included, and
// multiple periods landing in the same bucket (e.g. a week split between an
// uploaded partial week and a backfilled remainder) are summed together.
function buildYoYRows(periods, granularity, metricKey, currentYear, previousYear) {
  const byYear = new Map();
  periods.forEach(p => {
    let year, bucket;
    if (granularity === 'week') {
      const info = isoWeekInfo(p.startDate);
      year = info.isoYear; bucket = info.week;
    } else {
      year = Number(p.month.slice(0, 4));
      bucket = Number(p.month.slice(5, 7));
    }
    if (year !== currentYear && year !== previousYear) return;
    if (!byYear.has(year)) byYear.set(year, new Map());
    const yearMap = byYear.get(year);
    const existing = yearMap.get(bucket) || { ...EMPTY_TOTALS };
    addInto(existing, periodTotals(p.stores));
    yearMap.set(bucket, existing);
  });

  const curMap = byYear.get(currentYear) || new Map();
  const prevMap = byYear.get(previousYear) || new Map();
  const buckets = Array.from(new Set([...curMap.keys(), ...prevMap.keys()])).sort((a, b) => a - b);
  // Week labels always show the CURRENT year's actual dates for that week
  // number — the previous year's matching week falls a few days off (that's
  // the point of aligning by week-of-year), so one anchor date avoids
  // showing two different, confusing date ranges on the same row.
  const labelFor = b => {
    if (granularity !== 'week') return MONTH_NAMES[b - 1];
    const monday = isoWeekToMonday(currentYear, b);
    return fmtDateRangeLong(monday, addDaysISO(monday, 6));
  };
  return buckets.map(b => ({
    bucket: b,
    label: labelFor(b),
    current: curMap.has(b) ? weeklyMetricValue(curMap.get(b), metricKey) : null,
    previous: prevMap.has(b) ? weeklyMetricValue(prevMap.get(b), metricKey) : null,
  }));
}

function WeeklyTab({ dailyHistory, weeklyHistory }) {
  const [granularity, setGranularity] = useState('week'); // 'week' | 'month'
  const [grouping, setGrouping] = useState('total'); // 'total' | 'dl'
  const [metric, setMetric] = useState('service');
  const [expandedLeader, setExpandedLeader] = useState({});

  const weeks = useMemo(() => buildWeeklySnapshots(dailyHistory, weeklyHistory), [dailyHistory, weeklyHistory]);
  const months = useMemo(() => buildMonthlySnapshots(weeks), [weeks]);
  const periods = granularity === 'week' ? weeks : months;

  if (!periods.length) {
    return <div className="empty-state"><p className="empty-title">No data yet</p><p>Upload a stylist report or run a historical import to see weekly/monthly snapshots.</p></div>;
  }

  const toggleLeader = name => setExpandedLeader(prev => ({ ...prev, [name]: !prev[name] }));
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;
  const activeMetric = WEEKLY_METRICS.find(m => m.key === metric);

  // For "By DL": every store that appears in ANY period, grouped by leader once.
  const dlGroups = useMemo(() => {
    if (grouping !== 'dl') return [];
    const allCodes = new Set();
    periods.forEach(p => Object.keys(p.stores).forEach(c => allCodes.add(c)));
    const rows = Array.from(allCodes).map(code => ({ code }));
    const groups = groupStoresByLeader(rows);
    return groups.map(g => ({ leaderName: g.leaderName, role: g.role, codes: g.stores.map(s => s.code) }));
  }, [periods, grouping]);

  const totalRows = useMemo(
    () => buildYoYRows(periods, granularity, metric, currentYear, previousYear),
    [periods, granularity, metric, currentYear, previousYear]
  );

  const renderYoYTable = rows => (
    <div className="ledger-scroll">
      <table className="ledger-table">
        <thead>
          <tr>
            <th className="ledger-name-col">{granularity === 'week' ? 'Week' : 'Month'}</th>
            <th>{currentYear}</th>
            <th>{previousYear}</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const diff = (r.current != null && r.previous != null) ? r.current - r.previous : null;
            return (
              <tr key={r.bucket}>
                <td className="ledger-name-col">{r.label}</td>
                <td>{r.current != null ? activeMetric.fmt(r.current) : '—'}</td>
                <td>{r.previous != null ? activeMetric.fmt(r.previous) : '—'}</td>
                <td className={vsGoalClass(diff)}>{diff != null ? `${diff >= 0 ? '+' : ''}${activeMetric.fmt(diff)}` : '—'}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={4} className="empty-note" style={{ textAlign: 'center', padding: 16 }}>No {currentYear}/{previousYear} data yet for this view.</td></tr>}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="tab-content">
      <p className="section-hint">
        Year-over-year comparison — {currentYear} on the left, {previousYear} on the right, aligned by {granularity === 'week' ? 'week of the year' : 'calendar month'}.
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
        <select className="sort-select" value={metric} onChange={e => setMetric(e.target.value)}>
          {WEEKLY_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      {grouping === 'total' && renderYoYTable(totalRows)}

      {grouping === 'dl' && (
        <div className="dl-list">
          {dlGroups.map(g => {
            const isOpen = !!expandedLeader[g.leaderName];
            const rows = isOpen ? buildYoYRows(
              periods.map(p => {
                const subset = {};
                g.codes.forEach(c => { if (p.stores[c]) subset[c] = p.stores[c]; });
                return { ...p, stores: subset };
              }),
              granularity, metric, currentYear, previousYear
            ) : [];
            return (
              <div key={g.leaderName} className="dl-card">
                <button className="dl-card-head" onClick={() => toggleLeader(g.leaderName)}>
                  <div className="dl-card-name-wrap">
                    <span className={`dl-chevron ${isOpen ? 'dl-chevron--open' : ''}`}>▸</span>
                    <span className="dl-card-name">{g.leaderName}</span>
                    <span className="dl-card-count">{g.role} · {g.codes.length} store{g.codes.length !== 1 ? 's' : ''}</span>
                  </div>
                </button>
                {isOpen && <div className="dl-store-table">{renderYoYTable(rows)}</div>}
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
// Compact "who sold the most X" lookup: top N names by Sales/Retail/Color,
// one line per month (or per store per month), built from the same
// per-employee data the date-range tabs use (getRangeTotals +
// mergeEmployeesInto/finalizeEmployee) — without this, Tilly has zero
// visibility into any employee, historical or current.
function topEmployeeLine(employees, n = 5) {
  if (!employees.length) return null;
  const topBy = key => [...employees].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n)
    .map(e => `${e.name} $${Math.round(e[key] || 0)}`).join(', ');
  return `Sales: ${topBy('sales')} | Retail: ${topBy('retail')} | Color: ${topBy('colorSales')}`;
}
function buildAIContext(report, history, weeklyHistory, goals, reviews, employeeRoster, reviewNotes, goldCombs, managers, milestoneGoals, news, events) {
  const lines = [];

  // Static reference info, independent of any report/date — who manages
  // which stores, so a question naming a leader ("Amber's stores", "how did
  // Lisa Hair's group do") can be resolved instead of coming back empty.
  lines.push('DL / AREA SUPERVISOR STORE GROUPINGS (who manages which stores — use this whenever a question references a leader by name; every store below belongs to exactly one of these leaders):');
  LEADER_ROSTER_SECTIONS.forEach(sec => {
    sec.leaders.forEach(l => {
      const storeNames = l.storeCodes.map(c => STORE_CODE_TO_NAME[c] || `Store ${c}`).join(', ');
      lines.push(`${l.name} (${sec.role}): ${storeNames}`);
    });
  });
  lines.push('');

  // Store managers — user-maintained (Setup > Managers), independent of any
  // report/date, so "who's the manager at X" resolves without needing the
  // current period loaded.
  if (managers && Object.keys(managers).length) {
    lines.push('STORE MANAGERS (who manages each individual store day-to-day, as distinct from the DL/Area Supervisor above):');
    Object.entries(managers).forEach(([code, name]) => {
      if (name) lines.push(`${STORE_CODE_TO_NAME[code] || `Store ${code}`}: ${name}`);
    });
    lines.push('');
  }

  // Homepage news & events — user-posted, independent of any report/date, so
  // "what's new" or "what's coming up" resolves without needing a period loaded.
  if (news && news.length) {
    lines.push('NEWS & UPDATES posted on the Homepage (most recent first):');
    [...news].sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(n => {
      lines.push(`${n.date}: ${n.title}${n.body ? ` — ${n.body}` : ''}`);
    });
    lines.push('');
  }
  if (events && events.length) {
    lines.push('UPCOMING/RECENT EVENTS on the Homepage calendar (sorted by date):');
    [...events].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(ev => {
      lines.push(`${ev.date}: ${ev.title}${ev.description ? ` — ${ev.description}` : ''}`);
    });
    lines.push('');
  }

  // Milestone goals — Goal is the number a store HAS to hit this month,
  // Milestone is a stretch target above it; both compared against
  // month-to-date sales (not the current report period, which may only be
  // a single week) since these are updated/reset monthly.
  if (milestoneGoals && Object.keys(milestoneGoals).length) {
    const { start, end } = getCurrentMonthRange();
    const mtdTotals = getRangeTotals(history, weeklyHistory, start, end);
    lines.push(`MILESTONE GOALS, month-to-date (${start} through ${end} — Store: month-to-date Sales vs Goal (have to hit) vs Milestone (stretch)):`);
    Object.entries(milestoneGoals).forEach(([code, g]) => {
      if (g.goal == null && g.milestone == null) return;
      const actual = historyTotalsToReportShape(mtdTotals[code] || {}).sales || 0;
      const pctStr = g.milestone ? ` (${Math.round((actual / g.milestone) * 100)}% of milestone)` : '';
      lines.push(`${STORE_CODE_TO_NAME[code] || `Store ${code}`}: MTD Sales $${Math.round(actual)}, Goal ${g.goal != null ? `$${Math.round(g.goal)}` : 'n/a'}, Milestone ${g.milestone != null ? `$${Math.round(g.milestone)}` : 'n/a'}${pctStr}`);
    });
    lines.push('');
  }

  if (report) {
    const t = report.companyTotals;
    lines.push(`CURRENT REPORT PERIOD: ${report.dateRangeLabel || 'unknown'}`);
    lines.push(`Company totals — Sales: $${Math.round(t.sales)}, TSTH: $${t.tsth != null ? t.tsth.toFixed(2) : 'n/a'}, Total Hours: ${Math.round(t.totalHours)}, Color Sales: $${Math.round(t.colorSales)}, Retail: $${Math.round(t.retail)}, CPC: ${t.cpc != null ? t.cpc.toFixed(2) : 'n/a'}, RPC: ${t.rpc != null ? t.rpc.toFixed(2) : 'n/a'}, Cuts: ${Math.round(t.haircuts || 0)}, CPH: ${t.cph != null ? t.cph.toFixed(2) : 'n/a'}`);
    lines.push('');
    lines.push('Per-store totals for the CURRENT period (Store: Sales, TSTH, Hours, Color, Retail, CPC, RPC, Cuts, CPH, goals if set):');
    report.stores.forEach(s => {
      const st = s.totals;
      const goal = goals?.[s.code];
      const goalStr = goal ? ` | Color Goal: ${goal.colorGoal ?? 'none'}, Retail Goal: ${goal.retailGoal ?? 'none'}` : '';
      lines.push(`${s.name}: Sales $${Math.round(st.sales)}, TSTH $${st.tsth != null ? st.tsth.toFixed(2) : 'n/a'}, Hours ${Math.round(st.totalHours)}, Color $${Math.round(st.colorSales)}, Retail $${Math.round(st.retail)}, CPC ${st.cpc != null ? st.cpc.toFixed(2) : 'n/a'}, RPC ${st.rpc != null ? st.rpc.toFixed(2) : 'n/a'}, Cuts ${Math.round(st.haircuts || 0)}, CPH ${st.cph != null ? st.cph.toFixed(2) : 'n/a'}${goalStr}`);
    });
    if (report.allEmployees?.length) {
      const line = topEmployeeLine(report.allEmployees);
      if (line) { lines.push(''); lines.push(`TOP EMPLOYEES THIS PERIOD (top 5 each, quick reference) — ${line}`); }
      lines.push('');
      lines.push('EVERY EMPLOYEE THIS PERIOD (Name @ Store: Sales, Color, Retail, Cuts, Hours, CPH):');
      report.allEmployees.forEach(e => {
        lines.push(`${e.name} @ ${e.store}: Sales $${Math.round(e.sales)}, Color $${Math.round(e.colorSales)}, Retail $${Math.round(e.retail)}, Cuts ${Math.round(e.haircuts || 0)}, Hours ${Math.round(e.totalHours)}, CPH ${e.cph != null ? e.cph.toFixed(2) : 'n/a'}`);
      });
    }
  } else {
    lines.push('No current stylist report is loaded on the site right now.');
  }

  // Store goals — independent of any report/period, since a goal is a
  // standing target, not tied to a specific historical month.
  if (goals && Object.keys(goals).length) {
    lines.push('');
    lines.push('STORE GOALS (Color/Retail targets — standing targets, not specific to any period):');
    Object.entries(goals).forEach(([code, g]) => {
      if (g.colorGoal == null && g.retailGoal == null) return;
      const name = STORE_CODE_TO_NAME[code] || `Store ${code}`;
      lines.push(`${name}: Color Goal ${g.colorGoal ?? 'none'}, Retail Goal ${g.retailGoal ?? 'none'}`);
    });
  }

  // Employee roster (start dates) — company-wide, not just recent hires, so
  // "when did X start" works for anyone, not only people hired in the last
  // 60 days (that's just what the 60 Day Employee tab itself narrows to).
  // Enriched with Store/DL whenever the name matches someone in the current
  // report, same matching the 60 Day Employee tab itself does.
  if (employeeRoster?.employees?.length) {
    lines.push('');
    lines.push('EMPLOYEE START DATES (from the Employee Start Dates roster — "new hire" flags anyone hired in the last 60 days; Store/DL shown when the name matches someone in the CURRENT report):');
    const now = Date.now();
    const byName = new Map();
    if (report) report.allEmployees.forEach(e => byName.set(normalizeName(e.name), e));
    employeeRoster.employees.forEach(e => {
      const daysAgo = Math.floor((now - new Date(e.startDate).getTime()) / DAY_MS);
      const tag = daysAgo >= 0 && daysAgo <= 60 ? ' (new hire)' : '';
      const match = byName.get(normalizeName(e.name));
      let storeInfo = '';
      if (match) {
        const storeObj = report.stores.find(s => s.name === match.store);
        const leaderInfo = storeObj ? getLeaderForStoreCode(storeObj.code) : null;
        storeInfo = ` — ${match.store}${leaderInfo ? `, DL: ${leaderInfo.leaderName}` : ''}`;
      }
      lines.push(`${e.name}: started ${fmtDateLong(e.startDate)}${tag}${storeInfo}`);
    });
  }

  // Full permanent history — every Sales-Accrual/Attendance historical import
  // plus every regular weekly upload, ever — rolled up by calendar month so
  // it covers everything without sending years of daily rows.
  const weeks = buildWeeklySnapshots(history, weeklyHistory);
  const months = buildMonthlySnapshots(weeks);
  if (months.length) {
    lines.push('');
    lines.push('NOTE: everything below this point is rolled up to the CALENDAR MONTH — no daily or weekly breakdown is included in this context. If asked about a specific week or day, say so rather than estimating from the monthly figures.');
    lines.push('');
    lines.push('COMPANY-WIDE HISTORY BY MONTH (covers every report ever uploaded — Historical Import backfill and every weekly upload):');
    months.forEach(m => {
      const t = periodTotals(m.stores);
      const cph = t.hours > 0 ? t.haircuts / t.hours : null;
      lines.push(`${m.month}: Sales $${Math.round(t.service)}, Color $${Math.round(t.color)}, Retail $${Math.round(t.retail)}, Gift Cards $${Math.round(t.giftCards)}, Hours ${Math.round(t.hours)}, Cuts ${Math.round(t.haircuts || 0)}, CPH ${cph != null ? cph.toFixed(2) : 'n/a'}`);
    });

    // Per-store breakdown + top employees, computed once per month from the
    // same getRangeTotals() the date-range tabs use — every month, not just
    // a recent window, so "how did Store X do in retail" works for any
    // month that's ever been uploaded, not only the last few.
    lines.push('');
    lines.push('PER-STORE HISTORY BY MONTH (every store, every month on file):');
    const monthlyTotals = new Map();
    months.forEach(m => {
      const { start, end } = monthRange(m.month);
      monthlyTotals.set(m.month, getRangeTotals(history, weeklyHistory, start, end));
    });
    months.forEach(m => {
      lines.push(`${m.month}:`);
      Object.entries(monthlyTotals.get(m.month)).forEach(([code, t]) => {
        const name = STORE_CODE_TO_NAME[code] || `Store ${code}`;
        lines.push(`  ${name}: Sales $${Math.round(t.service)}, Color $${Math.round(t.color)}, Retail $${Math.round(t.retail)}, Hours ${Math.round(t.hours)}, Cuts ${Math.round(t.haircuts || 0)}`);
      });
    });

    lines.push('');
    lines.push('TOP EMPLOYEES BY MONTH, COMPANY-WIDE (top 5 each for Sales, Retail, Color Sales — quick reference only; a name/month missing here means no per-employee data exists for that period):');
    months.forEach(m => {
      const totals = monthlyTotals.get(m.month);
      const companyEmployees = {};
      Object.values(totals).forEach(t => { if (t.employees?.length) mergeEmployeesInto(companyEmployees, t.employees); });
      const line = topEmployeeLine(Object.values(companyEmployees).map(finalizeEmployee));
      if (line) lines.push(`${m.month} — ${line}`);
    });

    // Per-store, not just company-wide — needed for anything scoped to a
    // specific leader's stores ("who sold the most retail in Amber's
    // stores in November"): resolve the leader's stores from the DL roster
    // above, then compare just those stores' lines for that month.
    lines.push('');
    lines.push('TOP EMPLOYEES BY MONTH BY STORE (top 3 each for Sales, Retail, Color Sales, per store — cross-reference against the DL/Area Supervisor groupings above to scope to a specific leader):');
    months.forEach(m => {
      const totals = monthlyTotals.get(m.month);
      const storeLines = [];
      Object.entries(totals).forEach(([code, t]) => {
        if (!t.employees?.length) return;
        const name = STORE_CODE_TO_NAME[code] || `Store ${code}`;
        const line = topEmployeeLine(t.employees, 3);
        if (line) storeLines.push(`  ${name} — ${line}`);
      });
      if (storeLines.length) { lines.push(`${m.month}:`); storeLines.forEach(l => lines.push(l)); }
    });

    // Precomputed so a "how did Amber's group do in November" question
    // doesn't depend on correctly adding up several stores' lines by hand —
    // same store-code grouping as the DL roster above.
    lines.push('');
    lines.push('DL / AREA SUPERVISOR ROLLUP BY MONTH (each leader\'s stores summed together):');
    months.forEach(m => {
      const totals = monthlyTotals.get(m.month);
      const leaderLines = [];
      LEADER_ROSTER_SECTIONS.forEach(sec => {
        sec.leaders.forEach(l => {
          const rolled = { service: 0, retail: 0, color: 0, hours: 0, haircuts: 0 };
          let any = false;
          l.storeCodes.forEach(code => {
            const t = totals[code];
            if (!t) return;
            any = true;
            rolled.service += t.service || 0;
            rolled.retail += t.retail || 0;
            rolled.color += t.color || 0;
            rolled.hours += t.hours || 0;
            rolled.haircuts += t.haircuts || 0;
          });
          if (any) leaderLines.push(`  ${l.name} — Sales $${Math.round(rolled.service)}, Color $${Math.round(rolled.color)}, Retail $${Math.round(rolled.retail)}, Hours ${Math.round(rolled.hours)}, Cuts ${Math.round(rolled.haircuts)}`);
        });
      });
      if (leaderLines.length) { lines.push(`${m.month}:`); leaderLines.forEach(l => lines.push(l)); }
    });
  }

  if (reviews?.reviews?.length) {
    const all = reviews.reviews;
    const avg = all.reduce((s, r) => s + r.rating, 0) / all.length;
    const neg = all.filter(isNegativeReview);
    const pos = all.filter(isPositiveReview);
    lines.push('');
    lines.push(`REVIEWS: ${all.length} total, average rating ${avg.toFixed(2)}★, ${pos.length} positive (4-5★), ${neg.length} negative (1-3★).`);

    lines.push('');
    lines.push('NEGATIVE REVIEW CATEGORIES (keyword-matched, company-wide):');
    REVIEW_CATEGORIES.forEach(c => {
      const count = neg.filter(r => reviewMatchesCategory(r.message, c.key)).length;
      lines.push(`${c.label}: ${count}`);
    });

    const byStore = new Map();
    all.forEach(r => {
      if (!byStore.has(r.code)) {
        const { name } = resolveStoreName(r.code, r.rawLocation);
        byStore.set(r.code, { name, reviews: [] });
      }
      byStore.get(r.code).reviews.push(r);
    });
    lines.push('');
    lines.push('REVIEWS BY STORE (Store: total, avg rating, negative, positive, without a staff follow-up note):');
    Array.from(byStore.values()).forEach(s => {
      const storeAvg = s.reviews.reduce((a, r) => a + r.rating, 0) / s.reviews.length;
      const storeNeg = s.reviews.filter(isNegativeReview).length;
      const storePos = s.reviews.filter(isPositiveReview).length;
      const noNotes = s.reviews.filter(r => !(reviewNotes?.[reviewKey(r)]?.length)).length;
      lines.push(`${s.name}: ${s.reviews.length} total, ${storeAvg.toFixed(2)}★ avg, ${storeNeg} negative, ${storePos} positive, ${noNotes} without a note`);
    });

    // Full text is the one place worth capping — hundreds/thousands of
    // reviews accumulated over years would otherwise dominate the whole
    // context. Aggregates above are complete; this is just qualitative
    // color from the most recent negative reviews, so "what are people
    // complaining about" has real quotes to draw on.
    const RECENT_NEGATIVE_LIMIT = 40;
    const recentNegative = [...neg].sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, RECENT_NEGATIVE_LIMIT);
    if (recentNegative.length) {
      lines.push('');
      lines.push(`MOST RECENT NEGATIVE REVIEWS, up to ${RECENT_NEGATIVE_LIMIT} (full text — older/other negative reviews are only reflected in the counts above, not quoted here):`);
      recentNegative.forEach(r => {
        const { name } = resolveStoreName(r.code, r.rawLocation);
        const notes = reviewNotes?.[reviewKey(r)];
        const noteStr = notes?.length ? ` [followed up: ${notes[notes.length - 1].text}]` : ' [no staff follow-up note]';
        lines.push(`${fmtDateLong(r.postedAt)} — ${name}, ${r.rating}★, ${r.userName || 'Anonymous'}: "${r.message}"${noteStr}`);
      });
    }

    const RECENT_POSITIVE_LIMIT = 15;
    const recentPositive = [...pos].sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, RECENT_POSITIVE_LIMIT);
    if (recentPositive.length) {
      lines.push('');
      lines.push(`MOST RECENT POSITIVE REVIEWS, up to ${RECENT_POSITIVE_LIMIT} (full text, for "what are people loving" type questions — older/other positive reviews are only reflected in the counts above):`);
      recentPositive.forEach(r => {
        const { name } = resolveStoreName(r.code, r.rawLocation);
        lines.push(`${fmtDateLong(r.postedAt)} — ${name}, ${r.rating}★, ${r.userName || 'Anonymous'}: "${r.message}"`);
      });
    }

    const combedKeys = new Set(Object.keys(goldCombs || {}));
    if (combedKeys.size) {
      const combed = all.filter(r => combedKeys.has(reviewKey(r)));
      lines.push('');
      lines.push(`GOLD COMB REVIEWS — staff have specifically acknowledged these ${combed.length} review(s) as awesome/worth celebrating:`);
      combed.forEach(r => {
        const { name } = resolveStoreName(r.code, r.rawLocation);
        const employeesForStore = report?.stores.find(st => st.code === r.code)?.employees || null;
        const mention = detectEmployeeMention(r.message, employeesForStore);
        lines.push(`${fmtDateLong(r.postedAt)} — ${name}, ${r.rating}★, ${r.userName || 'Anonymous'}${mention ? ` (mentions ${mention})` : ''}: "${r.message}"`);
      });
    }
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

function AIChatWidget({ report, history, weeklyHistory, goals, reviews, employeeRoster, reviewNotes, goldCombs, managers, milestoneGoals, news, events }) {
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
      const context = buildAIContext(report, history, weeklyHistory, goals, reviews, employeeRoster, reviewNotes, goldCombs, managers, milestoneGoals, news, events);
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
  { key: 'managers', label: 'Managers' },
  { key: 'milestoneGoals', label: 'Milestone Goals' },
  { key: 'homepage', label: 'Homepage' },
  { key: 'history', label: 'Historical Import' },
  { key: 'upload', label: 'Upload' },
];

function SetupTab({ configured, section, onSection, goalsProps, managersProps, milestoneGoalsProps, homepageAdminProps, historyProps, uploadProps }) {
  const steps = [
    { n: 1, title: 'Export this week\u2019s stylist report', body: 'Run the report with every store and every employee under it, covering the week you want to see.' },
    { n: 2, title: 'Upload it', body: 'Go to the Upload section below and drop it into the "Stylist Report" slot. The date range fills in automatically.' },
    { n: 3, title: 'Optionally upload employee start dates', body: 'A simple Employee Name + Start Date export. Drop it into the "Employee Start Dates" slot to power the "60 Day Employee" tab, which shows anyone hired in the last 60 days along with their store, DL, and sales — even if they don\u2019t have sales data yet.' },
    { n: 4, title: 'Explore the tabs', body: 'Overview: tap a metric to see the top/bottom 10 stores. Stores: every location, click one to see its employees. Employees: every stylist company-wide. Retail / Color Sales: grouped by DL, or toggle to a flat list. DL: rolled-up totals per leader, click to expand their stores. 60 Day Employee: recent hires. Reviews: totals, negative-review categories, and per-store review lists with employee call-outs. Every tab has a search box.' },
    { n: 5, title: 'Next week', body: 'Just upload a new stylist report the same way \u2014 it replaces this week\u2019s data for everyone viewing the site.' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className="setup-access-banner">
        🚫 If your name doesn't start with Evan and end in Robins, you're not supposed to be here.
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
      {section === 'managers' && <ManagersTab {...managersProps} />}
      {section === 'milestoneGoals' && <MilestoneGoalsTab {...milestoneGoalsProps} />}
      {section === 'homepage' && <HomepageAdminTab {...homepageAdminProps} />}
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
const TABS = ['Homepage', 'Overview', 'Stores', 'Employees', 'Retail', 'Color Sales', 'DL', '60 Day Employee', 'Reviews', 'Weekly', 'Setup'];

export default function App() {
  const [report, setReport] = useState(null);
  const [employeeRoster, setEmployeeRoster] = useState(null);
  const [goals, setGoals] = useState({});
  const [managers, setManagers] = useState({});
  const [milestoneGoals, setMilestoneGoals] = useState({});
  const [reviews, setReviews] = useState(null);
  const [reviewNotes, setReviewNotes] = useState({});
  const [goldCombs, setGoldCombs] = useState({});
  const [news, setNews] = useState([]);
  const [events, setEvents] = useState([]);
  const [history, setHistory] = useState({});
  // Sales-Accrual and Attendance historical imports are two independent
  // upload slots that can be fired off close together — both handlers would
  // otherwise read the same `history` snapshot, merge their own file in, and
  // whichever's setHistory/save landed last would silently overwrite the
  // other's data (both in memory and in what gets persisted). historyRef
  // always holds the latest value so a handler starting mid-import reads
  // fresh data instead of a stale closure, and importChainRef serializes the
  // two handlers so they never merge+save concurrently off the same base.
  const historyRef = useRef(history);
  useEffect(() => { historyRef.current = history; }, [history]);
  const importChainRef = useRef(Promise.resolve());
  const [weeklyHistory, setWeeklyHistory] = useState({});
  const [dateRange, setDateRangeState] = useState({ start: null, end: null });
  const setDateRange = (start, end) => setDateRangeState({ start, end });
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Homepage');
  const [setupSection, setSetupSection] = useState('guide');
  const [toast, setToast] = useState(null);
  const [celebrate, setCelebrate] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingRoster, setUploadingRoster] = useState(false);
  const [uploadingReviews, setUploadingReviews] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('tsth');
  const [queries, setQueries] = useState({ Overview: '', Stores: '', Employees: '', Retail: '', 'Color Sales': '', DL: '', '60 Day Employee': '', Reviews: '' });

  useEffect(() => {
    Promise.all([
      loadData('stylist_report'), loadData('employee_start_dates'), loadData('store_goals'), loadData('store_managers'), loadData('milestone_goals'), loadData('reviews'), loadData('review_notes'), loadData('review_gold_combs'),
      loadData('homepage_news'), loadData('homepage_events'),
      loadDataByPrefix('daily_history_'), loadDataByPrefix('weekly_history_'),
      loadData('daily_history'), loadData('weekly_history'), // legacy single-row format, if anything was saved before chunking
    ]).then(([reportRes, rosterRes, goalsRes, managersRes, milestoneGoalsRes, reviewsRes, reviewNotesRes, goldCombsRes, newsRes, eventsRes, dailyChunksRes, weeklyChunksRes, legacyDailyRes, legacyWeeklyRes]) => {
      if (reportRes.data) setReport(ensureReportCph(reportRes.data)); else { setTab('Setup'); setSetupSection('upload'); }
      if (rosterRes.data) setEmployeeRoster(rosterRes.data);
      if (goalsRes.data) setGoals(goalsRes.data);
      if (managersRes.data) setManagers(managersRes.data);
      if (milestoneGoalsRes.data) setMilestoneGoals(milestoneGoalsRes.data);
      if (reviewsRes.data) setReviews(reviewsRes.data);
      if (reviewNotesRes.data) setReviewNotes(reviewNotesRes.data);
      if (goldCombsRes.data) setGoldCombs(goldCombsRes.data);
      if (newsRes.data) setNews(newsRes.data);
      if (eventsRes.data) setEvents(eventsRes.data);

      // Postgres gives NO ordering guarantee on an unordered SELECT — so
      // merging chunks in whatever order the array happens to arrive in
      // meant that if a month ever had BOTH an old single-chunk row and new
      // per-store split rows at once (possible if a superseded-format
      // cleanup delete silently failed — clearData/clearDataByPrefix used to
      // swallow that error entirely), which one won on a given page load was
      // a coin flip. That's the "data disappears on refresh" bug reported
      // after the previous round of fixes. Data for a past month only ever
      // grows (more stores/employees get added, never removed), so instead
      // of trusting array order, always apply single-chunk rows FIRST as a
      // base and per-store split rows SECOND — the split format is only
      // ever written when a month outgrows the single-chunk threshold, so it
      // is always the newer/more-complete one whenever both exist.
      const daySplitPriority = key => (key.includes('__') ? 1 : 0);
      const mergedDaily = {};
      const dailyChunks = [...(dailyChunksRes.data || [])].sort((a, b) => daySplitPriority(a.key) - daySplitPriority(b.key));
      // The pre-chunking single-blob format (if it still exists in Supabase
      // from before this chunked scheme existed) is the OLDEST possible
      // source — it must never be allowed to override current chunk data,
      // so it's applied first as a base, not last (last was backwards: a
      // stale legacy blob would have clobbered every fresh chunk on every
      // load).
      if (legacyDailyRes.data) Object.assign(mergedDaily, legacyDailyRes.data);
      dailyChunks.forEach(chunk => Object.assign(mergedDaily, chunk.payload));
      setHistory(mergedDaily);

      // Detect leftover contamination (both formats present for the same
      // month at once) and heal it now that the merge already resolved it
      // deterministically in memory — clears the superseded single-chunk
      // row so future loads don't even need the priority sort as a safety
      // net, and so the console diagnostics below go clean.
      {
        const monthsWithSplit = new Set(dailyChunks.filter(c => c.key.includes('__')).map(c => c.key.replace('daily_history_', '').split('__')[0]));
        const staleSingleKeys = dailyChunks.filter(c => !c.key.includes('__') && monthsWithSplit.has(c.key.replace('daily_history_', ''))).map(c => c.key);
        if (staleSingleKeys.length) {
          console.warn(`[history load] found ${staleSingleKeys.length} stale single-chunk row(s) alongside per-store split data (a prior cleanup delete must have failed) — clearing now: ${staleSingleKeys.join(', ')}`);
          Promise.all(staleSingleKeys.map(k => clearData(k))).then(results => {
            const failed = results.filter(r => !r.ok);
            if (failed.length) console.error('[history load] stale-row cleanup failed, will retry on next load:', failed.map(r => r.error));
            else console.log('[history load] stale-row cleanup succeeded.');
          });
        }
      }

      // Diagnostic only (console, not user-facing) — this data has silently
      // gone missing on refresh more than once; logging exactly what came
      // back on load makes the next repro concrete instead of another round
      // of guessing. Safe to leave in permanently, it's cheap and inert.
      {
        const dailyRecords = Object.values(mergedDaily);
        const withEmployees = dailyRecords.filter(r => r.employees && Object.keys(r.employees).length).length;
        console.log(`[history load] ${dailyChunks.length} chunk(s) from Supabase: ${dailyChunks.map(c => c.key).join(', ') || 'none'}`);
        console.log(`[history load] ${dailyRecords.length} store-day record(s) merged, ${withEmployees} with employee-level detail, ${(dailyChunksRes.localOnlyKeys || []).length} local-only chunk(s) pending Supabase sync${(dailyChunksRes.localOnlyKeys || []).length ? `: ${dailyChunksRes.localOnlyKeys.join(', ')}` : ''}.`);
      }

      const mergedWeekly = {};
      if (legacyWeeklyRes.data) Object.assign(mergedWeekly, legacyWeeklyRes.data);
      (weeklyChunksRes.data || []).forEach(chunk => Object.assign(mergedWeekly, chunk.payload));
      setWeeklyHistory(mergedWeekly);

      setLoading(false);
      if (isConfigured() && (reportRes.source === 'local' || rosterRes.source === 'local' || goalsRes.source === 'local' || managersRes.source === 'local' || milestoneGoalsRes.source === 'local' || reviewsRes.source === 'local' || newsRes.source === 'local' || eventsRes.source === 'local' || dailyChunksRes.source === 'local' || weeklyChunksRes.source === 'local')) {
        const err = reportRes.error || rosterRes.error || goalsRes.error || managersRes.error || milestoneGoalsRes.error || reviewsRes.error || newsRes.error || eventsRes.error || dailyChunksRes.error || weeklyChunksRes.error;
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
            // Key is either `daily_history_YYYY-MM` (whole month) or
            // `daily_history_YYYY-MM__STORECODE` (a month split by store
            // because it was too large for one request) — match accordingly.
            const [month, code] = key.replace('daily_history_', '').split('__');
            const chunk = {};
            Object.entries(mergedDaily).forEach(([k, rec]) => {
              if (rec.date.slice(0, 7) === month && (!code || rec.code === code)) chunk[k] = rec;
            });
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
      setLabel(parsed.startDateISO && parsed.endDateISO ? fmtDateRangeLong(parsed.startDateISO, parsed.endDateISO) : (parsed.dateRangeLabel || ''));
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

  // Gold Comb: staff-facing acknowledgment that a review was a great one —
  // lives in its own db key (like review_notes) so it survives a fresh
  // reviews-file re-upload, which rebuilds reviews.reviews from scratch.
  const handleToggleGoldComb = useCallback(key => {
    const isAdding = !goldCombs[key];
    setGoldCombs(prev => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = { at: new Date().toISOString() };
      saveData('review_gold_combs', next).then(result => {
        if (isConfigured() && !result.ok) {
          showToast(`Gold Comb saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
        }
      });
      return next;
    });
    if (isAdding) {
      setCelebrate(true);
      setTimeout(() => setCelebrate(false), 1700);
    }
  }, [goldCombs]);

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

  const handleSaveManager = useCallback((storeCode, name) => {
    setManagers(prev => {
      const next = { ...prev };
      if (name) next[storeCode] = name; else delete next[storeCode];
      saveData('store_managers', next).then(result => {
        if (isConfigured() && !result.ok) {
          showToast(`Manager saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
        }
      });
      return next;
    });
  }, []);

  const handleAddNews = useCallback((title, body, headerImage) => {
    const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title, body, headerImage: headerImage || null, date: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() };
    setNews(prev => {
      const next = [item, ...prev];
      saveData('homepage_news', next).then(result => {
        if (isConfigured() && !result.ok) showToast(`Update saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
      });
      return next;
    });
  }, []);

  const handleDeleteNews = useCallback(id => {
    setNews(prev => {
      const next = prev.filter(n => n.id !== id);
      saveData('homepage_news', next).then(result => {
        if (isConfigured() && !result.ok) showToast(`Delete saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
      });
      return next;
    });
  }, []);

  const handleAddEvent = useCallback((title, date, description, headerImage) => {
    const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title, date, description, headerImage: headerImage || null, createdAt: new Date().toISOString() };
    setEvents(prev => {
      const next = [...prev, item];
      saveData('homepage_events', next).then(result => {
        if (isConfigured() && !result.ok) showToast(`Event saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
      });
      return next;
    });
  }, []);

  const handleDeleteEvent = useCallback(id => {
    setEvents(prev => {
      const next = prev.filter(ev => ev.id !== id);
      saveData('homepage_events', next).then(result => {
        if (isConfigured() && !result.ok) showToast(`Delete saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
      });
      return next;
    });
  }, []);

  const handleSaveMilestoneGoal = useCallback((storeCode, field, value) => {
    setMilestoneGoals(prev => {
      const next = { ...prev, [storeCode]: { ...prev[storeCode], [field]: value } };
      saveData('milestone_goals', next).then(result => {
        if (isConfigured() && !result.ok) {
          showToast(`Milestone goal saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
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

  const handleImportManagers = useCallback(async file => {
    try {
      const parsed = await parseManagerFile(file);
      const next = { ...managers };
      let matched = 0;
      const unmatched = [];
      parsed.entries.forEach(e => {
        const code = getCodeForStoreName(e.storeName);
        if (code) { next[code] = e.managerName; matched++; }
        else unmatched.push(e.storeName);
      });
      setManagers(next);
      const result = await saveData('store_managers', next);
      if (isConfigured() && !result.ok) {
        showToast(`Imported ${matched} managers, but couldn't sync to Supabase (${result.error})`, 'error');
      } else if (unmatched.length) {
        showToast(`Imported ${matched} managers from ${file.name} — ${unmatched.length} store name${unmatched.length > 1 ? 's' : ''} not recognized: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}`, 'error');
      } else {
        showToast(`Imported ${matched} managers from ${file.name}`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [managers]);

  const handleImportMilestoneGoals = useCallback(async file => {
    try {
      const parsed = await parseMilestoneGoalFile(file);
      const next = { ...milestoneGoals };
      let matched = 0;
      const unmatched = [];
      parsed.entries.forEach(e => {
        const code = getCodeForStoreName(e.storeName);
        if (code) { next[code] = { goal: e.goal, milestone: e.milestone }; matched++; }
        else unmatched.push(e.storeName);
      });
      setMilestoneGoals(next);
      const result = await saveData('milestone_goals', next);
      if (isConfigured() && !result.ok) {
        showToast(`Imported ${matched} milestone goals, but couldn't sync to Supabase (${result.error})`, 'error');
      } else if (unmatched.length) {
        showToast(`Imported ${matched} milestone goals from ${file.name} — ${unmatched.length} store name${unmatched.length > 1 ? 's' : ''} not recognized: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}`, 'error');
      } else {
        showToast(`Imported ${matched} milestone goals from ${file.name}`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [milestoneGoals]);

  // A month's chunk for a large franchise (many stores, each with a full
  // per-employee sales/color/retail/haircuts breakdown) can be big enough
  // to risk a Supabase request-size or statement-timeout failure — and if
  // that failure throws instead of returning a clean {error}, it was being
  // silently swallowed (nothing caught it), so the import LOOKED successful
  // while nothing actually persisted. Split any oversized month by store so
  // no single request risks that, and always catch so a real failure is
  // never silent again.
  const HISTORY_CHUNK_SIZE_LIMIT = 350_000; // chars of JSON, conservative
  const saveHistoryMonthChunks = async (working, touchedMonths) => {
    let ok = true;
    let lastError = null;
    const failedMonths = [];
    for (const month of touchedMonths) {
      const chunk = {};
      Object.entries(working).forEach(([key, rec]) => { if (rec.date.slice(0, 7) === month) chunk[key] = rec; });
      try {
        const json = JSON.stringify(chunk);
        const useSplit = json.length > HISTORY_CHUNK_SIZE_LIMIT;
        const recordCount = Object.keys(chunk).length;
        const withEmployees = Object.values(chunk).filter(r => r.employees && Object.keys(r.employees).length).length;
        console.log(`[history save] ${month}: ${recordCount} record(s), ${withEmployees} with employee-level detail, ${json.length} chars — ${useSplit ? 'splitting per store' : 'single chunk'}`);
        let results;
        if (!useSplit) {
          results = [await saveData(`daily_history_${month}`, chunk)];
        } else {
          const byStore = new Map();
          Object.entries(chunk).forEach(([key, rec]) => {
            if (!byStore.has(rec.code)) byStore.set(rec.code, {});
            byStore.get(rec.code)[key] = rec;
          });
          results = [];
          for (const [code, sub] of byStore) {
            results.push(await saveData(`daily_history_${month}__${code}`, sub));
          }
        }
        const failed = results.filter(r => !r.ok);
        if (failed.length) { ok = false; lastError = failed[0].error; failedMonths.push(month); console.error(`[history save] ${month} FAILED:`, failed.map(r => r.error)); }
        else {
          console.log(`[history save] ${month}: saved OK (${useSplit ? `${results.length} per-store chunk(s)` : '1 chunk'})`);
          // `chunk` always holds the FULL current month's data, so whichever
          // format we just wrote is complete on its own — clean up the OTHER
          // format's leftover row(s) for this month so a stale copy can't
          // outlive it and get merged back in on the next load (Object.assign
          // order isn't guaranteed, so a stale single-chunk row full of old/
          // employee-less data could silently clobber fresh per-store chunks
          // on refresh — this is what caused freshly-imported employee names
          // to vanish after a reload). If THIS delete itself silently fails,
          // the load-side merge is now format-priority-based (not row-order-
          // based) so a stray leftover can't win the coin flip anymore — but
          // still surface the failure so it gets cleaned up instead of
          // lingering forever.
          const cleanup = useSplit ? await clearData(`daily_history_${month}`) : await clearDataByPrefix(`daily_history_${month}__`);
          if (!cleanup.ok) console.error(`[history save] ${month}: saved OK but failed to clean up the superseded format (${cleanup.error}) — a stale row may linger in Supabase.`);
        }
      } catch (err) {
        ok = false; lastError = err.message; failedMonths.push(month);
      }
    }
    return { ok, error: lastError, failedMonths };
  };

  // Both batch handlers below are queued through importChainRef instead of
  // running as soon as they're called — Sales-Accrual and Attendance are two
  // independent upload slots, and firing both close together used to let
  // them merge+save concurrently off the same stale `history` snapshot, so
  // whichever finished last silently discarded the other's data. Queuing
  // forces them to run one at a time, each starting from historyRef.current
  // (updated synchronously, not just via the setHistory/useEffect roundtrip)
  // so the second one always sees the first one's result.
  const handleImportSalesBatch = useCallback(fileList => {
    const task = async () => {
      let working = historyRef.current;
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
      historyRef.current = working;
      setHistory(working);
      const result = await saveHistoryMonthChunks(working, touchedMonths);
      if (isConfigured() && !result.ok) {
        lines.push(`✗ Couldn't sync ${result.failedMonths.join(', ')} to Supabase (${result.error}) — this data is safe on this device (it'll auto-retry syncing next time you load the app), but won't show up on other devices until it does. Try the import again or reload the page to trigger a retry.`);
        showToast(`Imported, but couldn't sync to Supabase (${result.error})`, 'error');
      } else {
        showToast(`Processed ${fileList.length} sales file${fileList.length !== 1 ? 's' : ''}`);
      }
      return lines;
    };
    const queued = importChainRef.current.then(task, task);
    importChainRef.current = queued.then(() => {}, () => {});
    return queued;
  }, []);

  const handleImportAttendanceBatch = useCallback(fileList => {
    const task = async () => {
      let working = historyRef.current;
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
      historyRef.current = working;
      setHistory(working);
      const result = await saveHistoryMonthChunks(working, touchedMonths);
      if (isConfigured() && !result.ok) {
        lines.push(`✗ Couldn't sync ${result.failedMonths.join(', ')} to Supabase (${result.error}) — this data is safe on this device (it'll auto-retry syncing next time you load the app), but won't show up on other devices until it does. Try the import again or reload the page to trigger a retry.`);
        showToast(`Imported, but couldn't sync to Supabase (${result.error})`, 'error');
      } else {
        showToast(`Processed ${fileList.length} attendance file${fileList.length !== 1 ? 's' : ''}`);
      }
      return lines;
    };
    const queued = importChainRef.current.then(task, task);
    importChainRef.current = queued.then(() => {}, () => {});
    return queued;
  }, []);

  const handleClearHistory = async () => {
    if (!window.confirm('Clear all historical data? This cannot be undone.')) return;
    await clearDataByPrefix('daily_history_');
    await clearData('daily_history'); // legacy single-row format, if it exists
    setHistory({});
    showToast('Historical data cleared');
  };

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  const needsReport = !report && tab !== 'Setup' && tab !== '60 Day Employee' && tab !== 'Reviews' && tab !== 'Weekly' && tab !== 'Homepage';

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
      {celebrate && <GoldCombCelebration />}

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
        {tab === 'Homepage' && (
          <HomepageTab report={report} news={news} events={events} />
        )}
        {!needsReport && tab === 'Overview' && report && (
          <OverviewTab report={report} selected={selectedMetric} onSelect={setSelectedMetric} query={queries.Overview} onQuery={v => setQuery('Overview', v)} />
        )}
        {!needsReport && tab === 'Stores' && report && (
          <StoresTab report={report} query={queries.Stores} onQuery={v => setQuery('Stores', v)} history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange} managers={managers} />
        )}
        {!needsReport && tab === 'Employees' && report && (
          <EmployeesTab report={report} query={queries.Employees} onQuery={v => setQuery('Employees', v)} managers={managers} />
        )}
        {!needsReport && tab === 'Retail' && report && (
          <StoreMetricTab
            report={report} query={queries.Retail} onQuery={v => setQuery('Retail', v)}
            title="Retail" metricA={{ key: 'retail', label: 'Retail', fmt: fmt$ }} metricB={{ key: 'rpc', label: 'RPC', fmt: fmtNum }}
            goalType="retailGoal" goals={goals}
            history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange}
            managers={managers}
          />
        )}
        {!needsReport && tab === 'Color Sales' && report && (
          <StoreMetricTab
            report={report} query={queries['Color Sales']} onQuery={v => setQuery('Color Sales', v)}
            title="Color Sales" metricA={{ key: 'colorSales', label: 'Color Sales', fmt: fmt$ }} metricB={{ key: 'cpc', label: 'CPC', fmt: fmtNum }}
            goalType="colorGoal" goals={goals}
            history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange}
            showPrevMonthColor
            managers={managers}
          />
        )}
        {!needsReport && tab === 'DL' && report && (
          <DLTab report={report} query={queries.DL} onQuery={v => setQuery('DL', v)} history={history} weeklyHistory={weeklyHistory} dateRange={dateRange} onDateRangeChange={setDateRange} managers={managers} milestoneGoals={milestoneGoals} />
        )}
        {tab === '60 Day Employee' && (
          <NewHireTab report={report} employeeRoster={employeeRoster} query={queries['60 Day Employee']} onQuery={v => setQuery('60 Day Employee', v)} />
        )}
        {tab === 'Reviews' && (
          <ReviewsTab
            report={report} reviews={reviews} query={queries.Reviews} onQuery={v => setQuery('Reviews', v)}
            reviewNotes={reviewNotes} onAddReviewNote={handleAddReviewNote}
            goldCombs={goldCombs} onToggleGoldComb={handleToggleGoldComb}
          />
        )}
        {tab === 'Weekly' && (
          <WeeklyTab dailyHistory={history} weeklyHistory={weeklyHistory} />
        )}
        {tab === 'Setup' && (
          <SetupTab
            configured={isConfigured()} section={setupSection} onSection={setSetupSection}
            goalsProps={{ report, goals, onSaveGoal: handleSaveGoal, onImportGoals: handleImportGoals }}
            managersProps={{ report, managers, onSaveManager: handleSaveManager, onImportManagers: handleImportManagers }}
            milestoneGoalsProps={{ report, milestoneGoals, onSaveMilestoneGoal: handleSaveMilestoneGoal, onImportMilestoneGoals: handleImportMilestoneGoals }}
            homepageAdminProps={{ news, events, onAddNews: handleAddNews, onDeleteNews: handleDeleteNews, onAddEvent: handleAddEvent, onDeleteEvent: handleDeleteEvent, onImageError: msg => showToast(msg, 'error') }}
            historyProps={{ history, onImportSalesBatch: handleImportSalesBatch, onImportAttendanceBatch: handleImportAttendanceBatch, onClearHistory: handleClearHistory }}
            uploadProps={{
              report, uploading, onFile: handleFile, onClear: handleClearAll,
              employeeRoster, uploadingRoster, onRosterFile: handleRosterFile, onClearRoster: handleClearRoster,
              reviews, uploadingReviews, onReviewsFile: handleReviewsFile, onClearReviews: handleClearReviews,
            }}
          />
        )}
      </main>
      <AIChatWidget report={report} history={history} weeklyHistory={weeklyHistory} goals={goals} reviews={reviews} employeeRoster={employeeRoster} reviewNotes={reviewNotes} goldCombs={goldCombs} managers={managers} milestoneGoals={milestoneGoals} news={news} events={events} />
    </div>
  );
}
