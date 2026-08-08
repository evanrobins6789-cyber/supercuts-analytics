// Vercel serverless function — Node.js runtime.
// Computes last week's company-wide Top 10 / Bottom 10 stores for Retail,
// Color Sales, and Signature Service, and hands back a ready-to-send HTML
// email body. Also includes a "what's new" recap — News posts made during
// that same week, and upcoming events off the Homepage calendar — reading
// the same `homepage_news`/`homepage_events` Supabase keys the Homepage tab
// already does, so nothing new needs to be maintained separately for the
// email to stay in sync with what's posted on the site. Called by a Google
// Apps Script on a Monday-morning time trigger (Setup > Email Reports has
// the walkthrough) — the script does the mechanical part (fetch +
// GmailApp.sendEmail), all the actual computation happens here so it can
// share ./metrics.js with the live app instead of a second copy of the
// weekly-vs-daily dedup rules.
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
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateShort(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

// News items posted since the last leaderboard email went out (same
// week window as the leaderboard itself, `range.start`..`range.end`) — a
// "here's what was posted this week" recap, not every post ever made.
function newsSection(news, range) {
  const rows = (news || [])
    .filter(n => n.date >= range.start && n.date <= range.end)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (!rows.length) return '';
  const items = rows.map(n => `
    <tr>
      <td style="padding:6px 10px;vertical-align:top;color:#888;white-space:nowrap;">${fmtDateShort(n.date)}</td>
      <td style="padding:6px 10px;">
        <div style="font-weight:600;">${escapeHtml(n.title)}${n.group ? ` <span style="font-weight:400;color:#888;">— ${escapeHtml(n.group)}</span>` : ''}</div>
        ${n.body ? `<div style="color:#555;">${escapeHtml(n.body)}</div>` : ''}
      </td>
    </tr>`).join('');
  return `
    <tr><td colspan="2" style="padding:20px 0 4px;border-top:2px solid #eee;font-family:Arial,sans-serif;font-size:16px;font-weight:700;">📣 New This Week</td></tr>
    <tr><td colspan="2"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">${items}</table></td></tr>`;
}

// Upcoming events on the calendar, regardless of when they were added — a
// reminder as an event approaches, same "is it still ahead of today" filter
// FeaturedEvents (src/App.js) uses for the Homepage strip. Capped so a
// calendar with a lot of future events doesn't blow the email up.
const UPCOMING_EVENTS_LIMIT = 8;
function eventsSection(events, todayISO) {
  const rows = (events || [])
    .filter(ev => (ev.endDate || ev.date) >= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, UPCOMING_EVENTS_LIMIT);
  if (!rows.length) return '';
  const items = rows.map(ev => `
    <tr>
      <td style="padding:6px 10px;vertical-align:top;color:#888;white-space:nowrap;">${fmtDateShort(ev.date)}${ev.endDate ? `–${fmtDateShort(ev.endDate)}` : ''}</td>
      <td style="padding:6px 10px;">
        <div style="font-weight:600;">${escapeHtml(ev.title)}</div>
        ${ev.description ? `<div style="color:#555;">${escapeHtml(ev.description)}</div>` : ''}
      </td>
    </tr>`).join('');
  return `
    <tr><td colspan="2" style="padding:20px 0 4px;border-top:2px solid #eee;font-family:Arial,sans-serif;font-size:16px;font-weight:700;">📅 Upcoming Events</td></tr>
    <tr><td colspan="2"><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">${items}</table></td></tr>`;
}

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

function buildEmail(storeRows, range, news, events, todayISO) {
  const subject = `Weekly Leaderboard — Retail, Color, SS (${range.start} to ${range.end})`;
  const leaderboardSections = METRICS.map(metric => {
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
      <table cellpadding="0" cellspacing="0" style="width:100%;max-width:700px;">
        ${newsSection(news, range)}
        ${eventsSection(events, todayISO)}
        ${leaderboardSections}
      </table>
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
    const [{ history, weeklyHistory }, news, events] = await Promise.all([
      loadHistory(), loadRow('homepage_news'), loadRow('homepage_events'),
    ]);
    const range = getLastFullWeekRange();
    const todayISO = new Date().toISOString().slice(0, 10);
    const totals = getRangeTotals(history, weeklyHistory, range.start, range.end);
    const storeRows = Object.entries(totals).map(([code, t]) => ({
      code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, ...historyTotalsToReportShape(t),
    }));
    const { subject, html } = buildEmail(storeRows, range, news, events, todayISO);
    res.status(200).json({ ok: true, subject, html, storeCount: storeRows.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
