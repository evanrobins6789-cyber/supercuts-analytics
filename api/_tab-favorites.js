// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'tab-favorites-load' | 'tab-favorites-save' }).
//
// Starred tabs (src/TabMenu.js), saved to the person's account so they follow
// them between devices. Any logged-in role. Each person has their own
// `tab_favorites_<employee id>` row, and the id always comes from the session,
// never the request, so nobody can read or change someone else's. One row per
// person also means two people saving at once can't overwrite each other.

import { createServiceClient, requireSession } from '../src/serverAuth.js';

const MAX_TABS = 40;
const MAX_NAME_LENGTH = 40;

export function cleanTabs(tabs) {
  if (!Array.isArray(tabs)) return null;
  const names = tabs.filter(t => typeof t === 'string' && t.length > 0 && t.length <= MAX_NAME_LENGTH);
  return [...new Set(names)].slice(0, MAX_TABS);
}

export async function handleTabFavorites(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { action, token, tabs } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  const rowId = `tab_favorites_${employee.id}`;

  try {
    if (action === 'tab-favorites-load') {
      const { data, error } = await supabase.from('weekly_report').select('payload').eq('report_id', rowId).maybeSingle();
      if (error) throw new Error(error.message);
      // null (not []) means nothing saved yet, so the browser can carry over
      // favorites it already has.
      res.status(200).json({ ok: true, tabs: cleanTabs(data?.payload?.tabs) });
      return;
    }
    const cleaned = cleanTabs(tabs);
    if (!cleaned) {
      res.status(400).json({ error: 'Favorites must be a list of tab names.' });
      return;
    }
    const { error } = await supabase.from('weekly_report').upsert({ report_id: rowId, payload: { tabs: cleaned } }, { onConflict: 'report_id' });
    if (error) throw new Error(error.message);
    res.status(200).json({ ok: true, tabs: cleaned });
  } catch (err) {
    console.error('tab favorites failed:', err);
    res.status(500).json({ error: err.message || 'Could not reach saved favorites.' });
  }
}
