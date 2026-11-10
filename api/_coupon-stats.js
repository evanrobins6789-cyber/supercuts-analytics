// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'coupon-stats', token, start, end }).
//
// Coupons tab (owner only): ad coupon numbers from the separate landing-page
// site (Documents/landing-pages, its api/stats.js). That site keeps its own
// Supabase project; this server asks it for totals with a shared secret, so
// neither site holds the other's database key and the browser never sees the
// secret.
// Env: COUPON_STATS_TOKEN (same value as STATS_TOKEN on the landing site),
//      COUPON_SITE_URL (optional, defaults to the landing site's Vercel URL).

import { createServiceClient, requireSession } from '../src/serverAuth.js';

const DEFAULT_SITE = 'https://supercuts-landing-pages.vercel.app';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleCouponStats(req, res) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }
  const { token, start, end } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  if (employee.role !== 'owner') { res.status(403).json({ error: 'Only the owner can see coupon numbers.' }); return; }
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '') || start > end) {
    res.status(400).json({ error: 'Pick a valid date range.' });
    return;
  }

  const secret = process.env.COUPON_STATS_TOKEN;
  if (!secret) {
    res.status(500).json({ error: 'COUPON_STATS_TOKEN isn\'t set on this dashboard\'s Vercel project yet (see HANDOFF.md, Coupons tab).' });
    return;
  }
  const site = (process.env.COUPON_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');
  try {
    const r = await fetch(`${site}/api/stats?from=${start}&to=${end}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    if (r.status === 401) { res.status(502).json({ error: 'The coupon site turned down the dashboard\'s secret. Check that COUPON_STATS_TOKEN here matches STATS_TOKEN on the landing site.' }); return; }
    if (!r.ok) { res.status(502).json({ error: `The coupon site answered: ${json.error || `error ${r.status}`}` }); return; }
    res.status(200).json({ from: json.from, to: json.to, offers: json.offers || [], summary: json.summary || [], daily: json.daily || [] });
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach the coupon site (${site}): ${err.message}` });
  }
}
