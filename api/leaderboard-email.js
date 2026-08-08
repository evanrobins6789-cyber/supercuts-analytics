// Vercel serverless function — Node.js runtime.
// Computes last week's company-wide Top 10 / Bottom 10 stores for Retail,
// Color Sales, and Signature Service, and hands back a ready-to-send HTML
// email body. Also includes a "what's new" recap — the latest News posts,
// and upcoming events off the Homepage calendar — reading the same
// `homepage_news`/`homepage_events` Supabase keys the Homepage tab already
// does, so nothing new needs to be maintained separately for the email to
// stay in sync with what's posted on the site. Called by a Google Apps
// Script on a Monday-morning time trigger (Setup > Email Reports has the
// walkthrough) — the script does the mechanical part (fetch +
// GmailApp.sendEmail), all the actual computation happens here so it can
// share ./metrics.js with the live app instead of a second copy of the
// weekly-vs-daily dedup rules.
//
// Auth is a single shared secret (LEADERBOARD_EMAIL_SECRET), same pattern as
// EMAIL_INGEST_SECRET in api/email-report.js — there's no user session to
// check since this is a machine-to-machine call from Apps Script, not a
// logged-in browser.
//
// HTML styling note: everything below is table-based layout with inline
// styles only (no <style> block, no flexbox/grid) — the lowest-common-
// denominator approach for HTML email, since GmailApp.sendEmail's rendering
// depends on whatever client eventually opens it (Gmail web/app, but also
// possibly Outlook for a store manager), and inline-styled tables are the
// one thing every one of them reliably supports. Colors mirror the live
// site's own palette (`:root` in src/App.css) so the email reads as the
// same product, not a generic auto-generated report.

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

// Mirrors :root in src/App.css so the email reads as the same brand as the
// live site instead of a generic auto-report.
const BRAND = {
  navy: '#142A4A', navy2: '#1F3A63', red: '#C23B3B', redDeep: '#9B2E2E',
  green: '#2E7D4F', gold: '#C9A227', silver: '#9AA7B4', bronze: '#B5722F',
  paper: '#F4F6F8', card: '#FFFFFF', inkSoft: '#5A6B80', line: '#E1E7ED',
};
const FONT = "Arial, Helvetica, sans-serif";
const NEWS_ACCENTS = [BRAND.navy2, BRAND.green, BRAND.gold, BRAND.red, BRAND.bronze];

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = n => Number(n || 0).toLocaleString('en-US');
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateShort(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return `${MONTH_NAMES[m - 1]} ${d}`;
}
function fmtDateLong(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

// A colored section title bar, reused above the News, Events, and each
// leaderboard metric's block so the email has a consistent rhythm instead
// of plain bolded text everywhere.
function sectionBand(label, bg) {
  return `
    <tr><td style="padding:22px 0 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="background:${bg};border-radius:6px;padding:9px 14px;font-family:${FONT};font-size:14px;font-weight:700;color:#fff;letter-spacing:0.3px;">${label}</td></tr>
      </table>
    </td></tr>`;
}

// News posts are tagged with a free-text Group when posted (Setup >
// Homepage News composer). Three groups the user actually uses get pulled
// to the top of the email, in this order, each with its own fixed accent
// color so e.g. "Specials Offer" always reads as the same color week to
// week — everything else still shows, just after these three, sorted by
// recency same as before. Exact strings per the user, 2026-08-08.
const PRIORITY_GROUPS = ['Stylist Info', 'Specials Offer', 'Around the Corner'];
const PRIORITY_GROUP_ACCENTS = { 'Stylist Info': BRAND.green, 'Specials Offer': BRAND.gold, 'Around the Corner': BRAND.navy2 };
const priorityRank = group => { const i = PRIORITY_GROUPS.indexOf(group); return i === -1 ? PRIORITY_GROUPS.length : i; };

// Latest News posts — priority groups first (see above), then everything
// else, most recent first within each. Always shows what's there (not
// gated to "posted this week") so the email never comes back with a bare
// section header on a quiet week; a gold "NEW" pill flags anything posted
// during the leaderboard's own week window (range.start..range.end).
const NEWS_LATEST_LIMIT = 6;
function newsSection(news, range) {
  const rows = [...(news || [])]
    .sort((a, b) => {
      const rankDiff = priorityRank(a.group) - priorityRank(b.group);
      if (rankDiff !== 0) return rankDiff;
      return (b.createdAt || b.date || '').localeCompare(a.createdAt || a.date || '');
    })
    .slice(0, NEWS_LATEST_LIMIT);
  if (!rows.length) return '';
  const cards = rows.map((n, i) => {
    const isNew = n.date >= range.start && n.date <= range.end;
    const accent = PRIORITY_GROUP_ACCENTS[n.group] || NEWS_ACCENTS[i % NEWS_ACCENTS.length];
    const badge = isNew ? `<span style="display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;background:${BRAND.gold};color:#fff;font-size:10px;font-weight:700;letter-spacing:0.4px;vertical-align:middle;">NEW</span>` : '';
    return `
      <tr><td style="padding:0 0 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border:1px solid ${BRAND.line};border-left:4px solid ${accent};border-radius:6px;">
          <tr>
            <td style="padding:12px 14px;font-family:${FONT};">
              <div style="font-size:13.5px;font-weight:700;color:${BRAND.navy};">${escapeHtml(n.title)}${badge}</div>
              <div style="font-size:11.5px;color:${BRAND.inkSoft};margin-top:2px;">${fmtDateLong(n.date)}${n.group ? ` &nbsp;·&nbsp; ${escapeHtml(n.group)}` : ''}</div>
              ${n.body ? `<div style="font-size:12.5px;color:#444;margin-top:6px;line-height:1.4;">${escapeHtml(n.body)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>`;
  }).join('');
  return `
    ${sectionBand('📣 Latest News &amp; Updates', BRAND.navy)}
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>`;
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
  const cards = rows.map(ev => {
    const [, m, d] = String(ev.date).slice(0, 10).split('-').map(Number);
    return `
      <tr><td style="padding:0 0 10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:6px;">
          <tr>
            <td width="56" style="padding:10px;vertical-align:top;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="48" style="background:${BRAND.navy2};border-radius:6px;">
                <tr><td style="text-align:center;padding:6px 0 2px;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.5px;color:#C7D3E3;text-transform:uppercase;">${MONTH_NAMES[m - 1]}</td></tr>
                <tr><td style="text-align:center;padding:0 0 6px;font-family:${FONT};font-size:18px;font-weight:700;color:#fff;">${d}</td></tr>
              </table>
            </td>
            <td style="padding:12px 14px 12px 4px;font-family:${FONT};">
              <div style="font-size:13.5px;font-weight:700;color:${BRAND.navy};">${escapeHtml(ev.title)}${ev.endDate ? `<span style="font-weight:400;color:${BRAND.inkSoft};"> — through ${fmtDateShort(ev.endDate)}</span>` : ''}</div>
              ${ev.description ? `<div style="font-size:12.5px;color:#444;margin-top:4px;line-height:1.4;">${escapeHtml(ev.description)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>`;
  }).join('');
  return `
    ${sectionBand('📅 Upcoming Events', BRAND.navy2)}
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>`;
}

// One entry per metric this email covers — add another here (matching a key
// historyTotalsToReportShape produces) to include it in a future round.
const METRICS = [
  { key: 'retail', label: 'Retail', icon: '🛍️', fmt: r => fmt$(r.retail) },
  { key: 'colorSales', label: 'Color Sales', icon: '🎨', fmt: r => fmt$(r.colorSales) },
  { key: 'signatureS', label: 'Signature Service (SS)', icon: '💇', fmt: r => `${fmtInt(r.signatureSCount)} (${fmt$(r.signatureS)})` },
];

// tone 'top'/'bottom' picks the header color and rank-badge palette — top 3
// get gold/silver/bronze medal-style badges (matches the site's own
// .leaderboard-rank medal coloring), bottom 10 gets a plain neutral badge
// since "you're #1 on the bottom list" isn't an achievement to decorate.
function rankBadge(i, tone) {
  const medal = tone === 'top' ? [BRAND.gold, BRAND.silver, BRAND.bronze][i] : null;
  const bg = medal || (tone === 'top' ? BRAND.navy2 : BRAND.inkSoft);
  return `<span style="display:inline-block;min-width:20px;height:20px;line-height:20px;border-radius:50%;background:${bg};color:#fff;font-family:${FONT};font-size:11px;font-weight:700;text-align:center;">${i + 1}</span>`;
}

function rankTable(rows, metric, title, tone) {
  const headerBg = tone === 'top' ? BRAND.navy2 : BRAND.redDeep;
  const valueColor = tone === 'top' ? BRAND.green : BRAND.red;
  const body = rows.map((r, i) => `
    <tr style="background:${i % 2 ? BRAND.paper : BRAND.card};">
      <td style="padding:6px 8px;text-align:center;">${rankBadge(i, tone)}</td>
      <td style="padding:6px 8px;font-family:${FONT};font-size:12.5px;color:${BRAND.navy};">${escapeHtml(r.name)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:${FONT};font-size:12.5px;font-weight:700;color:${valueColor};">${escapeHtml(metric.fmt(r))}</td>
    </tr>`).join('');
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid ${BRAND.line};border-radius:6px;overflow:hidden;">
      <tr><td colspan="3" style="background:${headerBg};padding:8px 10px;font-family:${FONT};font-size:12.5px;font-weight:700;color:#fff;">${escapeHtml(title)}</td></tr>
      ${body || `<tr><td colspan="3" style="padding:8px 10px;font-family:${FONT};font-size:12px;color:${BRAND.inkSoft};">No data.</td></tr>`}
    </table>`;
}

function buildEmail(storeRows, range, news, events, todayISO) {
  const subject = `Supercuts Weekly Recap — Retail, Color, SS (${range.start} to ${range.end})`;
  const leaderboardSections = METRICS.map(metric => {
    const top10 = sortByMetric(storeRows, metric.key, 'desc').slice(0, 10);
    const bottom10 = sortByMetric(storeRows, metric.key, 'asc').slice(0, 10);
    return `
      ${sectionBand(`${metric.icon} ${escapeHtml(metric.label)}`, BRAND.navy)}
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="top" width="50%" style="padding-right:8px;">${rankTable(top10, metric, `Top 10`, 'top')}</td>
              <td valign="top" width="50%" style="padding-left:8px;">${rankTable(bottom10, metric, `Bottom 10`, 'bottom')}</td>
            </tr>
          </table>
        </td>
      </tr>`;
  }).join('');
  const html = `
    <div style="background:${BRAND.paper};padding:24px 12px;font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:${BRAND.card};border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(20,42,74,0.08);">
        <tr>
          <td style="background:${BRAND.navy};padding:26px 28px;text-align:center;">
            <div style="font-family:${FONT};font-size:11px;letter-spacing:2px;color:#9FB3CE;text-transform:uppercase;">Supercuts Analytics</div>
            <div style="font-family:${FONT};font-size:23px;font-weight:700;color:#fff;margin-top:4px;">Weekly Recap</div>
            <div style="font-family:${FONT};font-size:13px;color:#C7D3E3;margin-top:6px;">Week of ${fmtDateLong(range.start)} through ${fmtDateLong(range.end)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${newsSection(news, range)}
              ${eventsSection(events, todayISO)}
              ${leaderboardSections}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px 22px;border-top:1px solid ${BRAND.line};text-align:center;">
            <div style="font-family:${FONT};font-size:11px;color:${BRAND.inkSoft};">Sent automatically every Monday from Sales-Accrual/Attendance data · Supercuts Analytics</div>
          </td>
        </tr>
      </table>
    </div>`;
  return { subject, html };
}

// Named export alongside the default handler purely so this can be driven
// with synthetic data from a standalone script for visual verification —
// there's no way to render a real send in this sandboxed environment (no
// local Supabase credentials), so this is the seam that makes "does the
// email actually look right" checkable at all without a live send.
export { buildEmail };

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
