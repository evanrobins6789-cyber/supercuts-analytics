import { listScopedKeys, loadScopedKeys } from './auth';

// ─── Fast history loading (2026-11-23) ─────────────────────────────────────
// Daily history is ~1,350 rows / ~34 MB for the owner. It used to come down
// in one request before the dashboard showed anything (10-15 s). Now:
//   1. list the row keys (+ updated_at versions) the caller may see — no data;
//   2. use rows already saved on this device whose version still matches;
//   3. fetch the rest newest-month-first, in small batches, a few at a time.
// The device copy lives in IndexedDB, holds only what this login is allowed
// to see (the server filters every row), is wiped when the login's scope
// changes (different person / role / stores), and on Log Out
// (clearHistoryCache). Without the updated_at column (see HANDOFF) versions
// are null and nothing is cached; loading is still recent-first.

const DB_NAME = 'dashboard-cache';
const STORE = 'rows';
const SCOPE_KEY = '__scope';
const BATCH_KEYS = 60;      // ~1.5-3.5 MB of raw JSON per request
const CONCURRENCY = 4;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(db => new Promise(resolve => {
    if (!db) { resolve(null); return; }
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : true);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

const cacheGetAll = () => run('readonly', s => s.getAll()).then(r => r || []);
const cachePut = rows => (rows.length ? run('readwrite', s => { rows.forEach(r => s.put(r)); }) : Promise.resolve(true));
const cacheDelete = keys => (keys.length ? run('readwrite', s => { keys.forEach(k => s.delete(k)); }) : Promise.resolve(true));

// Log Out / login change: remove every saved row from this device.
export function clearHistoryCache() {
  return run('readwrite', s => s.clear());
}

const monthOf = (prefix, key) => key.slice(prefix.length, prefix.length + 7);

function monthsBack(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (n - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// onRows(rows, phase) is called with [{ key, payload }] as rows arrive:
// phase 'cache' (from this device), 'recent' or 'older'. onRecentDone()
// fires once the latest `recentMonths` months are in. Resolves to
// { ok, error, keys } once everything is loaded (or a batch failed twice).
export async function loadHistoryFast({ prefix, token, recentMonths = 3, onRows, onRecentDone }) {
  const list = await listScopedKeys(prefix, token);
  if (!list.ok) return { ok: false, error: list.error, fallback: true };
  const listed = list.keys || [];
  const listedKeys = new Set(listed.map(r => r.k));

  let cached = await cacheGetAll();
  const scopeRow = cached.find(r => r.k === SCOPE_KEY);
  if (!scopeRow || scopeRow.scope !== list.scope) {
    if (cached.length) await clearHistoryCache();
    cached = [];
    await cachePut([{ k: SCOPE_KEY, scope: list.scope }]);
  }
  const cachedByKey = new Map(cached.filter(r => r.k !== SCOPE_KEY).map(r => [r.k, r]));
  // Saved rows that no longer exist on the server (or belong to another prefix's
  // cleanup) are dropped from the device.
  const gone = [...cachedByKey.keys()].filter(k => k.startsWith(prefix) && !listedKeys.has(k));
  if (gone.length) cacheDelete(gone);

  const fresh = [];
  const toFetch = [];
  listed.forEach(({ k, v }) => {
    const c = cachedByKey.get(k);
    if (v && c && c.v === v) fresh.push({ key: k, payload: c.payload });
    else toFetch.push(k);
  });
  if (fresh.length) onRows(fresh, 'cache');

  toFetch.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest month first
  const cutoff = monthsBack(recentMonths);
  const recent = toFetch.filter(k => monthOf(prefix, k) >= cutoff);
  const older = toFetch.filter(k => monthOf(prefix, k) < cutoff);

  const fetchAll = async (keys, phase) => {
    const batches = [];
    for (let i = 0; i < keys.length; i += BATCH_KEYS) batches.push(keys.slice(i, i + BATCH_KEYS));
    let next = 0;
    let error = null;
    const worker = async () => {
      while (next < batches.length && !error) {
        const batch = batches[next++];
        let res = await loadScopedKeys(prefix, batch, token);
        if (!res.ok) res = await loadScopedKeys(prefix, batch, token); // one retry
        if (!res.ok) { error = res.error || 'Request failed'; return; }
        const rows = res.data || [];
        onRows(rows.map(r => ({ key: r.key, payload: r.payload })), phase);
        cachePut(rows.filter(r => r.v).map(r => ({ k: r.key, v: r.v, payload: r.payload })));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return error;
  };

  const recentError = await fetchAll(recent, 'recent');
  if (onRecentDone) onRecentDone();
  if (recentError) return { ok: false, error: recentError, keys: [...listedKeys] };
  const olderError = await fetchAll(older, 'older');
  if (olderError) return { ok: false, error: olderError, keys: [...listedKeys] };
  return { ok: true, error: null, keys: [...listedKeys] };
}
