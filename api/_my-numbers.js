// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'my-numbers' }).
//
// "My Numbers" (2026-11-03): any logged-in person, whatever their role, gets
// ONLY their own lines from Sales-Accrual/Attendance history (and tips), split
// by the store where they did the work, for a date range. A stylist who works
// West Lawn and picks up a shift at Kutztown sees both stores separately plus
// a combined total. Nothing about other employees or store totals is sent.
//
// People are matched by name: the session's own name plus any extra spellings
// leadership links to that login in Setup → Employee Access (the
// `employee_name_aliases` row, { [employee_code]: ["Sammy Allen", ...] }),
// since the POS name can differ from the Master Salon List name.
// Logins and PINs are untouched by any of this.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { normalizePersonName, pickOwnRecords, buildPeerStats } from '../src/myNumbers.js';

const MAX_DAYS = 400;

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

export async function handleMyNumbers(req, res) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }
  const { token, start, end } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(start || '') || !iso.test(end || '') || start > end) { res.status(400).json({ error: 'Pick a valid date range.' }); return; }
  if ((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000 > MAX_DAYS) { res.status(400).json({ error: `Pick a range of ${MAX_DAYS} days or less.` }); return; }

  try {
    const { data: aliasRow, error: aliasError } = await supabase.from('weekly_report').select('payload').eq('report_id', 'employee_name_aliases').maybeSingle();
    if (aliasError) throw new Error(aliasError.message);
    const aliases = (aliasRow?.payload || {})[employee.employee_code] || [];
    const names = new Set([employee.name, ...aliases].map(normalizePersonName).filter(Boolean));

    const months = monthKeysBetween(start, end);
    const [dailyRows, weeklyRows, tipRows] = await Promise.all([
      Promise.all(months.map(mk => loadPrefix(supabase, `daily_history_${mk}`))).then(r => r.flat()),
      loadPrefix(supabase, 'weekly_history'),
      Promise.all(months.map(mk => loadPrefix(supabase, `tips_history_${mk}`))).then(r => r.flat()),
    ]);
    const picked = pickOwnRecords({ dailyRows, weeklyRows, tipRows, names, start, end });
    // Coaching: averages of everyone else at the stores they worked (and
    // company-wide). Totals only, no names. The client only shows a store's
    // averages when 3+ others worked there, so one coworker's numbers can't
    // be read off them.
    const fullHistory = {};
    dailyRows.forEach(row => Object.assign(fullHistory, row.payload || {}));
    const fullWeekly = {};
    weeklyRows.forEach(row => Object.assign(fullWeekly, row.payload || {}));
    const codes = [...new Set(Object.values(picked.history).map(r => r.code))];
    Object.values(picked.weeklyHistory).forEach(w => Object.entries(w.stores || {}).forEach(([c, s]) => { if (s.employees?.length) codes.push(c); }));
    const peers = buildPeerStats({ history: fullHistory, weeklyHistory: fullWeekly, names, codes: [...new Set(codes)], start, end });
    // Their own hourly rate from the locked pay_rates table (Emp ID =
    // employee_code). Missing table or no row → null, never an error.
    let payRate = null;
    try {
      const { data: rateRow } = await supabase.from('pay_rates').select('rate').eq('emp_number', employee.employee_code).maybeSingle();
      if (rateRow && rateRow.rate != null) payRate = Number(rateRow.rate);
    } catch { /* table not set up: no base pay */ }
    res.status(200).json({ ok: true, name: employee.name, role: employee.role, matchedNames: [...names], ...picked, peers, payRate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
