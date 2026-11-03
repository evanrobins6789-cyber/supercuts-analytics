// "My Numbers" (2026-11-03): one person's own numbers, one row per store
// where they did the work (from Sales-Accrual/Attendance history, as the POS
// recorded it), plus a combined total. The data comes pre-filtered to just
// that person by api/_my-numbers.js; this only adds it up.
import { getRangeTotals } from './metrics.js';
import { STORE_CODE_TO_NAME } from './storeDirectory.js';

const EMPTY = () => ({ sales: 0, retail: 0, colorSales: 0, haircuts: 0, hours: 0, tips: 0 });
const finish = r => ({
  ...r,
  service: r.sales - r.retail,
  tsth: r.hours > 0 ? r.sales / r.hours : null,
  cph: r.hours > 0 ? r.haircuts / r.hours : null,
});

export function buildMyNumbers({ history, weeklyHistory, tips, start, end }) {
  const byCode = {};
  const totals = getRangeTotals(history, weeklyHistory, start, end);
  Object.entries(totals).forEach(([code, t]) => {
    (t.employees || []).forEach(e => {
      if (!byCode[code]) byCode[code] = EMPTY();
      const r = byCode[code];
      r.sales += e.sales || 0;
      r.retail += e.retail || 0;
      r.colorSales += e.colorSales || 0;
      r.haircuts += e.haircuts || 0;
      r.hours += e.totalHours || 0;
    });
  });
  Object.values(tips || {}).forEach(rec => {
    if (rec.date < start || rec.date > end) return;
    Object.values(rec.employees || {}).forEach(v => {
      if (!byCode[rec.code]) byCode[rec.code] = EMPTY();
      byCode[rec.code].tips += v.tips || 0;
    });
  });
  const stores = Object.entries(byCode)
    .filter(([, r]) => r.sales || r.hours || r.tips)
    .map(([code, r]) => finish({ code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, ...r }))
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
  const total = EMPTY();
  stores.forEach(s => Object.keys(total).forEach(k => { total[k] += s[k]; }));
  return { stores, total: finish(total) };
}

// Store-peer averages for coaching (2026-11-03): for each store in `codes`,
// the totals of everyone ELSE who worked there in [start, end], plus the same
// company-wide. Aggregates only, never names. `people` counts others with
// hours; `withRetail`/`withColor` count how many of them sold any.
const EMPTY_PEERS = () => ({ people: 0, withRetail: 0, withColor: 0, hours: 0, sales: 0, retail: 0, colorSales: 0, haircuts: 0 });
export function buildPeerStats({ history, weeklyHistory, names, codes, start, end }) {
  const totals = getRangeTotals(history, weeklyHistory, start, end);
  const stores = {};
  const company = EMPTY_PEERS();
  const add = (agg, e) => {
    agg.people += 1;
    if ((e.retail || 0) > 0) agg.withRetail += 1;
    if ((e.colorSales || 0) > 0) agg.withColor += 1;
    agg.hours += e.totalHours || 0;
    agg.sales += e.sales || 0;
    agg.retail += e.retail || 0;
    agg.colorSales += e.colorSales || 0;
    agg.haircuts += e.haircuts || 0;
  };
  Object.entries(totals).forEach(([code, t]) => {
    (t.employees || []).forEach(e => {
      if (!(e.totalHours > 0) || names.has(normalizePersonName(e.name))) return;
      add(company, e);
      if (codes.includes(code)) add(stores[code] ||= EMPTY_PEERS(), e);
    });
  });
  return { stores, company };
}

// Shared with api/_my-numbers.js (server) and the leadership view of the tab.
export const normalizePersonName = raw => String(raw || '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Keeps only `names`' own entries (no store totals, nobody else).
export function pickOwnRecords({ dailyRows, weeklyRows, tipRows, names, start, end }) {
  const isMe = n => names.has(normalizePersonName(n));
  const history = {};
  dailyRows.forEach(row => Object.entries(row.payload || {}).forEach(([key, rec]) => {
    if (!rec || rec.date < start || rec.date > end) return;
    const mine = Object.entries(rec.employees || {}).filter(([n]) => isMe(n));
    if (!mine.length) return;
    history[key] = { code: rec.code, date: rec.date, employees: Object.fromEntries(mine) };
  }));
  const weeklyHistory = {};
  weeklyRows.forEach(row => Object.entries(row.payload || {}).forEach(([weekKey, w]) => {
    if (!w || w.endDate < start || w.startDate > end) return;
    const stores = {};
    Object.entries(w.stores || {}).forEach(([code, s]) => {
      const mine = (s.employees || []).filter(e => isMe(e.name));
      // An empty entry still marks the store as covered by that week, so the
      // client's getRangeTotals skips those days in daily history the same
      // way it does for everyone else.
      stores[code] = { employees: mine };
    });
    weeklyHistory[weekKey] = { weekKey, startDate: w.startDate, endDate: w.endDate, stores };
  }));
  const tips = {};
  tipRows.forEach(row => Object.entries(row.payload || {}).forEach(([key, rec]) => {
    if (!rec || rec.date < start || rec.date > end) return;
    const mine = Object.entries(rec.employees || {}).filter(([n]) => isMe(n));
    if (!mine.length) return;
    tips[key] = { code: rec.code, date: rec.date, employees: Object.fromEntries(mine) };
  }));
  return { history, weeklyHistory, tips };
}

