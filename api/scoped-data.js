// Vercel serverless function — Node.js runtime.
// Server-enforced replacement for db.js's loadData/loadDataByPrefix, used
// only for the sensitive, store-scoped datasets (sales numbers, goals,
// reviews). Given a session token, it loads the employee's CURRENT role and
// store_codes fresh from the `employees` table (never trusts anything in
// the token itself) and filters the requested payload down to what that
// role is allowed to see before it ever leaves the server — unlike the rest
// of this app's data, which the client fetches directly from Supabase with
// the public anon key. An owner session gets everything, unfiltered.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { rollup } from '../src/parser.js';
import { getCodeForStoreName } from '../src/storeDirectory.js';

const SENSITIVE_KEYS = new Set(['stylist_report', 'reviews', 'store_goals', 'store_managers', 'milestone_goals', 'daily_history', 'weekly_history']);
const SENSITIVE_PREFIXES = ['daily_history_', 'weekly_history_'];

function isAllowedKey(key) {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_PREFIXES.some(p => key.startsWith(p));
}

function filterStylistReport(payload, allowed) {
  if (!payload) return payload;
  const stores = payload.stores.filter(s => allowed.has(s.code));
  const allEmployees = payload.allEmployees.filter(e => {
    const code = getCodeForStoreName(e.store);
    return code && allowed.has(code);
  });
  return {
    ...payload,
    stores,
    allEmployees,
    companyTotals: rollup(allEmployees),
    storeCount: stores.length,
    employeeCount: allEmployees.length,
  };
}

function filterReviews(payload, allowed) {
  if (!payload) return payload;
  return { ...payload, reviews: payload.reviews.filter(r => allowed.has(r.code)) };
}

function filterCodeKeyedObject(payload, allowed) {
  if (!payload) return payload;
  const out = {};
  Object.entries(payload).forEach(([code, val]) => { if (allowed.has(code)) out[code] = val; });
  return out;
}

function filterDailyHistory(payload, allowed) {
  if (!payload) return payload;
  const out = {};
  Object.entries(payload).forEach(([k, rec]) => { if (allowed.has(rec.code)) out[k] = rec; });
  return out;
}

function filterWeeklyHistory(payload, allowed) {
  if (!payload) return payload;
  const out = {};
  Object.entries(payload).forEach(([weekKey, rec]) => {
    const stores = {};
    Object.entries(rec.stores || {}).forEach(([code, val]) => { if (allowed.has(code)) stores[code] = val; });
    out[weekKey] = { ...rec, stores };
  });
  return out;
}

function filterPayload(key, payload, employee) {
  if (employee.role === 'owner') return payload;
  const allowed = new Set(employee.store_codes || []);
  if (key === 'stylist_report') return filterStylistReport(payload, allowed);
  if (key === 'reviews') return filterReviews(payload, allowed);
  if (key === 'store_goals' || key === 'store_managers' || key === 'milestone_goals') return filterCodeKeyedObject(payload, allowed);
  if (key === 'daily_history' || key.startsWith('daily_history_')) return filterDailyHistory(payload, allowed);
  if (key === 'weekly_history' || key.startsWith('weekly_history_')) return filterWeeklyHistory(payload, allowed);
  return payload;
}

async function loadRow(supabase, key) {
  const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.payload : null;
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

  const { token, key, prefix } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }

  try {
    if (key) {
      if (!isAllowedKey(key)) {
        res.status(400).json({ error: `"${key}" is not available through this endpoint.` });
        return;
      }
      const payload = await loadRow(supabase, key);
      res.status(200).json({ ok: true, data: filterPayload(key, payload, employee) });
      return;
    }

    if (prefix) {
      if (!SENSITIVE_PREFIXES.includes(prefix)) {
        res.status(400).json({ error: `"${prefix}" is not available through this endpoint.` });
        return;
      }
      // Same pagination approach as db.js's loadDataByPrefix — PostgREST
      // caps a single select around 1000 rows.
      const PAGE_SIZE = 1000;
      let rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error: pageError } = await supabase.from('weekly_report').select('*').like('report_id', `${prefix}%`).range(from, from + PAGE_SIZE - 1);
        if (pageError) throw new Error(pageError.message);
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
      }
      const filtered = rows.map(row => ({ key: row.report_id, payload: filterPayload(row.report_id, row.payload, employee) }));
      res.status(200).json({ ok: true, data: filtered });
      return;
    }

    res.status(400).json({ error: 'Missing key or prefix.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
