// Vercel serverless function — Node.js runtime.
// Returns the full HSA sign-up roster (every sign-up joined to its class) so
// a Google Sheet can mirror it. The Apps Script in Setup > HSA calls this on
// a timer and rewrites its "Sign-ups" tab from scratch each time, so the
// Sheet always matches the app — existing sign-ups, edits, removals, and
// multi-day class merges included — with nothing to keep in step by hand.
//
// Auth is a single shared secret (HSA_SHEET_SECRET), same pattern as
// EMAIL_INGEST_SECRET in api/email-report.js — the caller is a script, not a
// logged-in user. The response includes phone numbers, so treat the secret
// like a password.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

async function loadRow(key) {
  const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
  if (error) throw new Error(`Supabase load failed: ${error.message}`);
  return data ? data.payload : null;
}

export const ROSTER_HEADER = ['Class', 'Start Date', 'End Date', 'Time', 'Location', 'Name', 'Phone', 'Store', 'DL', 'Entered By', 'Signed Up At'];

// One row per sign-up, sorted by class start date, then class, then name.
// A sign-up whose class no longer exists (e.g. the class was deleted) is
// still listed, at the bottom, so nobody silently disappears from the Sheet.
export function buildRoster(events, signups) {
  const classes = new Map((events || []).filter(ev => ev.source === 'hsa').map(ev => [ev.id, ev]));
  const rows = (signups || []).map(s => {
    const c = classes.get(s.classId);
    return {
      sortDate: c ? c.date : '9999-99-99',
      cells: [
        c ? (c.eventType || c.title || '') : '(class removed)',
        c ? c.date || '' : '',
        c ? c.endDate || '' : '',
        c ? c.time || '' : '',
        c ? c.location || '' : '',
        s.name || '', s.phone || '', s.store || '', s.dl || '', s.enteredBy || '',
        s.signedUpAt ? String(s.signedUpAt).slice(0, 10) : '',
      ],
    };
  });
  rows.sort((a, b) =>
    a.sortDate.localeCompare(b.sortDate)
    || a.cells[0].localeCompare(b.cells[0])
    || a.cells[4].localeCompare(b.cells[4])
    || a.cells[5].localeCompare(b.cells[5]));
  // Some stored names contain stray line breaks — flatten to one line per cell.
  return rows.map(r => r.cells.map(c => String(c).replace(/\s+/g, ' ').trim()));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expectedSecret = process.env.HSA_SHEET_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'HSA_SHEET_SECRET is not configured on this deployment.' });
    return;
  }
  const { secret } = req.body || {};
  if (secret !== expectedSecret) {
    res.status(401).json({ error: 'Invalid or missing secret.' });
    return;
  }
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured on this deployment.' });
    return;
  }

  try {
    const [events, signups] = await Promise.all([loadRow('homepage_events'), loadRow('hsa_signups')]);
    res.status(200).json({ ok: true, header: ROSTER_HEADER, rows: buildRoster(events, signups) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
