import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { STORE_CODE_TO_NAME } from './storeDirectory';

// ─── iPhone app + push notifications (2026-11-21) ──────────────────────────
// The iOS app (ios/, Capacitor, see capacitor.config.json) is a native shell
// that loads this site. Inside the app, Capacitor.isNativePlatform() is true
// and the PushNotifications plugin works; in a normal browser everything
// here does nothing. After login: ask for permission (iOS shows its prompt
// once), register with Apple, and send the phone's device token to
// api/_push.js (push-register). On log out the token is removed so the next
// person on that phone doesn't get the last person's notifications.
// Sending: the owner's Setup → iPhone App page, plus every new News post.

export const isNativeApp = () => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

async function post(body) {
  try {
    const res = await fetch('/api/scoped-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...json } : { ok: false, error: json.error || `Request failed (${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

let deviceToken = null;
let listening = false;
let pendingLoginToken = null;

async function addListeners() {
  if (listening) return;
  listening = true;
  await PushNotifications.addListener('registration', t => {
    deviceToken = t.value;
    if (pendingLoginToken) post({ action: 'push-register', token: pendingLoginToken, deviceToken });
  });
  await PushNotifications.addListener('registrationError', err => {
    console.warn('Push registration failed', err);
  });
}

// Call after every login / app start with a session token. Safe to call
// more than once; does nothing outside the iPhone app.
export async function startPush(loginToken) {
  if (!isNativeApp() || !loginToken) return;
  pendingLoginToken = loginToken;
  try {
    await addListeners();
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    if (deviceToken) post({ action: 'push-register', token: loginToken, deviceToken });
    await PushNotifications.register();
  } catch (err) {
    console.warn('Push setup failed', err);
  }
}

// Call on log out, BEFORE the session token is thrown away.
export function stopPush(loginToken) {
  pendingLoginToken = null;
  if (!isNativeApp() || !loginToken || !deviceToken) return;
  post({ action: 'push-unregister', token: loginToken, deviceToken });
}

// Owner only (the server checks). audience: { all:true } | { roles:[...] } | { storeCodes:[...] }
export function sendPushNotification(loginToken, { title, body, audience }) {
  return post({ action: 'push-send', token: loginToken, title, body, audience });
}

export function pushStats(loginToken) {
  return post({ action: 'push-stats', token: loginToken });
}

const AUDIENCES = [
  { key: 'all', label: 'Everyone with the app', audience: { all: true } },
  { key: 'leaders', label: 'DLs only', audience: { roles: ['district_leader'] } },
  { key: 'managers', label: 'Managers only', audience: { roles: ['manager'] } },
  { key: 'leaders_managers', label: 'DLs + Managers', audience: { roles: ['district_leader', 'manager'] } },
  { key: 'store', label: 'One store (everyone there)', audience: null },
];

// Setup → iPhone App (owner): send a notification + the setup steps.
export function PushSetupTab({ token }) {
  const [stats, setStats] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [who, setWho] = useState('all');
  const [store, setStore] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const stores = useMemo(() => Object.entries(STORE_CODE_TO_NAME).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name)), []);

  useEffect(() => {
    if (!token) return;
    pushStats(token).then(r => setStats(r.ok ? r : { error: r.error }));
  }, [token]);

  const pick = AUDIENCES.find(a => a.key === who);
  const audience = who === 'store' ? (store ? { storeCodes: [store] } : null) : pick.audience;
  const canSend = token && audience && (title.trim() || body.trim()) && !sending;

  const send = async e => {
    e.preventDefault();
    if (!canSend) return;
    if (!window.confirm(`Send this notification to: ${who === 'store' ? STORE_CODE_TO_NAME[store] : pick.label}?`)) return;
    setSending(true); setStatus(null);
    const r = await sendPushNotification(token, { title: title.trim(), body: body.trim(), audience });
    setSending(false);
    if (!r.ok) { setStatus({ kind: 'error', text: r.error || 'Could not send.' }); return; }
    const extra = r.failed ? ` ${r.failed} failed (${r.firstError}).` : '';
    setStatus({ kind: r.failed ? 'warn' : 'ok', text: r.devices ? `Sent to ${r.sent} of ${r.devices} phone${r.devices === 1 ? '' : 's'} (${r.people} ${r.people === 1 ? 'person' : 'people'}).${extra}` : 'Nobody in that group has the app with notifications turned on yet.' });
    if (r.sent) { setTitle(''); setBody(''); }
  };

  return (
    <div className="setup-section">
      <div className="setup-sql-card">
        <p className="chart-title">iPhone app + push notifications</p>
        <p className="step-body">The iPhone app opens this same site, so every change here shows up in the app right away. When someone logs in to the app, it asks once to allow notifications. Every new News post sends a notification to everyone with the app, and you can send your own below.</p>
        {stats && !stats.error && (
          <p className="step-body"><strong>{stats.people}</strong> {stats.people === 1 ? 'person has' : 'people have'} notifications on ({stats.devices} phone{stats.devices === 1 ? '' : 's'}).{!stats.configured && ' Sending isn\'t set up yet: see step 3 below.'}</p>
        )}
        {stats?.error && <p className="step-body">{stats.error}</p>}
      </div>

      <form className="setup-sql-card push-send" onSubmit={send}>
        <p className="chart-title">Send a notification</p>
        <label className="push-field">Send to
          <select value={who} onChange={e => setWho(e.target.value)}>
            {AUDIENCES.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
        {who === 'store' && (
          <label className="push-field">Store
            <select value={store} onChange={e => setStore(e.target.value)}>
              <option value="">Pick a store…</option>
              {stores.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="push-field">Title
          <input value={title} maxLength={100} onChange={e => setTitle(e.target.value)} placeholder="e.g. Schedules are posted" />
        </label>
        <label className="push-field">Message
          <textarea value={body} maxLength={400} rows={3} onChange={e => setBody(e.target.value)} placeholder="What do you want people to know?" />
        </label>
        <button className="btn-primary" type="submit" disabled={!canSend}>{sending ? 'Sending…' : 'Send notification'}</button>
        {status && <p className={`push-status push-status-${status.kind}`}>{status.text}</p>}
      </form>

      <div className="setup-step">
        <div className="step-num">1</div>
        <div><p className="step-title">Apple Developer account</p><p className="step-body">Sign up at developer.apple.com/programs ($99/year). In Certificates, Identifiers &amp; Profiles → Identifiers, add an App ID with the bundle ID <code>com.robinsdashboard.app</code> and tick <strong>Push Notifications</strong>.</p></div>
      </div>
      <div className="setup-step">
        <div className="step-num">2</div>
        <div><p className="step-title">Push key</p><p className="step-body">Keys → + → name it "Push", tick <strong>Apple Push Notifications service (APNs)</strong> → Continue → Register → Download the <code>.p8</code> file (Apple only lets you download it once). Note the <strong>Key ID</strong> on that page and your <strong>Team ID</strong> (top right of the developer site, under your name).</p></div>
      </div>
      <div className="setup-step">
        <div className="step-num">3</div>
        <div><p className="step-title">Add four settings in Vercel</p><p className="step-body">Vercel project → Settings → Environment Variables: <code>APNS_KEY_ID</code> (the Key ID), <code>APNS_TEAM_ID</code> (the Team ID), <code>APNS_PRIVATE_KEY</code> (open the .p8 file in Notepad and paste everything, including the BEGIN/END lines), and <code>APNS_BUNDLE_ID</code> = <code>com.robinsdashboard.app</code>. Do this on both Vercel projects for this site, then redeploy.</p></div>
      </div>
      <div className="setup-step">
        <div className="step-num">4</div>
        <div><p className="step-title">Build the app</p><p className="step-body">The app is built from GitHub by Codemagic (codemagic.yaml in the repo) and uploaded to App Store Connect. The steps are in <code>IOS_APP_GUIDE.md</code> in the repo.</p></div>
      </div>
    </div>
  );
}
