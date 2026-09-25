// Client-side session storage + wrappers around the login/roster/scoped-data
// serverless endpoints. loadScoped/loadScopedByPrefix intentionally return
// the same { data, source, error } shape db.js's loadData/loadDataByPrefix
// already use, so App.js's existing load/error-handling code doesn't need a
// second pattern for the sensitive keys that go through this instead.

import { isWriteBlocked, PRESENTER_BLOCKED_ERROR, fakeServerResponse } from './presenter';

const SESSION_KEY = 'supercuts_session_v1';

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Returns true if the session was actually persisted. This can fail (quota
// exceeded — this app mirrors a lot of data into localStorage, including
// base64 images/PDFs from Homepage News, which can fill a browser's whole
// per-origin quota) without throwing, so a caller that ignores the return
// value would never know the session silently didn't survive a refresh.
export function setSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); return true; } catch { return false; }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// Presenter mode: every write wrapper below goes through this instead of
// postJson, so nothing reaches the server while presenting.
function postWrite(url, body) {
  if (isWriteBlocked()) return Promise.resolve({ ok: false, error: PRESENTER_BLOCKED_ERROR });
  return postJson(url, body);
}

// Presenter mode: reads that components render directly get faked on the
// way back (names/phones/balances — see presenter.js fakeServerResponse).
async function postRead(kind, url, body) {
  const res = await postJson(url, body);
  return isWriteBlocked() ? fakeServerResponse(kind, res) : res;
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.error || `Request failed (${res.status})` };
  return { ok: true, ...json };
}

export function checkEligible({ phone }) {
  return postJson('/api/auth', { action: 'checkEligible', phone });
}

export function signUp({ phone, pin }) {
  return postJson('/api/auth', { action: 'signup', phone, pin });
}

export function logIn({ pin }) {
  return postJson('/api/auth', { action: 'login', pin });
}

export function logOut(token) {
  return postJson('/api/auth', { action: 'logout', token });
}

// Takes the token explicitly (from React state) instead of re-reading it via
// getSession() — the localStorage-backed session is a "remember me across a
// refresh" nicety, not the source of truth for the CURRENT page load. If
// that write silently failed (see setSession above), re-reading it here
// would wrongly treat an already-logged-in page as logged out and every
// scoped fetch would come back empty with no visible error.
export async function loadScoped(key, token) {
  if (!token) return { data: null, source: 'supabase', error: 'Not logged in' };
  const res = await postJson('/api/scoped-data', { token, key });
  if (!res.ok) return { data: null, source: 'supabase', error: res.error };
  return { data: res.data, source: 'supabase', error: null };
}

export async function loadScopedByPrefix(prefix, token) {
  if (!token) return { data: [], source: 'supabase', error: 'Not logged in' };
  const res = await postJson('/api/scoped-data', { token, prefix });
  if (!res.ok) return { data: [], source: 'supabase', error: res.error };
  return { data: res.data, source: 'supabase', error: null };
}

// Merge-in write for store_goals/store_managers/milestone_goals — `patch` is
// { [storeCode]: {...fields} } for just the store(s) being changed. The
// server reads the current full row, merges only these codes into it, and
// writes that back — never a full-row overwrite from the client's own
// (possibly role-scoped-down) local state. Returns the caller's own
// role-filtered view of the result, same shape as loadScoped.
export function saveScoped(token, key, patch) {
  return postWrite('/api/scoped-data', { token, key, patch });
}

// Owner-only Supabase Storage access for lease documents (api/lease-files.js).
// Returns a signed upload URL/token for one file — the actual bytes go
// straight from the browser to Supabase Storage (via supabase-js's
// uploadToSignedUrl), never through this endpoint's request body.
export function leaseUploadUrl(token, storeCode, fileName) {
  return postWrite('/api/lease-files', { token, action: 'uploadUrl', storeCode, fileName });
}

// Short-lived (10 min) signed read URL for a stored lease document, since
// the bucket itself is private.
export function leaseViewUrl(token, path) {
  return postWrite('/api/lease-files', { token, action: 'viewUrl', path });
}

export function leaseDeleteFile(token, path) {
  return postWrite('/api/lease-files', { token, action: 'delete', path });
}

// Pulls a store's already-uploaded lease documents' text (free, local
// pdf-parse + regex — no AI/API cost) and looks for a commencement/
// expiration date near the right keywords — for real Leasecake exports
// whose filenames carry no dates, this is the only automated way to fill
// term dates short of hand-entry (see api/scan-lease-dates.js). `files` is
// that store's `record.files` array ({ path, name }). `storeName` isn't
// used server-side anymore but is harmless to keep passing.
export function scanLeaseDates(token, storeCode, storeName, files) {
  return postWrite('/api/scan-lease-dates', { token, storeCode, storeName, files });
}

export function rosterList(token) {
  return postRead('rosterList', '/api/roster', { action: 'list', token });
}

export function rosterUpload(token, rows) {
  return postWrite('/api/roster', { action: 'upload', token, rows });
}

export function rosterResetPin(token, id) {
  return postWrite('/api/roster', { action: 'resetPin', token, id });
}

export function rosterSetPin(token, id, pin) {
  return postWrite('/api/roster', { action: 'setPin', token, id, pin });
}

export function rosterUpdate(token, id, patch) {
  return postWrite('/api/roster', { action: 'update', token, id, ...patch });
}

export function rosterLoginCounts(token) {
  return postRead('loginCounts', '/api/roster', { action: 'loginCounts', token });
}

// Employee points / "Tillie's Nest" shop — thin wrappers over api/points.js,
// same postJson shape as the roster wrappers above.
export function pointsBalance(token) {
  return postRead('pointsBalance', '/api/points', { action: 'balance', token });
}

export function pointsAward(token, employeeName) {
  return postWrite('/api/points', { action: 'award', token, employeeName });
}

export function pointsAllBalances(token) {
  return postRead('pointsAllBalances', '/api/points', { action: 'allBalances', token });
}

export function pointsTransactions(token, employeeName) {
  return postRead('pointsTransactions', '/api/points', { action: 'transactions', token, employeeName });
}

export function pointsDeleteTransaction(token, id) {
  return postWrite('/api/points', { action: 'deleteTransaction', token, id });
}

export function pointsRedeem(token, rewardId) {
  return postWrite('/api/points', { action: 'redeem', token, rewardId });
}

export function pointsListRewards(token) {
  return postJson('/api/points', { action: 'listRewards', token });
}

export function pointsSaveReward(token, patch) {
  return postWrite('/api/points', { action: 'saveReward', token, ...patch });
}

export function pointsDeleteReward(token, id) {
  return postWrite('/api/points', { action: 'deleteReward', token, id });
}

export function pointsMarkFulfilled(token, id, fulfilled) {
  return postWrite('/api/points', { action: 'markFulfilled', token, id, fulfilled });
}

// HSA class sign-ups — the sign-up itself is saved straight to Supabase by
// the caller (same loadData/saveData path as homepage news/events); this is
// only the best-effort Google Sheets export, so a failure here is read as
// `sheetSynced: false`, not thrown.
export function hsaSheetSync(token, payload) {
  return postWrite('/api/hsa-sheet', { token, ...payload });
}
