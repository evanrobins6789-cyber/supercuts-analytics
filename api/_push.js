// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'push-*' }).
//
// iPhone app push notifications (2026-11-21). The iOS app (ios/, Capacitor)
// loads this site; on login src/push.js asks for permission and sends the
// phone's APNs device token here.
//   push-register   { token, deviceToken }        any logged-in role
//   push-unregister { token, deviceToken }        any logged-in role (log out)
//   push-send       { token, title, body, audience } owner only
// Each phone is its own `push_device_<hash>` row in weekly_report (service
// role only; _kv.js keeps these rows owner-only). Only the employee id is
// stored: role, stores and "still active" come fresh from `employees` at send
// time, so a removed login stops getting pushes at once.
//
// Sending goes straight to Apple (APNs HTTP/2, token auth). Vercel env vars:
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY (the .p8 file's text),
//   APNS_BUNDLE_ID (default below), APNS_SANDBOX=1 only for Xcode debug builds.

import crypto from 'crypto';
import http2 from 'http2';
import { createServiceClient, requireSession } from '../src/serverAuth.js';

export const PUSH_PREFIX = 'push_device_';
const DEFAULT_BUNDLE_ID = 'com.robinsdashboard.app';
const MAX_TITLE = 100;
const MAX_BODY = 400;

export const deviceKey = deviceToken => PUSH_PREFIX + crypto.createHash('sha256').update(String(deviceToken)).digest('hex').slice(0, 32);
const validDeviceToken = t => /^[0-9a-fA-F]{32,200}$/.test(String(t || ''));

// audience: { all: true } | { roles: ['owner','district_leader','manager','employee'] } | { storeCodes: ['80306'] }
// (roles and storeCodes together = both must match).
export function matchesAudience(employee, audience) {
  if (!employee || !employee.active) return false;
  const a = audience || {};
  if (a.all) return true;
  const roles = Array.isArray(a.roles) && a.roles.length ? a.roles : null;
  const stores = Array.isArray(a.storeCodes) && a.storeCodes.length ? a.storeCodes.map(String) : null;
  if (!roles && !stores) return false;
  if (roles && !roles.includes(employee.role)) return false;
  if (stores) {
    const mine = (employee.store_codes || []).map(String);
    if (employee.role !== 'owner' && !mine.some(c => stores.includes(c))) return false;
  }
  return true;
}

function privateKey() {
  const raw = process.env.APNS_PRIVATE_KEY || '';
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && privateKey());
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function apnsJwt({ keyId, teamId, key, now = Date.now() }) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64url(sig)}`;
}

// Sends one alert to many device tokens over a single HTTP/2 connection.
// Returns { sent, dead: [deviceToken], failed: [{deviceToken, status, reason}] }.
async function sendApns(deviceTokens, { title, body }) {
  const host = process.env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const jwt = apnsJwt({ keyId: process.env.APNS_KEY_ID, teamId: process.env.APNS_TEAM_ID, key: privateKey() });
  const topic = process.env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' } });
  const client = http2.connect(host);
  const result = { sent: 0, dead: [], failed: [] };
  const one = deviceToken => new Promise(resolve => {
    let status = 0, data = '';
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'content-type': 'application/json',
    });
    req.setTimeout(10000, () => { req.close(); });
    req.on('response', h => { status = h[':status']; });
    req.on('data', c => { data += c; });
    req.on('end', () => {
      if (status === 200) result.sent++;
      else {
        let reason = '';
        try { reason = JSON.parse(data).reason || ''; } catch { /* empty body */ }
        if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') result.dead.push(deviceToken);
        else result.failed.push({ deviceToken, status, reason });
      }
      resolve();
    });
    req.on('error', err => { result.failed.push({ deviceToken, status: 0, reason: err.message }); resolve(); });
    req.end(payload);
  });
  try {
    for (let i = 0; i < deviceTokens.length; i += 50) await Promise.all(deviceTokens.slice(i, i + 50).map(one));
  } finally {
    client.close();
  }
  return result;
}

async function loadDevices(supabase) {
  const rows = [];
  let after = null;
  for (;;) {
    let q = supabase.from('weekly_report').select('report_id, payload').like('report_id', `${PUSH_PREFIX}%`).order('report_id').limit(500);
    if (after) q = q.gt('report_id', after);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    after = data[data.length - 1].report_id;
    if (data.length < 500) break;
  }
  return rows;
}

// Used by the push-send action and by anything else on the server that wants
// to notify people. Never throws for "not set up yet": returns { ok:false, error }.
export async function sendPush(supabase, { title, body, audience }) {
  if (!apnsConfigured()) return { ok: false, error: 'Push notifications aren\'t set up yet (Setup → iPhone App).' };
  const rows = await loadDevices(supabase);
  if (!rows.length) return { ok: true, sent: 0, devices: 0, people: 0 };
  const ids = [...new Set(rows.map(r => r.payload?.employeeId).filter(Boolean))];
  const { data: emps, error } = await supabase.from('employees').select('id, role, store_codes, active').in('id', ids);
  if (error) throw new Error(error.message);
  const byId = new Map((emps || []).map(e => [String(e.id), e]));
  const targets = rows.filter(r => matchesAudience(byId.get(String(r.payload?.employeeId)), audience));
  const tokens = targets.map(r => r.payload.deviceToken);
  if (!tokens.length) return { ok: true, sent: 0, devices: 0, people: 0 };
  const out = await sendApns(tokens, { title, body });
  if (out.dead.length) {
    await supabase.from('weekly_report').delete().in('report_id', out.dead.map(deviceKey));
  }
  return {
    ok: true,
    sent: out.sent,
    devices: tokens.length,
    people: new Set(targets.map(r => String(r.payload.employeeId))).size,
    removed: out.dead.length,
    failed: out.failed.length,
    firstError: out.failed[0] ? `${out.failed[0].status} ${out.failed[0].reason}`.trim() : undefined,
  };
}

export async function handlePush(req, res) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }
  const { token, action, deviceToken } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  const table = () => supabase.from('weekly_report');

  try {
    if (action === 'push-register' || action === 'push-unregister') {
      if (!validDeviceToken(deviceToken)) { res.status(400).json({ error: 'Invalid device token.' }); return; }
      const key = deviceKey(deviceToken);
      if (action === 'push-unregister') {
        // Only drop it if it's this person's phone (or the owner asks).
        const { data } = await table().select('payload').eq('report_id', key).maybeSingle();
        if (data && (String(data.payload?.employeeId) === String(employee.id) || employee.role === 'owner')) {
          const { error } = await table().delete().eq('report_id', key);
          if (error) throw new Error(error.message);
        }
        res.status(200).json({ ok: true });
        return;
      }
      // One row per phone: a phone that changes hands moves to the new login.
      const payload = { deviceToken: String(deviceToken), employeeId: employee.id, platform: 'ios', updatedAt: new Date().toISOString() };
      const { error } = await table().upsert({ report_id: key, payload }, { onConflict: 'report_id' });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'push-send') {
      if (employee.role !== 'owner') { res.status(403).json({ error: 'Only the owner can send notifications.' }); return; }
      const title = String(req.body.title || '').trim().slice(0, MAX_TITLE);
      const body = String(req.body.body || '').trim().slice(0, MAX_BODY);
      if (!title && !body) { res.status(400).json({ error: 'Type a title or a message.' }); return; }
      const result = await sendPush(supabase, { title: title || 'Update', body, audience: req.body.audience });
      res.status(result.ok ? 200 : 400).json(result);
      return;
    }

    if (action === 'push-stats') {
      if (employee.role !== 'owner') { res.status(403).json({ error: 'Not allowed.' }); return; }
      const rows = await loadDevices(supabase);
      res.status(200).json({ ok: true, devices: rows.length, people: new Set(rows.map(r => String(r.payload?.employeeId))).size, configured: apnsConfigured() });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
