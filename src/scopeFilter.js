// Who sees what: the per-role filter for the store-scoped datasets.
// Shared by api/scoped-data.js (the real enforcement, server-side) and the
// owner's "View as DL" mode in App.js, which runs the same rules in the
// browser so the owner sees exactly what a DL's login would receive.
// Moved here unchanged from api/scoped-data.js.

import { rollup } from './parser.js';
import { getCodeForStoreName } from './storeDirectory.js';

// Gift card sales and the gift card goal: the owner sees all, a DL sees their
// own stores (read-only; 2026-11-03), and managers/employees get neither
// (no gift_card_history_*, and giftCardGoal stripped from store_goals).
// Only the owner can write giftCardGoal.
export const OWNER_ONLY_GOAL_FIELDS = ['giftCardGoal'];
// Matches the field itself and its monthly form (`giftCardGoal:2026-11`).
export const isOwnerOnlyGoalField = k => OWNER_ONLY_GOAL_FIELDS.some(f => k === f || k.startsWith(`${f}:`));


// Focus Stylist list: { [storeCode]: { [nameKey]: { name, tsthGoal, cphGoal, addedBy, addedAt } } }.
// Only the owner and District Leaders use it — a DL sees and edits their
// own stores' entries, the owner sees everyone. Managers/employees get
// nothing back and can't write it.
export const FOCUS_ROLES = new Set(['owner', 'district_leader']);

// Shear Check visits (salon checklist tab): { [storeCode]: { [visitId]: visit } }.
// Same roles as Focus Stylist: a DL saves and sees their own stores' visits,
// the owner sees all of them. Only the owner can delete a visit.
export const SALON_CHECK_ROLES = FOCUS_ROLES;


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

export function filterDailyHistory(payload, allowed) {
  if (!payload) return payload;
  const out = {};
  Object.entries(payload).forEach(([k, rec]) => { if (allowed.has(rec.code)) out[k] = rec; });
  return out;
}

function filterShiftHistory(payload, allowed) {
  if (!payload) return payload;
  const out = {};
  Object.entries(payload).forEach(([date, stores]) => {
    const kept = {};
    Object.entries(stores || {}).forEach(([code, v]) => { if (allowed.has(code)) kept[code] = v; });
    if (Object.keys(kept).length) out[date] = kept;
  });
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

// Focus stylists for managers/employees: their own stores' names and months
// only, for the FOCUS STYLIST tag. Goals and who added them stay with
// leadership.
function focusTagsOnly(payload, allowed) {
  const out = {};
  Object.entries(filterCodeKeyedObject(payload, allowed) || {}).forEach(([code, entries]) => {
    out[code] = {};
    Object.entries(entries || {}).forEach(([k, e]) => {
      if (e) out[code][k] = { name: e.name, month: e.month || String(e.addedAt || '').slice(0, 7) };
    });
  });
  return out;
}

export function filterPayload(key, payload, employee) {
  if (employee.role === 'owner') return payload;
  const allowed = new Set(employee.store_codes || []);
  if (key === 'stylist_report') return filterStylistReport(payload, allowed);
  if (key === 'reviews') return filterReviews(payload, allowed);
  if (key === 'store_goals') {
    const scoped = filterCodeKeyedObject(payload, allowed);
    if (!scoped) return scoped;
    const out = {};
    Object.entries(scoped).forEach(([code, g]) => {
      if (!g || typeof g !== 'object') { out[code] = g; return; }
      const rest = { ...g };
      if (employee.role !== 'district_leader') Object.keys(rest).forEach(k => { if (isOwnerOnlyGoalField(k)) delete rest[k]; });
      out[code] = rest;
    });
    return out;
  }
  if (key === 'store_managers' || key === 'milestone_goals') return filterCodeKeyedObject(payload, allowed);
  if (key === 'focus_stylists') return employee.role === 'district_leader' ? filterCodeKeyedObject(payload, allowed) : focusTagsOnly(payload, allowed);
  if (key === 'salon_checks') return employee.role === 'district_leader' ? filterCodeKeyedObject(payload, allowed) : {};
  if (key === 'salon_check_questions') return employee.role === 'district_leader' ? payload : {};
  // Gift card sales: a DL gets their own stores' days (Gift Cards tab, the
  // user's call 2026-11-03); managers/employees get nothing. Same
  // { key: { code, date, ... } } shape as daily_history, so same filter.
  // Tips (pay tracker, 2026-11-03): owner only while it's a leadership
  // preview. When each employee sees their own, filter by name here.
  if (key.startsWith('tips_history_')) return {};
  // Shift times (Scheduling tab, src/scheduling.js): { date: { code: shifts } }.
  // DLs and managers get their own stores; employees get nothing, since it
  // holds coworkers' clock times.
  if (key.startsWith('shift_history_')) return employee.role === 'district_leader' || employee.role === 'manager' ? filterShiftHistory(payload, allowed) : {};
  // POS-name spellings linked to logins (Setup → Employee Access): owner only.
  if (key === 'employee_name_aliases') return {};
  if (key.startsWith('gift_card_history_')) return employee.role === 'district_leader' ? filterDailyHistory(payload, allowed) : {};
  // Leases (rent/landlord/critical-date data) are owner-only, full stop —
  // unlike store_goals/store_managers/milestone_goals, no other role has a
  // legitimate reason to see even their own store's entry, so this isn't a
  // per-store scope-down, it's a blanket deny for anyone but the owner.
  if (key === 'store_leases') return {};
  // Focus Stores (leadership's 90-day plan, src/focusStores.js): owner only.
  if (key === 'focus_stores') return {};
  if (key === 'daily_history' || key.startsWith('daily_history_')) return filterDailyHistory(payload, allowed);
  if (key === 'weekly_history' || key.startsWith('weekly_history_')) return filterWeeklyHistory(payload, allowed);
  return payload;
}
