// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'maintenance-request' }).
//
// Homepage "Maintenance Request" widget (src/maintenance.js). Any logged-in
// role can send one, for a store they're assigned to (the owner can pick any
// store). Each request is:
//   1. saved to its own `maintenance_request_<id>` row in weekly_report, so
//      nothing is lost if the Sheet isn't set up yet, and two stores sending
//      at once can't overwrite each other; then
//   2. sent to the Google Sheet's Apps Script web app
//      (MAINTENANCE_SHEET_WEBAPP_URL + MAINTENANCE_SHEET_SECRET), which adds
//      the row and re-sorts the Sheet by DL. Setup -> Maintenance has the script.
// The DL always comes from the roster file on the server, never the browser.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { getLeaderForStoreCode } from '../src/leaderRoster.js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';

export const MAINTENANCE_MAX_ISSUE = 2000;

// Which store codes this person may send a request for. null = any store.
export function allowedStoreCodes(employee) {
  if (!employee) return [];
  if (employee.role === 'owner') return null;
  return (employee.store_codes || []).map(String);
}

export function buildMaintenanceRecord({ employee, storeCode, issue, now = new Date(), id }) {
  const code = String(storeCode || '').trim();
  const text = String(issue || '').replace(/\r\n/g, '\n').trim();
  if (!code || !STORE_CODE_TO_NAME[code]) return { error: 'Pick a store.' };
  const allowed = allowedStoreCodes(employee);
  if (allowed && !allowed.includes(code)) return { error: "You can only send requests for your own store." };
  if (!text) return { error: 'Type in the issue.' };
  if (text.length > MAINTENANCE_MAX_ISSUE) return { error: `Please keep it under ${MAINTENANCE_MAX_ISSUE} characters.` };
  return {
    record: {
      id,
      submittedAt: now.toISOString(),
      storeCode: code,
      storeName: STORE_CODE_TO_NAME[code],
      dl: getLeaderForStoreCode(code)?.leaderName || 'No DL',
      issue: text,
      submittedBy: employee.name || '',
      role: employee.role || '',
    },
  };
}

async function sendToSheet(record) {
  const url = process.env.MAINTENANCE_SHEET_WEBAPP_URL;
  const secret = process.env.MAINTENANCE_SHEET_SECRET;
  if (!url || !secret) return { ok: false, error: 'The Google Sheet isn\'t connected yet (Setup → Maintenance).' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, request: record }),
      redirect: 'follow',
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, error: 'The Google Sheet script didn\'t answer. Check it\'s deployed with "Who has access: Anyone".' };
    }
    return json.ok ? { ok: true } : { ok: false, error: json.error || 'The Google Sheet script reported a problem.' };
  } catch (err) {
    return { ok: false, error: 'Could not reach the Google Sheet script.' };
  }
}

export async function handleMaintenanceRequest(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, storeCode, issue } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const { record, error } = buildMaintenanceRecord({ employee, storeCode, issue, id });
  if (error) {
    res.status(400).json({ error });
    return;
  }
  try {
    const { error: dbError } = await supabase.from('weekly_report').upsert({ report_id: `maintenance_request_${id}`, payload: record }, { onConflict: 'report_id' });
    if (dbError) throw new Error(dbError.message);
  } catch (err) {
    console.error('maintenance request save failed:', err);
    res.status(500).json({ error: 'Could not save the request. Please try again.' });
    return;
  }
  const sheet = await sendToSheet(record);
  if (!sheet.ok) console.error('maintenance request sheet failed:', sheet.error);
  // Saved either way; sheetError tells the sender it didn't reach the Sheet.
  res.status(200).json({ ok: true, request: record, sheetError: sheet.ok ? null : sheet.error });
}
