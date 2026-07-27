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

export function setSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
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

export function signUp({ employeeCode, phone, password }) {
  return postJson('/api/auth', { action: 'signup', employeeCode, phone, password });
}

export function logIn({ phone, password }) {
  return postJson('/api/auth', { action: 'login', phone, password });
}

export function logOut(token) {
  return postJson('/api/auth', { action: 'logout', token });
}

export async function loadScoped(key) {
  const session = getSession();
  if (!session) return { data: null, source: 'supabase', error: 'Not logged in' };
  const res = await postJson('/api/scoped-data', { token: session.token, key });
  if (!res.ok) return { data: null, source: 'supabase', error: res.error };
  return { data: res.data, source: 'supabase', error: null };
}

export async function loadScopedByPrefix(prefix) {
  const session = getSession();
  if (!session) return { data: [], source: 'supabase', error: 'Not logged in' };
  const res = await postJson('/api/scoped-data', { token: session.token, prefix });
  if (!res.ok) return { data: [], source: 'supabase', error: res.error };
  return { data: res.data, source: 'supabase', error: null };
}

export function rosterList(token) {
  return postJson('/api/roster', { action: 'list', token });
}

export function rosterUpload(token, rows) {
  return postJson('/api/roster', { action: 'upload', token, rows });
}

export function rosterResetPassword(token, id) {
  return postJson('/api/roster', { action: 'resetPassword', token, id });
}
