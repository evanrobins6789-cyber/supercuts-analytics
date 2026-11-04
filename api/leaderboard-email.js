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
import { LEADER_ROSTER_SECTIONS } from '../src/leaderRoster.js';
import { getRangeTotals, historyTotalsToReportShape, getLastFullWeekRange, sortByMetric, shiftYearISO, addDaysISO } from '../src/metrics.js';
import { buildGoalProgressEmails } from './_goal-progress-email.js';

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

// Only the months the email's date ranges touch (plus the month before each
// range start, since a weekly chunk is keyed by its week's start date).
// Loading every month in one query hit Supabase's statement timeout once
// 2025 history was imported (2026-11-02).
function monthsFor(ranges) {
  const months = new Set();
  ranges.forEach(({ start, end }) => {
    for (let d = addDaysISO(start, -7); d <= end; d = addDaysISO(d, 1)) months.add(d.slice(0, 7));
  });
  return [...months];
}

async function loadHistory(ranges) {
  const months = monthsFor(ranges);
  const chunksFor = async prefix => (await Promise.all(months.map(m => loadChunked(`${prefix}${m}`)))).flat();
  const [legacyDaily, legacyWeekly, dailyChunks, weeklyChunks] = await Promise.all([
    loadRow('daily_history'), loadRow('weekly_history'),
    chunksFor('daily_history_'), chunksFor('weekly_history_'),
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

// Emoji as numeric HTML character references, not raw Unicode literals.
// The literal characters showed up as "??????" in a real send — GmailApp's
// UrlFetchApp round-trip (or something downstream of it) was mangling the
// 4-byte "astral plane" emoji (anything above U+FFFF, which is all of these)
// while plain 2-byte characters elsewhere in the email (e.g. the "·"
// separator) survived fine. Numeric entities are pure ASCII in the HTTP
// response, so there's no multi-byte encoding left to get lost in transit —
// the email client's own HTML parser resolves them to the glyph.
const EMOJI = {
  megaphone: '&#x1F4E3;', calendar: '&#x1F4C5;', bags: '&#x1F6CD;&#xFE0F;',
  palette: '&#x1F3A8;', haircut: '&#x1F487;', chart: '&#x1F4C8;',
};

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
              ${n.group ? `<div style="font-size:11.5px;color:${BRAND.inkSoft};margin-top:2px;">${escapeHtml(n.group)}</div>` : ''}
              ${n.body ? `<div style="font-size:12.5px;color:#444;margin-top:6px;line-height:1.4;">${escapeHtml(n.body)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>`;
  }).join('');
  return `
    ${sectionBand(`${EMOJI.megaphone} Latest News &amp; Updates`, BRAND.navy)}
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
    ${sectionBand(`${EMOJI.calendar} Upcoming Events`, BRAND.navy2)}
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table></td></tr>`;
}

// Last week vs the same dates last year (shiftYearISO, same as the Overview
// tiles' YOY line). Like-for-like stores only: a store with no data in one
// of the two weeks is left out of both sides, so a new or not-yet-imported
// store can't inflate a total. Up is green, down is red. `buildYoy` returns
// null when no store has data in both years, and the section is left out.
//
// The section comes in three versions; the Apps Script in Setup > Email
// Reports picks one per recipient:
//   - company totals only (`html`, the default),
//   - company totals plus every DL/AS's store list (`allHtml`, the owner),
//   - one leader's own stores only (`byLeader[name]`, LEADER_ROSTER_SECTIONS).
const YOY_METRICS = [
  { key: 'haircuts', label: 'Cuts', fmt: fmtInt },
  { key: 'sales', label: 'Sales', fmt: fmt$ },
];
const metricOf = (t, key) => (t ? historyTotalsToReportShape(t)[key] || 0 : 0);
function buildYoy(totals, lyTotals, onlyCodes = null) {
  const codes = (onlyCodes || Object.keys(totals)).filter(c => totals[c] && lyTotals[c]);
  if (!codes.length) return null;
  const sum = (src, key) => codes.reduce((acc, c) => acc + metricOf(src[c], key), 0);
  const metrics = {};
  YOY_METRICS.forEach(m => { metrics[m.key] = { cur: sum(totals, m.key), ly: sum(lyTotals, m.key) }; });
  return { metrics, storeCount: codes.length };
}
// The change, as a colored box: arrow + % on top, the raw difference under
// it. Light green/red fill so up vs down reads at a glance.
const CHANGE_FILL = { up: '#E6F2EA', down: '#F8E5E5', flat: BRAND.paper };
function yoyChange(metric, cur, ly) {
  const diff = cur - ly;
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const color = dir === 'up' ? BRAND.green : dir === 'down' ? BRAND.red : BRAND.inkSoft;
  const arrow = dir === 'up' ? '&#9650;' : dir === 'down' ? '&#9660;' : '';
  const sign = dir === 'up' ? '+' : dir === 'down' ? '&#8722;' : '';
  const pct = ly ? `${sign}${Math.abs((diff / ly) * 100).toFixed(1)}%` : '';
  return { color, fill: CHANGE_FILL[dir], pct: `${arrow} ${pct}`, diff: `${sign}${metric.fmt(Math.abs(diff))}` };
}
function changeBox(ch, size = 12) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${ch.fill};border-radius:5px;"><tr><td style="padding:5px 6px;text-align:center;font-family:${FONT};color:${ch.color};font-weight:700;"><div style="font-size:${size + 1}px;white-space:nowrap;">${ch.pct}</div><div style="font-size:${size - 1}px;white-space:nowrap;">${ch.diff}</div></td></tr></table>`;
}

// One tile per metric: this year and last year side by side, each labeled
// with its year and dates, and the change box underneath.
function yoyTile(metric, { cur, ly }, labels) {
  const ch = yoyChange(metric, cur, ly);
  const col = (label, dates, value, color) => `
    <td width="50%" style="padding:6px 4px;text-align:center;font-family:${FONT};vertical-align:top;">
      <div style="font-size:12px;font-weight:700;color:${color};">${label}</div>
      <div style="font-size:10.5px;color:${BRAND.inkSoft};">${dates}</div>
      <div style="font-size:21px;font-weight:700;color:${color};margin-top:4px;">${value}</div>
    </td>`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border:1px solid ${BRAND.line};border-top:4px solid ${ch.color};border-radius:6px;">
      <tr><td colspan="2" style="padding:10px 12px 2px;font-family:${FONT};text-align:center;font-size:12px;font-weight:700;letter-spacing:0.8px;color:${BRAND.navy};text-transform:uppercase;">${metric.label}</td></tr>
      <tr>
        ${col(labels.cur, labels.curDates, metric.fmt(cur), BRAND.navy)}
        ${col(labels.ly, labels.lyDates, metric.fmt(ly), BRAND.inkSoft)}
      </tr>
      <tr><td colspan="2" style="padding:4px 12px 12px;">${changeBox(ch, 14)}</td></tr>
    </table>`;
}
function yoyTiles(yoy, labels) {
  const tiles = YOY_METRICS.map((m, i) => `<td valign="top" width="50%" style="${i ? 'padding-left:8px;' : 'padding-right:8px;'}">${yoyTile(m, yoy.metrics[m.key], labels)}</td>`).join('');
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>`;
}
function yoyNote(text) {
  return `<tr><td style="padding:8px 2px 0;font-family:${FONT};font-size:11.5px;color:${BRAND.inkSoft};text-align:center;">${text}</td></tr>`;
}

// Per-store table: for each metric, a this-year column, a last-year column
// and a change column, under a header that spans all three. A store missing
// either week gets a gray "No data" instead of a change, and is left out of
// its group's Total row.
function storeYoyCells(metric, cur, ly, td, bold = false) {
  const weight = bold ? 'font-weight:700;' : '';
  const curCell = `<td align="right" style="${td}${weight}color:${BRAND.navy};">${cur == null ? '&mdash;' : metric.fmt(cur)}</td>`;
  const lyCell = `<td align="right" style="${td}${weight}color:${BRAND.inkSoft};">${ly == null ? '&mdash;' : metric.fmt(ly)}</td>`;
  const changeCell = cur == null || ly == null
    ? `<td align="center" style="${td}font-size:10.5px;color:${BRAND.inkSoft};">No data ${cur == null ? 'this' : 'last'} year</td>`
    : storeChangeCell(yoyChange(metric, cur, ly), td);
  return curCell + lyCell + changeCell;
}
// Same look as changeBox, but the fill sits on the cell itself instead of a
// nested table: the owner copy repeats this ~120 times, and the nested
// version pushed it past GmailApp's ~200KB body limit.
function storeChangeCell(ch, td) {
  return `<td align="center" style="${td}background:${ch.fill};color:${ch.color};font-weight:700;white-space:nowrap;border:2px solid ${BRAND.card};">${ch.pct}<br><span style="font-size:10px;">${ch.diff}</span></td>`;
}
// Font family/size are set once on the table and inherited by its cells,
// rather than repeated on every <td>, to keep the owner copy (16 tables)
// well under GmailApp's body limit.
function storeYoyTable(title, codes, totals, lyTotals, labels) {
  const td = 'padding:6px 5px;';
  const th = `padding:6px 5px;font-family:${FONT};font-size:11px;font-weight:700;color:#fff;`;
  const storeName = code => STORE_CODE_TO_NAME[code] || `Store ${code}`;
  const val = (t, key) => (t ? metricOf(t, key) : null);
  const rows = [...codes].sort((a, b) => storeName(a).localeCompare(storeName(b))).map((code, i) => `
    <tr style="background:${i % 2 ? BRAND.paper : BRAND.card};">
      <td style="${td}color:${BRAND.navy};">${escapeHtml(storeName(code))}</td>
      ${YOY_METRICS.map(m => storeYoyCells(m, val(totals[code], m.key), val(lyTotals[code], m.key), td)).join('')}
    </tr>`).join('');
  const yoy = buildYoy(totals, lyTotals, codes);
  const totalRow = yoy ? `
    <tr style="background:${BRAND.line};">
      <td style="${td}font-weight:700;color:${BRAND.navy};">Total${yoy.storeCount < codes.length ? `<div style="font-size:10px;font-weight:400;color:${BRAND.inkSoft};">${yoy.storeCount} of ${codes.length} stores</div>` : ''}</td>
      ${YOY_METRICS.map(m => storeYoyCells(m, yoy.metrics[m.key].cur, yoy.metrics[m.key].ly, td, true)).join('')}
    </tr>` : '';
  const divider = `border-left:2px solid ${BRAND.card};`;
  return `
    <tr><td style="padding:12px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid ${BRAND.line};font-family:${FONT};font-size:12px;">
        <tr style="background:${BRAND.navy};">
          <td rowspan="2" style="${th}font-size:12px;vertical-align:bottom;">${escapeHtml(title)}</td>
          ${YOY_METRICS.map(m => `<td colspan="3" style="${th}${divider}text-align:center;font-size:12px;letter-spacing:0.6px;text-transform:uppercase;">${m.label}</td>`).join('')}
        </tr>
        <tr style="background:${BRAND.navy2};">
          ${YOY_METRICS.map(() => `<td style="${th}${divider}text-align:right;">${labels.cur}</td><td style="${th}text-align:right;color:#C7D3E3;">${labels.ly}</td><td width="78" style="${th}text-align:center;">Change</td>`).join('')}
        </tr>
        ${rows}${totalRow}
      </table>
    </td></tr>`;
}

// leaders: [{ name, storeCodes }], each listed store by store under its own
// header. showCompany puts the company-wide tiles on top (default and owner
// versions); without it, one leader's own group totals go there instead.
function yoySection({ totals, lyTotals, range, lyRange, leaders = [], showCompany = true }) {
  const companyYoy = buildYoy(totals, lyTotals);
  if (!companyYoy) return '';
  const span = r => `${fmtDateShort(r.start)} &ndash; ${fmtDateShort(r.end)}`;
  const labels = { cur: range.end.slice(0, 4), ly: lyRange.end.slice(0, 4), curDates: span(range), lyDates: span(lyRange) };
  const parts = [sectionBand(`${EMOJI.chart} This Year vs Last Year &middot; ${span(range)}`, BRAND.navy)];
  if (showCompany) {
    parts.push(yoyTiles(companyYoy, labels));
    parts.push(yoyNote(`All stores. Counts only the ${companyYoy.storeCount} store${companyYoy.storeCount === 1 ? '' : 's'} with data in both years.`));
  } else {
    const own = buildYoy(totals, lyTotals, leaders.flatMap(l => l.storeCodes));
    if (own) parts.push(yoyTiles(own, labels));
    parts.push(yoyNote(`Your stores combined. Totals count only stores with data in both years.`));
  }
  leaders.forEach(l => parts.push(storeYoyTable(showCompany ? l.name : 'Your Stores', l.storeCodes, totals, lyTotals, labels)));
  return parts.join('');
}

// One entry per metric this email covers — add another here (matching a key
// historyTotalsToReportShape produces) to include it in a future round.
const METRICS = [
  { key: 'retail', label: 'Retail', icon: EMOJI.bags, fmt: r => fmt$(r.retail) },
  { key: 'colorSales', label: 'Color Sales', icon: EMOJI.palette, fmt: r => fmt$(r.colorSales) },
  { key: 'signatureS', label: 'Signature Service (SS)', icon: EMOJI.haircut, fmt: r => `${fmtInt(r.signatureSCount)} (${fmt$(r.signatureS)})` },
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

function buildEmail(storeRows, range, news, events, todayISO, siteUrl, yoyHtml = '') {
  const subject = `Supercuts Weekly Recap — Retail, Color, SS (${range.start} to ${range.end})`;
  const visitButton = siteUrl ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto 0;">
      <tr><td style="border-radius:6px;background:${BRAND.card};">
        <a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:10px 26px;font-family:${FONT};font-size:13px;font-weight:700;color:${BRAND.navy};text-decoration:none;border-radius:6px;">Visit Site &#8594;</a>
      </td></tr>
    </table>` : '';
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
            ${visitButton}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${yoyHtml}
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
  // Drop the template indentation between tags: it's pure bytes, and
  // GmailApp.sendEmail rejects bodies over ~200KB.
  return { subject, html: html.replace(/>\s*\n\s*</g, '><') };
}

// Named export alongside the default handler purely so this can be driven
// with synthetic data from a standalone script for visual verification —
// there's no way to render a real send in this sandboxed environment (no
// local Supabase credentials), so this is the seam that makes "does the
// email actually look right" checkable at all without a live send.
export { buildEmail, buildYoy, yoySection };
// Shared with api/_finalize-goals.js (the DL monthly goals email) so it
// loads history the same way and looks like this email.
export { loadHistory, loadRow, BRAND, FONT, escapeHtml, fmt$, fmtInt, sectionBand };
// Shared with api/_goal-progress-email.js, the separate Monday Goal Progress email.
export { loadChunked, yoyChange, storeChangeCell };

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
    // Same host logic as below: this endpoint is only reached on the live site.
    if (req.body?.report === 'goal-progress') {
      const scheme = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const emails = await buildGoalProgressEmails(req.headers.host ? `${scheme}://${req.headers.host}` : null);
      res.status(200).json({ ok: true, ...emails });
      return;
    }
    const range = getLastFullWeekRange();
    const lyRange = { start: shiftYearISO(range.start, -1), end: shiftYearISO(range.end, -1) };
    const [{ history, weeklyHistory }, news, events] = await Promise.all([
      loadHistory([range, lyRange]), loadRow('homepage_news'), loadRow('homepage_events'),
    ]);
    const todayISO = new Date().toISOString().slice(0, 10);
    const totals = getRangeTotals(history, weeklyHistory, range.start, range.end);
    const storeRows = Object.entries(totals).map(([code, t]) => ({
      code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, ...historyTotalsToReportShape(t),
    }));
    // Built from the request's own host rather than a hardcoded/env URL —
    // this endpoint is only ever reached by hitting the live deployment, so
    // req.headers.host is always the real, current domain (custom domain or
    // *.vercel.app, whichever the site is actually running on).
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const siteUrl = req.headers.host ? `${proto}://${req.headers.host}` : null;
    const yoyBase = { totals, lyTotals: getRangeTotals(history, weeklyHistory, lyRange.start, lyRange.end), range, lyRange };
    const leaders = LEADER_ROSTER_SECTIONS.flatMap(sec => sec.leaders);
    // Stores no DL/AS covers still get listed in the owner's copy.
    const assigned = new Set(leaders.flatMap(l => l.storeCodes));
    const unassigned = Object.keys(totals).filter(c => !assigned.has(c));
    const allGroups = unassigned.length ? [...leaders, { name: 'Other Stores', storeCodes: unassigned }] : leaders;
    const render = yoyHtml => buildEmail(storeRows, range, news, events, todayISO, siteUrl, yoyHtml).html;
    const { subject, html } = buildEmail(storeRows, range, news, events, todayISO, siteUrl, yoySection(yoyBase));
    const allHtml = render(yoySection({ ...yoyBase, leaders: allGroups }));
    const byLeader = Object.fromEntries(leaders.map(l => [l.name, render(yoySection({ ...yoyBase, leaders: [l], showCompany: false }))]));
    res.status(200).json({ ok: true, subject, html, allHtml, byLeader, storeCount: storeRows.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
