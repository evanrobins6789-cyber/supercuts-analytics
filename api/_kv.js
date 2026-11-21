// Server-side handler (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/scoped-data { action: 'kv-*' }).
//
// 2026-11-20: weekly_report used to be read and written straight from the
// browser with the public anon key that ships in the site's JS, so anyone
// with that key could read every row (sales, hours, names, reviews) and
// overwrite any of it. Now the table is locked to the service role (SQL in
// HANDOFF.md) and every db.js load/save/clear comes here with a session
// token:
//   kv-load         { key }                  any login; sensitive keys are filtered by role (scopeFilter.js)
//   kv-load-prefix  { prefix, after }        paged by size; a sensitive prefix is owner-only (others use the scoped loads)
//   kv-save         { key, payload | gz }    owner: any key; others: only SHARED_WRITE_KEYS
//   kv-delete       { key }                  same rule as kv-save
//   kv-delete-prefix{ prefix }               owner only
// `gz` = base64 gzip of the JSON payload, for big rows (reviews ~5 MB) that
// would pass Vercel's 4.5 MB request limit as plain JSON.

import zlib from 'zlib';
import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { filterPayload } from '../src/scopeFilter.js';

const KEY_RE = /^[A-Za-z0-9_:.\-|]{1,200}$/;
// Rows any logged-in role may write (what the app's non-owner screens save
// today: news sign-offs, HSA sign-ups, review notes / gold combs, events and
// news posts). Everything else is owner-only; store goals and the other
// per-store rows go through the scoped PATCH path in scoped-data.js.
const SHARED_WRITE_KEYS = new Set(['homepage_news_reads', 'hsa_signups', 'review_notes', 'review_gold_combs', 'homepage_events', 'homepage_news', 'homepage_news_groups']);
const SHARED_WRITE_PREFIXES = ['homepage_news_pdf_'];
const PAGE_BYTES = 3 * 1024 * 1024; // keep each response well under Vercel's 4.5 MB
// Rows fetched per Supabase query while filling a page. Rows past the page
// limit are thrown away and fetched again by the next call, so this stays
// small: with 20, a page of 3 big rows also pulled 17 more for nothing.
const BATCH = 3;

// iPhone push device rows (api/_push.js): owner-only to read, never written here.
const OWNER_ONLY_PREFIXES = ['push_device_'];
const ownerOnly = (employee, key) => employee.role !== 'owner' && OWNER_ONLY_PREFIXES.some(p => String(key).startsWith(p));

const canWrite = (employee, key) => !OWNER_ONLY_PREFIXES.some(p => String(key).startsWith(p)) && (employee.role === 'owner' || SHARED_WRITE_KEYS.has(key) || SHARED_WRITE_PREFIXES.some(p => key.startsWith(p)));

export async function handleKv(req, res, { isSensitiveKey, sensitivePrefixes }) {
  const supabase = createServiceClient();
  if (!supabase) { res.status(500).json({ error: 'Login is not configured on this deployment.' }); return; }
  const { token, action, key, prefix, payload, gz, after } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) { res.status(401).json({ error: sessionError }); return; }
  const table = () => supabase.from('weekly_report');

  try {
    if (action === 'kv-load') {
      if (!KEY_RE.test(key || '')) { res.status(400).json({ error: 'Invalid key.' }); return; }
      const { data, error } = await table().select('payload').eq('report_id', key).maybeSingle();
      if (error) throw new Error(error.message);
      const value = data && !ownerOnly(employee, key) ? data.payload : null;
      res.status(200).json({ ok: true, data: value != null && isSensitiveKey(key) ? filterPayload(key, value, employee) : value });
      return;
    }

    // Several single keys in one call (2026-11-20): the startup load asks for
    // 8 small rows at once; one request instead of 8 saves 7 function calls
    // and 14 session lookups on every login/refresh.
    if (action === 'kv-load-many') {
      const keys = Array.isArray(req.body.keys) ? req.body.keys : null;
      if (!keys || !keys.length || keys.length > 50 || !keys.every(k => KEY_RE.test(k || ''))) { res.status(400).json({ error: 'Invalid keys.' }); return; }
      const { data, error } = await table().select('report_id, payload').in('report_id', keys);
      if (error) throw new Error(error.message);
      const byKey = new Map((data || []).map(r => [r.report_id, r.payload]));
      const results = keys.map(k => {
        const value = byKey.has(k) && !ownerOnly(employee, k) ? byKey.get(k) : null;
        return value != null && isSensitiveKey(k) ? filterPayload(k, value, employee) : value;
      });
      res.status(200).json({ ok: true, results });
      return;
    }

    if (action === 'kv-load-prefix') {
      if (!KEY_RE.test(prefix || '') || prefix.length < 4) { res.status(400).json({ error: 'Invalid prefix.' }); return; }
      const touchesSensitive = sensitivePrefixes.some(p => p.startsWith(prefix) || prefix.startsWith(p)) || isSensitiveKey(prefix);
      const touchesOwnerOnly = OWNER_ONLY_PREFIXES.some(p => p.startsWith(prefix) || prefix.startsWith(p));
      if ((touchesSensitive || touchesOwnerOnly) && employee.role !== 'owner') { res.status(403).json({ error: 'Not allowed.' }); return; }
      const rows = [];
      let bytes = 0, cursor = after || null, next = null;
      for (;;) {
        let q = table().select('report_id, payload').like('report_id', `${prefix}%`).order('report_id').limit(BATCH);
        if (cursor) q = q.gt('report_id', cursor);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        let stop = false;
        for (const row of data) {
          const size = JSON.stringify(row.payload).length;
          if (rows.length && bytes + size > PAGE_BYTES) { next = cursor; stop = true; break; }
          rows.push({ key: row.report_id, payload: row.payload });
          bytes += size;
          cursor = row.report_id;
        }
        if (stop || data.length < BATCH) break;
      }
      res.status(200).json({ ok: true, rows, next });
      return;
    }

    if (action === 'kv-save' || action === 'kv-delete') {
      if (!KEY_RE.test(key || '')) { res.status(400).json({ error: 'Invalid key.' }); return; }
      if (!canWrite(employee, key)) { res.status(403).json({ error: 'Only the owner can change this.' }); return; }
      if (action === 'kv-delete') {
        const { error } = await table().delete().eq('report_id', key);
        if (error) throw new Error(error.message);
        res.status(200).json({ ok: true });
        return;
      }
      let value = payload;
      if (gz) {
        try { value = JSON.parse(zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')); } catch { res.status(400).json({ error: 'Could not read the compressed data.' }); return; }
      }
      if (value == null) { res.status(400).json({ error: 'Missing data.' }); return; }
      const { error } = await table().upsert({ report_id: key, payload: value }, { onConflict: 'report_id' });
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'kv-delete-prefix') {
      if (employee.role !== 'owner') { res.status(403).json({ error: 'Only the owner can change this.' }); return; }
      if (!KEY_RE.test(prefix || '') || prefix.length < 6) { res.status(400).json({ error: 'Invalid prefix.' }); return; }
      const { error } = await table().delete().like('report_id', `${prefix}%`);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
