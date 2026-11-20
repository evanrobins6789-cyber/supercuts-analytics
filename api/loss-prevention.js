// Vercel serverless function — Node.js runtime.
// Loss Prevention data (owner-only). Lives in its own `loss_prevention`
// table, NOT weekly_report: weekly_report is readable with the public anon
// key that ships in the site's JS, and this data names employees flagged for
// review. The table has RLS on with no policies, so only this endpoint's
// service-role client can touch it (see HANDOFF.md for the one-time SQL).
//
// POST { token, action: 'load' }                 -> { rows: [{ key, payload }] }
// POST { token, action: 'save', key, payload }   -> { ok }
// Keys are lp_sales_YYYY-MM / lp_att_YYYY-MM / lp_reg_YYYY-MM (src/lossPrevention.js).

import { createServiceClient, requireSession } from '../src/serverAuth.js';

// lp_appt_: services started then deleted with no sale (src/appointments.js).
// lp_apptstaff_: no-shows / cancels / walkouts per stylist (src/reputation.js).
const KEY_PATTERN = /^lp_(sales|att|reg|appt|apptstaff)_\d{4}-\d{2}$/;

function setupHint(message) {
  return /loss_prevention/.test(message || '') && /(does not exist|could not find|schema cache)/i.test(message)
    ? 'The loss_prevention table hasn\'t been created in Supabase yet — run the one-time SQL from HANDOFF.md.'
    : message;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }

  const { token, action, key, payload } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  if (employee.role !== 'owner') { res.status(403).json({ error: 'Only the owner can see loss prevention data.' }); return; }

  try {
    if (action === 'load') {
      // Paged by size (2026-11-20): a year+ of guest codes would pass
      // Vercel's 4.5 MB response limit in one go. The client follows `next`.
      const PAGE_BYTES = 3 * 1024 * 1024;
      const after = typeof req.body.after === 'string' ? req.body.after : null;
      const rows = [];
      let bytes = 0, cursor = after, next = null;
      for (;;) {
        let q = supabase.from('loss_prevention').select('key, payload').order('key').limit(20);
        if (cursor) q = q.gt('key', cursor);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        let stop = false;
        for (const row of data) {
          const size = JSON.stringify(row.payload).length;
          if (rows.length && bytes + size > PAGE_BYTES) { next = cursor; stop = true; break; }
          rows.push(row);
          bytes += size;
          cursor = row.key;
        }
        if (stop || data.length < 20) break;
      }
      res.status(200).json({ rows, next });
      return;
    }
    if (action === 'save') {
      if (!KEY_PATTERN.test(key || '')) { res.status(400).json({ error: 'Invalid loss prevention key.' }); return; }
      if (!payload || typeof payload !== 'object') { res.status(400).json({ error: 'Missing payload.' }); return; }
      const { error } = await supabase.from('loss_prevention')
        .upsert({ key, payload, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(error.message);
      res.status(200).json({ saved: key });
      return;
    }
    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ error: setupHint(err.message) });
  }
}
