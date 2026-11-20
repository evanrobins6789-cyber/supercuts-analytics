import { createClient } from '@supabase/supabase-js';
import { isWriteBlocked, PRESENTER_BLOCKED_ERROR } from './presenter';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

// 2026-11-20: weekly_report is locked to the server (the anon key in this
// bundle can't read or write it any more). Every load/save/clear below goes
// through /api/scoped-data's kv-* actions (api/_kv.js) with the login token,
// which App sets with setDbToken(). The `supabase` client above is still
// used for Storage uploads to signed URLs.
let dbToken = null;
export function setDbToken(token) { dbToken = token || null; }
const remote = () => isConfigured() && !!dbToken;
async function kv(body) {
  let res;
  try {
    res = await fetch('/api/scoped-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dbToken, ...body }) });
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error || `Request failed (${res.status})` };
  return { ok: true, ...json };
}
// Big rows go gzipped (Vercel caps a request at 4.5 MB; reviews are ~5 MB).
const GZIP_OVER = 1024 * 1024;
async function gzipBase64(text) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function kvSave(key, payload) {
  const text = JSON.stringify(payload);
  const gz = text.length > GZIP_OVER ? await gzipBase64(text) : null;
  return kv(gz ? { action: 'kv-save', key, gz } : { action: 'kv-save', key, payload });
}

// Server only, no localStorage mirror (for big rows that would fill this
// browser's storage: shift times, appointments). Returns { ok, error }.
export async function saveRemote(key, payload) {
  if (isWriteBlocked()) return { ok: false, error: PRESENTER_BLOCKED_ERROR };
  if (!remote()) return { ok: false, error: 'Not logged in, so nothing was saved.' };
  const r = await kvSave(key, payload);
  return { ok: r.ok, error: r.ok ? null : r.error };
}

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
// loadData calls made in the same tick (the startup Promise.all asks for 8)
// go to the server as one kv-load-many request instead of one each.
let loadQueue = null;
function queueLoad(key) {
  return new Promise(resolve => {
    if (!loadQueue) {
      loadQueue = [];
      setTimeout(async () => {
        const batch = loadQueue; loadQueue = null;
        const keys = [...new Set(batch.map(b => b.key))];
        const r = keys.length === 1 ? await kv({ action: 'kv-load', key: keys[0] }) : await kv({ action: 'kv-load-many', keys });
        batch.forEach(b => b.resolve(r.ok ? { ok: true, data: keys.length === 1 ? r.data : r.results[keys.indexOf(b.key)] } : r));
      }, 0);
    }
    loadQueue.push({ key, resolve });
  });
}
export async function loadData(key) {
  if (remote()) {
    const r = await queueLoad(key);
    if (r.ok) return { data: r.data ?? null, source: 'supabase', error: null };
    return { data: readLocal(key), source: 'local', error: r.error };
  }
  return { data: readLocal(key), source: 'local', error: null };
}

// Returns { ok, error }
export async function saveData(key, payload) {
  // Presenter mode: refuse before touching Supabase OR the local mirror (a
  // local-only write would get auto-pushed to Supabase on a later load).
  if (isWriteBlocked()) return { ok: false, error: PRESENTER_BLOCKED_ERROR };
  if (payload == null) return { ok: false, error: 'Internal error: no data to save' };
  let error = null;
  if (remote()) {
    const res = await kvSave(key, payload);
    if (!res.ok) { error = res.error; console.error('Supabase save error', res.error); }
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
  if (!error && !remote() && localError) error = localError;
  return { ok: !error, error };
}

// Returns { ok, error } — callers that clean up a superseded format after a
// save must know if the delete actually happened, since a swallowed failure
// here leaves a stale row sitting in Supabase that a future unordered SELECT
// can merge back on top of fresh data (the exact "data vanishes on refresh"
// shape this has caused before).
export async function clearData(key) {
  if (isWriteBlocked()) return { ok: false, error: PRESENTER_BLOCKED_ERROR };
  let error = null;
  if (remote()) {
    const res = await kv({ action: 'kv-delete', key });
    if (!res.ok) { error = res.error; console.error('Supabase clear error', res.error); }
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
  if (remote()) {
    // PostgREST caps a single .select() at (usually) 1000 rows — for a large
    // franchise with years of history split into per-month/per-store-month
    // chunks, that cap is realistic to hit, and going over it would silently
    // drop whole months from the load with no error at all (looks exactly
    // like data loss). Page through with .range() until a page comes back
    // short, so every chunk is always fetched regardless of table size.
    // The server pages by size (api/_kv.js); follow `next` until done.
    let rows = [];
    let error = null;
    for (let after = null; ;) {
      const r = await kv({ action: 'kv-load-prefix', prefix, after });
      if (!r.ok) { error = { message: r.error }; break; }
      rows = rows.concat(r.rows || []);
      if (!r.next) break;
      after = r.next;
    }
    if (!error) {
      const remoteRows = rows;
      // A chunk can exist locally (every save writes local first) but be
      // missing from Supabase if that one chunk's upsert failed or hasn't
      // synced yet — e.g. a large historical-import month timing out.
      // Fill any such gaps from local so a partial sync failure on THIS
      // device doesn't look like data loss on refresh; Supabase still wins
      // for any key both sides have, since it's the cross-device source of truth.
      const remoteKeys = new Set(remoteRows.map(r => r.key));
      const localOnly = readLocalByPrefix(prefix).filter(r => !remoteKeys.has(r.key));
      return { data: [...remoteRows, ...localOnly], source: 'supabase', error: null, localOnlyKeys: localOnly.map(r => r.key) };
    }
    return { data: readLocalByPrefix(prefix), source: 'local', error: error.message };
  }
  return { data: readLocalByPrefix(prefix), source: 'local', error: null };
}

// Returns { ok, error } — see clearData's comment on why the caller needs this.
export async function clearDataByPrefix(prefix) {
  if (isWriteBlocked()) return { ok: false, error: PRESENTER_BLOCKED_ERROR };
  let error = null;
  if (remote()) {
    const res = await kv({ action: 'kv-delete-prefix', prefix });
    if (!res.ok) { error = res.error; console.error('Supabase clear-by-prefix error', res.error); }
  }
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LOCAL_PREFIX + prefix)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
  return { ok: !error, error };
}
