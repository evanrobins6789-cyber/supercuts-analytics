import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

const LOCAL_PREFIX = 'supercuts_report_v1_';

function readLocal(key) {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Generic loader/saver — `key` distinguishes multiple datasets (the weekly
// stylist report, the employee start-date roster, etc.) sharing one table.
// Returns { data, source: 'supabase'|'local', error }
export async function loadData(key) {
  if (supabase) {
    const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
    if (!error) {
      return { data: data ? data.payload : null, source: 'supabase', error: null };
    }
    return { data: readLocal(key), source: 'local', error: error.message };
  }
  return { data: readLocal(key), source: 'local', error: null };
}

// Returns { ok, error }
export async function saveData(key, payload) {
  if (payload == null) return { ok: false, error: 'Internal error: no data to save' };
  let error = null;
  if (supabase) {
    const res = await supabase.from('weekly_report').upsert({ report_id: key, payload }, { onConflict: 'report_id' });
    if (res.error) { error = res.error.message; console.error('Supabase save error', res.error); }
  }
  let localError = null;
  try { localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(payload)); }
  catch (err) { localError = err.message; console.error('localStorage save error', err); }
  // When Supabase isn't configured, localStorage is the ONLY persistence
  // layer — a swallowed quota/serialization failure there must surface as a
  // real error instead of a false "saved" result (the exact silent-failure
  // shape that caused historical-import data to vanish before, just one
  // layer deeper). When Supabase IS configured and it succeeded, a local
  // mirror failure isn't fatal — the data is safe server-side.
  if (!error && !supabase && localError) error = localError;
  return { ok: !error, error };
}

// Returns { ok, error } — callers that clean up a superseded format after a
// save must know if the delete actually happened, since a swallowed failure
// here leaves a stale row sitting in Supabase that a future unordered SELECT
// can merge back on top of fresh data (the exact "data vanishes on refresh"
// shape this has caused before).
export async function clearData(key) {
  let error = null;
  if (supabase) {
    const res = await supabase.from('weekly_report').delete().eq('report_id', key);
    if (res.error) { error = res.error.message; console.error('Supabase clear error', res.error); }
  }
  localStorage.removeItem(LOCAL_PREFIX + key);
  return { ok: !error, error };
}

// ─── Prefix-based storage (for large, ever-growing datasets) ───────────────
// Splitting something like 18 months of daily history into one row per
// month keeps each individual save small and fast, instead of one giant
// JSON blob that eventually hits Supabase's statement timeout.
function readLocalByPrefix(prefix) {
  const results = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LOCAL_PREFIX + prefix)) {
      try {
        results.push({ key: k.slice(LOCAL_PREFIX.length), payload: JSON.parse(localStorage.getItem(k)) });
      } catch { /* skip corrupt entry */ }
    }
  }
  return results;
}

// Returns { data: [{key, payload}], source, error }
export async function loadDataByPrefix(prefix) {
  if (supabase) {
    // PostgREST caps a single .select() at (usually) 1000 rows — for a large
    // franchise with years of history split into per-month/per-store-month
    // chunks, that cap is realistic to hit, and going over it would silently
    // drop whole months from the load with no error at all (looks exactly
    // like data loss). Page through with .range() until a page comes back
    // short, so every chunk is always fetched regardless of table size.
    const PAGE_SIZE = 1000;
    let rows = [];
    let error = null;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error: pageError } = await supabase.from('weekly_report').select('*').like('report_id', `${prefix}%`).range(from, from + PAGE_SIZE - 1);
      if (pageError) { error = pageError; break; }
      rows = rows.concat(data || []);
      if (!data || data.length < PAGE_SIZE) break;
    }
    if (!error) {
      const remote = rows.map(row => ({ key: row.report_id, payload: row.payload }));
      // A chunk can exist locally (every save writes local first) but be
      // missing from Supabase if that one chunk's upsert failed or hasn't
      // synced yet — e.g. a large historical-import month timing out.
      // Fill any such gaps from local so a partial sync failure on THIS
      // device doesn't look like data loss on refresh; Supabase still wins
      // for any key both sides have, since it's the cross-device source of truth.
      const remoteKeys = new Set(remote.map(r => r.key));
      const localOnly = readLocalByPrefix(prefix).filter(r => !remoteKeys.has(r.key));
      return { data: [...remote, ...localOnly], source: 'supabase', error: null, localOnlyKeys: localOnly.map(r => r.key) };
    }
    return { data: readLocalByPrefix(prefix), source: 'local', error: error.message };
  }
  return { data: readLocalByPrefix(prefix), source: 'local', error: null };
}

// Returns { ok, error } — see clearData's comment on why the caller needs this.
export async function clearDataByPrefix(prefix) {
  let error = null;
  if (supabase) {
    const res = await supabase.from('weekly_report').delete().like('report_id', `${prefix}%`);
    if (res.error) { error = res.error.message; console.error('Supabase clear-by-prefix error', res.error); }
  }
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LOCAL_PREFIX + prefix)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  return { ok: !error, error };
}
