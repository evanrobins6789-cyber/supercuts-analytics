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

const KEY_PATTERN = /^lp_(sales|att|reg)_\d{4}-\d{2}$/;

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
      const PAGE_SIZE = 1000;
      let rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase.from('loss_prevention').select('key, payload').range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
      }
      res.status(200).json({ rows });
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
