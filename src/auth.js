// Client-side session storage + wrappers around the login/roster/scoped-data
// serverless endpoints. loadScoped/loadScopedByPrefix intentionally return
// the same { data, source, error } shape db.js's loadData/loadDataByPrefix
// already use, so App.js's existing load/error-handling code doesn't need a
// second pattern for the sensitive keys that go through this instead.

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

export function checkEligible({ employeeCode, phone }) {
  return postJson('/api/auth', { action: 'checkEligible', employeeCode, phone });
}

export function signUp({ employeeCode, phone, pin }) {
  return postJson('/api/auth', { action: 'signup', employeeCode, phone, pin });
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

export function rosterList(token) {
  return postJson('/api/roster', { action: 'list', token });
}

export function rosterUpload(token, rows) {
  return postJson('/api/roster', { action: 'upload', token, rows });
}

export function rosterResetPin(token, id) {
  return postJson('/api/roster', { action: 'resetPin', token, id });
}
