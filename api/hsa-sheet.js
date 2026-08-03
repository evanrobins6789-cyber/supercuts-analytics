// Vercel serverless function — Node.js runtime.
// Forwards one HSA class sign-up to a Google Sheet, via a Google Apps
// Script "Web App" the user deploys themselves (Setup > HSA has the
// walkthrough + script) — same free, no-paid-service pattern as the Gmail
// report automation in api/email-report.js, just running in the opposite
// direction (we call out to Google instead of Google calling in to us).
//
// The webhook URL + shared secret live server-side only (HSA_SHEET_WEBHOOK_URL
// / HSA_SHEET_SECRET env vars), same reasoning as EMAIL_INGEST_SECRET never
// being embedded in the public bundle. Requires a logged-in session (any
// role) purely to stop a random caller from spamming rows into the user's
// spreadsheet via this endpoint's public URL — the underlying sign-up data
// itself isn't sensitive.
//
// This is deliberately best-effort: the in-app sign-up (saved straight to
// Supabase by the client, same as homepage news/events) is the source of
// truth, so a Sheets-export failure here should never be reported back as
// the sign-up itself having failed.

import { createServiceClient, requireSession } from '../src/serverAuth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }

  const { token, date, event, location, time, name, phone, store, dl } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Missing name.' });
    return;
  }

  const webhookUrl = process.env.HSA_SHEET_WEBHOOK_URL;
  const secret = process.env.HSA_SHEET_SECRET;
  if (!webhookUrl || !secret) {
    // Not configured yet — the in-app sign-up already succeeded by the time
    // this is called, so report that plainly rather than as an error.
    res.status(200).json({ ok: true, sheetSynced: false, sheetError: 'Google Sheets export is not set up yet.' });
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret, date, event, location, time,
        name: String(name).trim(), phone: phone || '', store: store || '', dl: dl || '', signedUpBy: employee.name,
        signedUpAt: new Date().toISOString(),
      }),
    });
    res.status(200).json({ ok: true, sheetSynced: response.ok });
  } catch (err) {
    res.status(200).json({ ok: true, sheetSynced: false, sheetError: err.message });
  }
}
