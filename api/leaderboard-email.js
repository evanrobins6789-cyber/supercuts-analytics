// Vercel serverless function — Node.js runtime.
// Computes last week's company-wide Top 10 / Bottom 10 stores for Retail,
// Color Sales, and Signature Service, and hands back a ready-to-send HTML
// email body. Called by a Google Apps Script on a Monday-morning time
// trigger (Setup > Email Reports has the walkthrough) — the script does the
// mechanical part (fetch + GmailApp.sendEmail), all the actual computation
// happens here so it can share ./metrics.js with the live app instead of a
// second copy of the weekly-vs-daily dedup rules.
//
// Auth is a single shared secret (LEADERBOARD_EMAIL_SECRET), same pattern as
// EMAIL_INGEST_SECRET in api/email-report.js — there's no user session to
// check since this is a machine-to-machine call from Apps Script, not a
// logged-in browser.

import { createClient } from '@supabase/supabase-js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';
import { getRangeTotals, historyTotalsToReportShape, getLastFullWeekRange, sortByMetric } from '../src/metrics.js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

async function loadRow(key) {
  const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
  if (error) throw new Error(`Supabase load failed: ${error.message}`);
  return data ? data.payload : null;
}

// Same paging + legacy/split-chunk merge as App.js's main load effect (see
// its "[history load]" comments) — just without that path's diagnostics and
// self-healing cleanup, which belong to the interactive app, not a
// stateless read here.
async function loadChunked(prefix) {
  const PAGE_SIZE = 1000;
  let rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('weekly_report').select('*').like('report_id', `${prefix}%`).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase load failed: ${error.message}`);
    rows = rows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows.map(r => ({ key: r.report_id, payload: r.payload }));
}

async function loadHistory() {
  const [legacyDaily, legacyWeekly, dailyChunks, weeklyChunks] = await Promise.all([
    loadRow('daily_history'), loadRow('weekly_history'),
    loadChunked('daily_history_'), loadChunked('weekly_history_'),
  ]);
  const daySplitPriority = key => (key.includes('__') ? 1 : 0);
  const mergedDaily = {};
  if (legacyDaily) Object.assign(mergedDaily, legacyDaily);
  [...dailyChunks].sort((a, b) => daySplitPriority(a.key) - daySplitPriority(b.key)).forEach(c => Object.assign(mergedDaily, c.payload));
  const mergedWeekly = {};
  if (legacyWeekly) Object.assign(mergedWeekly, legacyWeekly);
  weeklyChunks.forEach(c => Object.assign(mergedWeekly, c.payload));
  return { history: mergedDaily, weeklyHistory: mergedWeekly };
}

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = n => Number(n || 0).toLocaleString('en-US');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One entry per metric this email covers — add another here (matching a key
// historyTotalsToReportShape produces) to include it in a future round.
const METRICS = [
  { key: 'retail', label: 'Retail', fmt: r => fmt$(r.retail) },
  { key: 'colorSales', label: 'Color Sales', fmt: r => fmt$(r.colorSales) },
  { key: 'signatureS', label: 'Signature Service (SS)', fmt: r => `${fmtInt(r.signatureSCount)} (${fmt$(r.signatureS)})` },
];

function rankTable(rows, metric, title) {
  const body = rows.map((r, i) => `
    <tr>
      <td style="padding:4px 10px;color:#888;text-align:right;">${i + 1}</td>
      <td style="padding:4px 10px;">${escapeHtml(r.name)}</td>
      <td style="padding:4px 10px;text-align:right;font-weight:600;">${escapeHtml(metric.fmt(r))}</td>
    </tr>`).join('');
  return `
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;">
      <tr><td colspan="3" style="padding:4px 10px 8px;font-weight:700;font-size:14px;">${escapeHtml(title)}</td></tr>
      ${body || '<tr><td colspan="3" style="padding:4px 10px;color:#888;">No data.</td></tr>'}
    </table>`;
}

function buildEmail(storeRows, range) {
  const subject = `Weekly Leaderboard — Retail, Color, SS (${range.start} to ${range.end})`;
  const sections = METRICS.map(metric => {
    const top10 = sortByMetric(storeRows, metric.key, 'desc').slice(0, 10);
    const bottom10 = sortByMetric(storeRows, metric.key, 'asc').slice(0, 10);
    return `
      <tr>
        <td colspan="2" style="padding:16px 0 4px;border-top:2px solid #eee;font-family:Arial,sans-serif;font-size:16px;font-weight:700;">${escapeHtml(metric.label)}</td>
      </tr>
      <tr>
        <td valign="top" style="width:50%;padding-right:12px;">${rankTable(top10, metric, `Top 10 — ${metric.label}`)}</td>
        <td valign="top" style="width:50%;padding-left:12px;">${rankTable(bottom10, metric, `Bottom 10 — ${metric.label}`)}</td>
      </tr>`;
  }).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;">
      <p style="font-size:14px;color:#555;">Week of ${escapeHtml(range.start)} through ${escapeHtml(range.end)}, from Sales-Accrual/Attendance data.</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:700px;">${sections}</table>
    </div>`;
  return { subject, html };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expectedSecret = process.env.LEADERBOARD_EMAIL_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'LEADERBOARD_EMAIL_SECRET is not configured on this deployment.' });
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
    const { history, weeklyHistory } = await loadHistory();
    const range = getLastFullWeekRange();
    const totals = getRangeTotals(history, weeklyHistory, range.start, range.end);
    const storeRows = Object.entries(totals).map(([code, t]) => ({
      code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, ...historyTotalsToReportShape(t),
    }));
    const { subject, html } = buildEmail(storeRows, range);
    res.status(200).json({ ok: true, subject, html, storeCount: storeRows.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
