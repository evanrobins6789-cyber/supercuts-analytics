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
import { filterPayload, isOwnerOnlyGoalField, FOCUS_ROLES, SALON_CHECK_ROLES } from '../src/scopeFilter.js';
import { handleFinalizeGoals } from './_finalize-goals.js';
import { handleSalonCheckEmail, handleSalonCheckPhoto, handleSalonCheckQuestion, cleanSalonCheckPatch, removeDeletedVisitPhotos } from './_salon-check.js';
import { handleMyNumbers } from './_my-numbers.js';
import { handleTeamNumbers } from './_team-numbers.js';
import { handlePayRates } from './_pay-rates.js';
import { handleTabFavorites } from './_tab-favorites.js';
import { handleCouponStats } from './_coupon-stats.js';

const SENSITIVE_KEYS = new Set(['stylist_report', 'reviews', 'store_goals', 'store_managers', 'milestone_goals', 'daily_history', 'weekly_history', 'store_leases', 'focus_stylists', 'salon_checks', 'salon_check_questions', 'employee_name_aliases', 'focus_stores']);
const SENSITIVE_PREFIXES = ['daily_history_', 'weekly_history_', 'gift_card_history_', 'tips_history_'];

// Goal fields any role may read but only the owner may write.
const OWNER_ONLY_GOAL_WRITE_PREFIXES = ['salesGoal:'];

// Subset of SENSITIVE_KEYS that are a flat { [storeCode]: {...fields} }
// object and support scoped PATCH writes below — a merge-in for just the
// codes in the patch, never a full-object overwrite. store_goals/
// store_managers/milestone_goals/store_leases all share this shape.
const PATCHABLE_KEYS = new Set(['store_goals', 'store_managers', 'milestone_goals', 'store_leases', 'focus_stylists', 'salon_checks', 'employee_name_aliases', 'focus_stores']);

function isAllowedKey(key) {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_PREFIXES.some(p => key.startsWith(p));
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
  // Goals tab "Finalize & email DLs" rides on this function (it does its
  // own owner-session check); see api/_finalize-goals.js for why.
  if (req.body?.action === 'finalize-goals') {
    await handleFinalizeGoals(req, res);
    return;
  }
  // Pay rates (owner only, locked pay_rates table): api/_pay-rates.js.
  if (req.body?.action === 'pay-rates-load' || req.body?.action === 'pay-rates-upload') {
    await handlePayRates(req, res);
    return;
  }
  // "My Numbers": the caller's own lines only, any role (api/_my-numbers.js).
  if (req.body?.action === 'my-numbers') {
    await handleMyNumbers(req, res);
    return;
  }
  // "Team TSTH": tips + pay rates for a DL's/manager's own stores (api/_team-numbers.js).
  if (req.body?.action === 'team-numbers') {
    await handleTeamNumbers(req, res);
    return;
  }
  // Coupons tab (owner only): ad coupon numbers from the landing-page site (api/_coupon-stats.js).
  if (req.body?.action === 'coupon-stats') {
    await handleCouponStats(req, res);
    return;
  }
  // Starred tabs: the caller's own, any role (api/_tab-favorites.js).
  if (req.body?.action === 'tab-favorites-load' || req.body?.action === 'tab-favorites-save') {
    await handleTabFavorites(req, res);
    return;
  }
  // Shear Check "email the DL" rides here too (api/_salon-check.js).
  if (req.body?.action === 'salon-check-email') {
    await handleSalonCheckEmail(req, res);
    return;
  }
  // Shear Check add/delete a question (owner only, same file).
  if (req.body?.action === 'salon-check-question') {
    await handleSalonCheckQuestion(req, res);
    return;
  }
  // Shear Check section photos (same file).
  if (req.body?.action === 'salon-check-photo') {
    await handleSalonCheckPhoto(req, res);
    return;
  }

  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }

  const { token, key, prefix, patch } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }

  try {
    // Scoped write — a merge-in, not a read. Exists because store_goals/
    // store_managers/milestone_goals reads are already filtered down to a
    // non-owner's own stores (filterPayload below), but a plain client-side
    // overwrite of the whole row (the old db.js saveData path) would take
    // whatever's in that non-owner's browser — which, thanks to that same
    // filtering, NEVER included any other DL's stores in the first place —
    // and write it back as the entire row, silently deleting everyone
    // else's entries. This forces every write to go through a read-merge-
    // write against the CURRENT full row instead, and rejects a patch that
    // touches a store code the caller isn't scoped to.
    if (key && patch) {
      if (!PATCHABLE_KEYS.has(key)) {
        res.status(400).json({ error: `"${key}" does not support scoped patch writes.` });
        return;
      }
      // Milestone goals stay put until leadership changes them (Setup >
      // Milestone Goals, and the Milestone column on the Goals tab).
      if (key === 'milestone_goals' && employee.role !== 'owner') {
        res.status(403).json({ error: 'Only leadership can change milestone goals.' });
        return;
      }
      if (key === 'focus_stylists' && !FOCUS_ROLES.has(employee.role)) {
        res.status(403).json({ error: 'Only District Leaders and leadership can set focus stylists.' });
        return;
      }
      if (key === 'salon_checks') {
        if (!SALON_CHECK_ROLES.has(employee.role)) {
          res.status(403).json({ error: 'Only District Leaders and leadership can save salon checks.' });
          return;
        }
        // Validates every visit and recomputes its score server-side, so a
        // stored score always matches its answers.
        const checked = cleanSalonCheckPatch(patch, employee, await loadRow(supabase, 'salon_check_questions'));
        if (checked.error) {
          res.status(checked.status || 400).json({ error: checked.error });
          return;
        }
        Object.keys(patch).forEach(code => { patch[code] = checked.patch[code]; });
      }
      if (employee.role !== 'owner') {
        // Leases have no per-store carve-out like store_goals does — a
        // non-owner can't patch even their own store's lease entry.
        if (key === 'employee_name_aliases') {
          res.status(403).json({ error: 'Only the owner can link POS names to logins.' });
          return;
        }
        if (key === 'store_leases') {
          res.status(403).json({ error: 'Only the owner can modify lease data.' });
          return;
        }
        if (key === 'focus_stores') {
          res.status(403).json({ error: 'Only leadership can change focus stores.' });
          return;
        }
        if (key === 'store_goals' && Object.values(patch).some(v => v && typeof v === 'object' && Object.keys(v).some(isOwnerOnlyGoalField))) {
          res.status(403).json({ error: 'Only the owner can set gift card goals.' });
          return;
        }
        // Monthly Sales goals (`salesGoal:YYYY-MM`, Goals tab) are set by
        // leadership only. DLs still read them; only writes are refused.
        if (key === 'store_goals' && Object.values(patch).some(v => v && typeof v === 'object' && Object.keys(v).some(f => OWNER_ONLY_GOAL_WRITE_PREFIXES.some(p => f.startsWith(p))))) {
          res.status(403).json({ error: 'Only leadership can set monthly Sales goals.' });
          return;
        }
        const allowed = new Set(employee.store_codes || []);
        const disallowed = Object.keys(patch).filter(code => !allowed.has(code));
        if (disallowed.length) {
          res.status(403).json({ error: `Not authorized to modify store(s): ${disallowed.join(', ')}` });
          return;
        }
      }
      const current = (await loadRow(supabase, key)) || {};
      const merged = { ...current };
      // Three shapes a per-store patch value can take: `null` deletes the
      // store's entry entirely (clearing a manager); an object merges into
      // whatever fields already exist there (store_goals/milestone_goals,
      // each store's value is itself `{ field: value, ... }`); anything else
      // (store_managers — a plain manager-name string) replaces the whole
      // per-store value outright, since there's nothing to merge into.
      Object.entries(patch).forEach(([code, value]) => {
        if (value === null) { delete merged[code]; return; }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          merged[code] = { ...merged[code], ...value };
        } else {
          merged[code] = value;
        }
        // A focus stylist is removed by patching their entry to null —
        // drop it (and the store, once empty) rather than storing nulls.
        if ((key === 'focus_stylists' || key === 'salon_checks' || key === 'focus_stores') && merged[code]) {
          Object.keys(merged[code]).forEach(k => { if (merged[code][k] == null) delete merged[code][k]; });
          if (!Object.keys(merged[code]).length) delete merged[code];
        }
      });
      const { error: upsertError } = await supabase.from('weekly_report').upsert({ report_id: key, payload: merged }, { onConflict: 'report_id' });
      if (upsertError) throw new Error(upsertError.message);
      if (key === 'salon_checks') await removeDeletedVisitPhotos(supabase, current, patch);
      res.status(200).json({ ok: true, data: filterPayload(key, merged, employee) });
      return;
    }

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
