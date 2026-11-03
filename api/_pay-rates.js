// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached via POST /api/scoped-data with action
// 'pay-rates-load' or 'pay-rates-upload').
//
// Employee hourly pay rates (2026-11-03), from the "Employee Pay Rate Report"
// export. Stored in their own `pay_rates` table (sql/pay_rates.sql) with RLS
// on and no policies, so the public anon key can't read them; only this
// endpoint can, with the service-role key, and only for an owner session.
// An upload is the full current list: rows not in the file are removed.

import { createServiceClient, requireSession } from '../src/serverAuth.js';

const MAX_ROWS = 5000;

async function ownerOnly(req, res) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return null; }
  const { employee, error } = await requireSession(supabase, req.body?.token);
  if (!employee) { res.status(401).json({ error }); return null; }
  if (employee.role !== 'owner') { res.status(403).json({ error: 'Only leadership can see pay rates.' }); return null; }
  return supabase;
}

const missingTableHint = msg => (/pay_rates/.test(msg || '') && /(does not exist|schema cache|relation)/i.test(msg || '')
  ? 'The pay_rates table isn\'t set up yet. Run sql/pay_rates.sql in Supabase → SQL Editor first.'
  : msg);

export async function handlePayRates(req, res) {
  const supabase = await ownerOnly(req, res);
  if (!supabase) return;
  const action = req.body.action;
  try {
    if (action === 'pay-rates-load') {
      const PAGE = 1000;
      let rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('pay_rates').select('emp_number, name, raw_name, rate, updated_at').range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE) break;
      }
      res.status(200).json({ ok: true, rows });
      return;
    }
    if (action === 'pay-rates-upload') {
      const input = Array.isArray(req.body.rows) ? req.body.rows : [];
      if (!input.length) { res.status(400).json({ error: 'No pay rates in that file.' }); return; }
      if (input.length > MAX_ROWS) { res.status(400).json({ error: `Too many rows (${input.length}).` }); return; }
      const now = new Date().toISOString();
      const seen = new Set();
      const rows = [];
      input.forEach(r => {
        const emp = String(r.empNumber || '').trim();
        const name = String(r.name || '').trim();
        if (!emp || !name || seen.has(emp)) return;
        seen.add(emp);
        const rate = Number(r.rate);
        rows.push({ emp_number: emp, name, raw_name: String(r.rawName || '').trim() || null, rate: Number.isFinite(rate) && rate > 0 ? rate : null, updated_at: now });
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from('pay_rates').upsert(rows.slice(i, i + 500), { onConflict: 'emp_number' });
        if (error) throw new Error(error.message);
      }
      // Full list: drop anyone who's no longer on it.
      const { error: delError, count } = await supabase.from('pay_rates').delete({ count: 'exact' }).lt('updated_at', now);
      if (delError) throw new Error(delError.message);
      res.status(200).json({ ok: true, count: rows.length, removed: count || 0 });
      return;
    }
    res.status(400).json({ error: 'Unknown pay rates action.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: missingTableHint(err.message) });
  }
}
