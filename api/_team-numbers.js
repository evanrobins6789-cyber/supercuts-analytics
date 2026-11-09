// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'team-numbers' }).
//
// "Team TSTH" tab (2026-11-09): a District Leader or manager opens one of
// their stores, then an employee, and sees what that person sees on My
// Numbers, pay included (the user's call, 2026-11-09). Sales and hours
// already reach them through the scoped daily/weekly history; this adds the
// two things that don't: tips (only for their own stores) and hourly pay
// rates (only for people who worked at their stores in the dates asked for,
// already matched to the POS name so aliases never leave the server).
// Also the company-wide peer averages for coaching, aggregates only.
// The owner's view uses the full data it already has and never calls this.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { buildPeerStats } from '../src/myNumbers.js';
import { buildRateLookup } from '../src/payTracker.js';

const MAX_DAYS = 400;
const ROLES = new Set(['owner', 'district_leader', 'manager']);

function monthKeysBetween(start, end) {
  const out = [];
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function loadPrefix(supabase, prefix) {
  const PAGE = 1000;
  let rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('weekly_report').select('report_id, payload').like('report_id', `${prefix}%`).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function handleTeamNumbers(req, res) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }
  const { token, start, end } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  if (!ROLES.has(employee.role)) { res.status(403).json({ error: 'Only District Leaders, managers and leadership can see this.' }); return; }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(start || '') || !iso.test(end || '') || start > end) { res.status(400).json({ error: 'Pick a valid date range.' }); return; }
  if ((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000 > MAX_DAYS) { res.status(400).json({ error: `Pick a range of ${MAX_DAYS} days or less.` }); return; }
  const isOwner = employee.role === 'owner';
  const allowed = new Set(employee.store_codes || []);
  const mine = code => isOwner || allowed.has(String(code));

  try {
    const months = monthKeysBetween(start, end);
    const [dailyRows, weeklyRows, tipRows] = await Promise.all([
      Promise.all(months.map(mk => loadPrefix(supabase, `daily_history_${mk}`))).then(r => r.flat()),
      loadPrefix(supabase, 'weekly_history'),
      Promise.all(months.map(mk => loadPrefix(supabase, `tips_history_${mk}`))).then(r => r.flat()),
    ]);

    // Tips at their own stores only.
    const tips = {};
    tipRows.forEach(row => Object.entries(row.payload || {}).forEach(([key, rec]) => {
      if (rec && mine(rec.code) && rec.date >= start && rec.date <= end) tips[key] = rec;
    }));

    // Everyone who worked at their stores in these dates, by POS name.
    const fullHistory = {};
    dailyRows.forEach(row => Object.assign(fullHistory, row.payload || {}));
    const fullWeekly = {};
    weeklyRows.forEach(row => Object.assign(fullWeekly, row.payload || {}));
    const names = new Set();
    Object.values(fullHistory).forEach(rec => {
      if (rec && mine(rec.code) && rec.date >= start && rec.date <= end) Object.keys(rec.employees || {}).forEach(n => names.add(n));
    });
    Object.values(fullWeekly).forEach(w => {
      if (!w || w.endDate < start || w.startDate > end) return;
      Object.entries(w.stores || {}).forEach(([code, s]) => { if (mine(code)) (s.employees || []).forEach(e => names.add(e.name)); });
    });
    Object.values(tips).forEach(rec => Object.keys(rec.employees || {}).forEach(n => names.add(n)));

    // Their hourly rates, matched the same way the owner's view matches them.
    const rates = {};
    try {
      const rateRows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('pay_rates').select('emp_number, name, rate').range(from, from + 999);
        if (error) throw new Error(error.message);
        rateRows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const { data: aliasRow } = await supabase.from('weekly_report').select('payload').eq('report_id', 'employee_name_aliases').maybeSingle();
      const rateFor = buildRateLookup(rateRows, aliasRow?.payload || {});
      names.forEach(n => {
        const m = rateFor(n);
        if (m && m.rate != null) rates[n] = m.rate;
      });
    } catch { /* pay_rates not set up: no base pay */ }

    // Company-wide averages for coaching when a store has fewer than 3
    // others (no names; the store-level ones are worked out in the browser).
    const { company } = buildPeerStats({ history: fullHistory, weeklyHistory: fullWeekly, names: new Set(), codes: [], start, end });
    res.status(200).json({ ok: true, tips, rates, company });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
