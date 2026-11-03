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
