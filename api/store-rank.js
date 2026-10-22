// Vercel serverless function — Node.js runtime.
// "Where does my store rank?" for a store manager's Overview tab. A manager's
// own data is scoped down to their store(s) by api/scoped-data.js, so the
// browser never has the other stores' numbers to rank against. This ranks
// every store company-wide here on the server, then hands back only the
// manager's own store plus the 5 stores directly above and below it, with
// each store's real company-wide rank (e.g. 25-35 around a store in 30th).
// No employee-level data and no stores outside that window leave the server.
// Used by the manager's Overview tab and Homepage Top 10 charts.
//
// District Leaders instead get the company-wide Top 10 stores and Top 10
// employees (Homepage Top 10 charts), since their own data is also scoped
// to just their stores.
//
// Request: POST { token, start, end } (ISO dates, the tab's range).
// Manager response: { ok, storeCount, windows: { [metricKey]: { [ownCode]: [row] } } }
// where row = { rank, code, name, value, isMine, signatureSCount, cpdLY }.
// DL response: { ok, storeCount, top10: { stores: { [metricKey]: [storeRow] },
// employees: { [metricKey]: [{ name, store, [metricKey] }] } } }.
// Every metric is computed in one call so clicking between Overview tiles
// doesn't need another round trip.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';
import { getRangeTotals, historyTotalsToReportShape, sortByMetric, shiftYearISO, getStoreCutsPerDay, cpdOf } from '../src/metrics.js';

// STORE_METRICS keys in src/App.js, plus the Overview-only CPD.
const METRIC_KEYS = ['sales', 'avgTicket', 'tsth', 'totalHours', 'colorSales', 'cpc', 'retail', 'rpc', 'otherServices', 'opc', 'haircuts', 'cph', 'signatureS', 'cpd'];
const NEIGHBORS = 5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Full history is several MB; a warm function instance reuses it for a
// couple of minutes instead of re-reading it on every range change.
const CACHE_MS = 2 * 60 * 1000;
let cache = null;

async function loadRow(supabase, key) {
  const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.payload : null;
}

async function loadChunked(supabase, prefix) {
  const PAGE_SIZE = 1000;
  let rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('weekly_report').select('*').like('report_id', `${prefix}%`).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows.map(r => ({ key: r.report_id, payload: r.payload }));
}

// Same legacy/split-chunk merge as api/leaderboard-email.js's loadHistory.
async function loadHistory(supabase) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [legacyDaily, legacyWeekly, dailyChunks, weeklyChunks] = await Promise.all([
    loadRow(supabase, 'daily_history'), loadRow(supabase, 'weekly_history'),
    loadChunked(supabase, 'daily_history_'), loadChunked(supabase, 'weekly_history_'),
  ]);
  const daySplitPriority = key => (key.includes('__') ? 1 : 0);
  const history = {};
  if (legacyDaily) Object.assign(history, legacyDaily);
  [...dailyChunks].sort((a, b) => daySplitPriority(a.key) - daySplitPriority(b.key)).forEach(c => Object.assign(history, c.payload));
  const weeklyHistory = {};
  if (legacyWeekly) Object.assign(weeklyHistory, legacyWeekly);
  weeklyChunks.forEach(c => Object.assign(weeklyHistory, c.payload));
  cache = { at: Date.now(), history, weeklyHistory };
  return cache;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, start, end } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'manager' && employee.role !== 'district_leader') {
    res.status(403).json({ error: 'Store ranking is only available to store managers and District Leaders.' });
    return;
  }
  if (!ISO_DATE.test(start || '') || !ISO_DATE.test(end || '') || start > end) {
    res.status(400).json({ error: 'A valid start and end date are required.' });
    return;
  }

  try {
    const { history, weeklyHistory } = await loadHistory(supabase);
    const totals = getRangeTotals(history, weeklyHistory, start, end);
    const cpdCur = getStoreCutsPerDay(history, weeklyHistory, start, end);
    const cpdLY = getStoreCutsPerDay(history, weeklyHistory, shiftYearISO(start, -1), shiftYearISO(end, -1));
    const rows = Object.entries(totals).map(([code, t]) => {
      const shape = historyTotalsToReportShape(t);
      const row = { code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, signatureSCount: shape.signatureSCount, cpd: cpdOf(cpdCur[code]), cpdLY: cpdOf(cpdLY[code]) };
      METRIC_KEYS.forEach(k => { if (k !== 'cpd') row[k] = shape[k]; });
      return row;
    });

    if (employee.role === 'district_leader') {
      // Company-wide Top 10s, same "skip blanks, then top 10" rule as the
      // Homepage's TopTenChart. Employee rows carry only name, store, and
      // the one metric being ranked.
      const top10Of = (list, key) => sortByMetric(list.filter(r => r[key] != null), key, 'desc').slice(0, 10);
      const employees = Object.entries(totals).flatMap(([code, t]) => {
        const storeName = STORE_CODE_TO_NAME[code] || `Store ${code}`;
        return historyTotalsToReportShape(t).employees.map(e => ({ ...e, store: storeName }));
      });
      const top10 = { stores: {}, employees: {} };
      METRIC_KEYS.forEach(key => {
        top10.stores[key] = top10Of(rows, key);
        if (key !== 'cpd') top10.employees[key] = top10Of(employees, key).map(e => ({ name: e.name, store: e.store, [key]: e[key] }));
      });
      res.status(200).json({ ok: true, storeCount: rows.length, top10 });
      return;
    }

    const ownCodes = (employee.store_codes || []).filter(c => totals[c]);
    const windows = {};
    METRIC_KEYS.forEach(key => {
      const ranked = sortByMetric(rows, key, 'desc');
      windows[key] = {};
      ownCodes.forEach(own => {
        const i = ranked.findIndex(r => r.code === own);
        const from = Math.max(0, i - NEIGHBORS);
        windows[key][own] = ranked.slice(from, i + NEIGHBORS + 1).map((r, j) => ({
          rank: from + j + 1, code: r.code, name: r.name, value: r[key] ?? null, isMine: r.code === own,
          signatureSCount: r.signatureSCount, cpdLY: r.cpdLY,
        }));
      });
    });
    res.status(200).json({ ok: true, storeCount: rows.length, windows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
