// Server-side builder (not its own Vercel function: the Hobby plan caps a
// deployment at 12; reached as POST /api/leaderboard-email { report: 'goal-progress' }).
//
// The Monday "Goal Progress" email, a separate email sent by the same Apps
// Script run as the Weekly Recap. Month to date through last Sunday, or the
// last day with sales uploaded if that's earlier:
//   - each DL/AS gets their own group (`byLeader[name]`),
//   - leadership gets the company totals, then every group (`allHtml`).
// Each row shows progress toward the group's Monthly Goals (Goals tab) and the
// same dates a year earlier. The two sides count different stores: goal
// progress counts stores with a goal, and the year comparison counts stores
// with data in both years, same as the Weekly Recap and Overview.
//
// Table-based inline-styled HTML, like api/leaderboard-email.js. Nothing runs
// at import time, because that file imports this one back.

import { LEADER_ROSTER_SECTIONS } from '../src/leaderRoster.js';
import { getRangeTotals, historyTotalsToReportShape, getLastFullWeekRange, shiftYearISO } from '../src/metrics.js';
import { collectiveGoal, goalHeat, goalPace } from '../src/goalProgress.js';
import { loadHistory, loadChunked, loadRow, BRAND, FONT, escapeHtml, fmt$, fmtInt, sectionBand, yoyChange, storeChangeCell } from './leaderboard-email.js';

const goalRows = () => [
  { label: 'Sales', field: 'salesGoal', key: 'sales', fmt: fmt$ },
  { label: 'Retail', field: 'retailGoal', key: 'retail', fmt: fmt$ },
  { label: 'Bottles', field: 'bottleGoal', key: 'bottles', fmt: fmtInt },
  { label: 'Color', field: 'colorGoal', key: 'colorSales', fmt: fmt$ },
  { label: 'Signature Services', field: 'signatureSGoal', key: 'signatureSCount', fmt: fmtInt },
  { label: 'Gift Cards', field: 'giftCardGoal', gift: true, fmt: fmt$ },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayLabel = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}`;
const heatColor = status => ({ hit: BRAND.green, onpace: BRAND.gold, behind: BRAND.red }[status]);

// Latest day inside [start, end] with sales uploaded, so the pace and last
// year's dates match what's really in the numbers.
export function lastDataDay(history, start, end) {
  let last = null;
  Object.values(history || {}).forEach(r => {
    if (r?.date && r.date >= start && r.date <= end && (!last || r.date > last)) last = r.date;
  });
  return last;
}

function giftByStore(records, start, end) {
  const out = {};
  Object.values(records || {}).forEach(r => {
    if (!r?.date || r.date < start || r.date > end) return;
    out[r.code] = (out[r.code] || 0) + (r.giftCards || 0);
  });
  return out;
}

// One metric for one group of stores.
export function groupRow(row, codes, data) {
  const { goals, month, shapes, lyShapes, gift, lyGift } = data;
  const goalOf = c => Number(goals?.[c]?.[`${row.field}:${month}`]);
  const actualOf = c => (row.gift ? gift[c] : shapes[c]?.[row.key]);
  const progress = collectiveGoal(codes, goalOf, actualOf);
  let cur = null;
  let ly = null;
  if (row.gift) {
    // Gift card history starts Aug 2026. A store with no sale has no record
    // that day, so the only "no data" case is the whole year being missing.
    if (Object.keys(lyGift).length) {
      cur = codes.reduce((s, c) => s + (gift[c] || 0), 0);
      ly = codes.reduce((s, c) => s + (lyGift[c] || 0), 0);
    }
  } else {
    const both = codes.filter(c => shapes[c] && lyShapes[c]);
    const lySum = both.reduce((s, c) => s + (lyShapes[c][row.key] || 0), 0);
    // A zero year means that field wasn't in that year's uploads.
    if (both.length && lySum > 0) {
      cur = both.reduce((s, c) => s + (shapes[c][row.key] || 0), 0);
      ly = lySum;
    }
  }
  return { ...row, progress, cur, ly, storeCount: codes.length };
}

function goalCell(r, pace, td) {
  const { goal, actual, stores } = r.progress;
  if (!(goal > 0)) return `<td style="${td}color:${BRAND.inkSoft};font-size:11px;">No goal set</td>`;
  const pct = (actual / goal) * 100;
  const heat = goalHeat(actual, goal, pace);
  const color = heatColor(heat.status);
  const fill = Math.max(1, Math.min(100, Math.round(pct)));
  const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:3px 0;"><tr><td width="${fill}%" height="8" bgcolor="${color}" style="background:${color};font-size:0;line-height:0;">&nbsp;</td>${fill < 100 ? `<td height="8" bgcolor="${BRAND.line}" style="background:${BRAND.line};font-size:0;line-height:0;">&nbsp;</td>` : ''}</tr></table>`;
  const partial = stores < r.storeCount ? ` &middot; ${stores} of ${r.storeCount} stores` : '';
  return `<td style="${td}"><span style="font-weight:700;color:${BRAND.navy};">${Math.round(pct)}%</span>${heat.text ? ` <span style="font-size:10.5px;font-weight:700;color:${heat.status === 'onpace' ? '#8A6D12' : color};">${heat.text}</span>` : ''}${bar}<span style="font-size:10.5px;color:${BRAND.inkSoft};">${r.fmt(actual)} of ${r.fmt(goal)}${partial}</span></td>`;
}

function groupTable(title, codes, data) {
  const td = 'padding:7px 5px;';
  const th = `padding:6px 5px;font-size:11px;font-weight:700;color:#fff;`;
  const rows = goalRows().map(row => groupRow(row, codes, data)).filter(r => r.progress.goal > 0 || r.cur != null);
  if (!rows.length) return '';
  const body = rows.map((r, i) => {
    const num = (v, color) => `<td align="right" style="${td}color:${color};">${v == null ? '&mdash;' : r.fmt(v)}</td>`;
    const change = r.cur == null
      ? `<td align="center" style="${td}font-size:10.5px;color:${BRAND.inkSoft};">No ${data.lyYear} data</td>`
      : storeChangeCell(yoyChange({ fmt: r.fmt }, r.cur, r.ly), td);
    return `<tr style="background:${i % 2 ? BRAND.paper : BRAND.card};"><td style="${td}font-weight:700;color:${BRAND.navy};">${r.label}</td>${goalCell(r, data.pace, td)}${num(r.cur, BRAND.navy)}${num(r.ly, BRAND.inkSoft)}${change}</tr>`;
  }).join('');
  return `
    <tr><td style="padding:12px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid ${BRAND.line};font-family:${FONT};font-size:12px;">
        <tr style="background:${BRAND.navy};"><td colspan="5" style="${th}font-size:13px;">${escapeHtml(title)} <span style="font-weight:400;color:#C7D3E3;">&middot; ${codes.length} store${codes.length === 1 ? '' : 's'}</span></td></tr>
        <tr style="background:${BRAND.navy2};">
          <td style="${th}">Metric</td>
          <td style="${th}">${data.monthName} Goal</td>
          <td style="${th}text-align:right;">${data.curYear}</td>
          <td style="${th}text-align:right;color:#C7D3E3;">${data.lyYear}</td>
          <td width="74" style="${th}text-align:center;">vs ${data.lyYear}</td>
        </tr>
        ${body}
      </table>
    </td></tr>`;
}

function shell({ data, intro, sections, siteUrl }) {
  const button = siteUrl ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto 0;">
      <tr><td style="border-radius:6px;background:${BRAND.card};"><a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:10px 26px;font-family:${FONT};font-size:13px;font-weight:700;color:${BRAND.navy};text-decoration:none;border-radius:6px;">Visit Site &#8594;</a></td></tr>
    </table>` : '';
  const paceLine = data.pace == null ? '' : `The month is ${Math.round(data.pace * 100)}% finished. Green is at or ahead of that pace, gold is within 10% of it, and red is further behind. `;
  const html = `
    <div style="background:${BRAND.paper};padding:24px 12px;font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:${BRAND.card};border-radius:10px;overflow:hidden;">
        <tr><td style="background:${BRAND.navy};padding:26px 28px;text-align:center;">
          <div style="font-family:${FONT};font-size:11px;letter-spacing:2px;color:#9FB3CE;text-transform:uppercase;">Supercuts Analytics</div>
          <div style="font-family:${FONT};font-size:23px;font-weight:700;color:#fff;margin-top:4px;">${data.monthName} Goal Progress</div>
          <div style="font-family:${FONT};font-size:13px;color:#C7D3E3;margin-top:6px;">${dayLabel(data.start)} &ndash; ${dayLabel(data.end)}, ${data.curYear}, compared with the same dates in ${data.lyYear}</div>
          ${button}
        </td></tr>
        <tr><td style="padding:16px 24px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:0 2px 2px;font-family:${FONT};font-size:12.5px;color:${BRAND.inkSoft};">${intro}</td></tr>
            ${sections}
            <tr><td style="padding:12px 2px 0;font-family:${FONT};font-size:11.5px;line-height:1.5;color:${BRAND.inkSoft};">${paceLine}Goal progress counts stores with a goal this month. The ${data.curYear} and ${data.lyYear} columns count stores with data in both years, so ${data.curYear} can differ from the goal figure.</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 24px 22px;border-top:1px solid ${BRAND.line};text-align:center;"><div style="font-family:${FONT};font-size:11px;color:${BRAND.inkSoft};">Sent automatically every Monday &middot; Supercuts Analytics</div></td></tr>
      </table>
    </div>`;
  return html.replace(/>\s*\n\s*</g, '><');
}

export async function buildGoalProgressEmails(siteUrl) {
  const weekEnd = getLastFullWeekRange().end;
  const month = weekEnd.slice(0, 7);
  const start = `${month}-01`;
  const lyStartAll = shiftYearISO(start, -1);
  const [{ history, weeklyHistory }, goals, giftRows, lyGiftRows] = await Promise.all([
    loadHistory([{ start, end: weekEnd }, { start: lyStartAll, end: shiftYearISO(weekEnd, -1) }]),
    loadRow('store_goals'),
    loadChunked(`gift_card_history_${month}`),
    loadChunked(`gift_card_history_${lyStartAll.slice(0, 7)}`),
  ]);
  const end = lastDataDay(history, start, weekEnd) || weekEnd;
  const lyEnd = shiftYearISO(end, -1);
  const shapesFor = (s, e) => Object.fromEntries(Object.entries(getRangeTotals(history, weeklyHistory, s, e)).map(([c, t]) => [c, historyTotalsToReportShape(t)]));
  const merged = rows => Object.assign({}, ...rows.map(r => r.payload));
  const data = {
    goals, month, start, end,
    monthName: MONTHS[Number(month.slice(5, 7)) - 1],
    curYear: start.slice(0, 4), lyYear: lyStartAll.slice(0, 4),
    pace: goalPace(start, end),
    shapes: shapesFor(start, end), lyShapes: shapesFor(lyStartAll, lyEnd),
    gift: giftByStore(merged(giftRows), start, end), lyGift: giftByStore(merged(lyGiftRows), lyStartAll, lyEnd),
  };

  const leaders = LEADER_ROSTER_SECTIONS.flatMap(sec => sec.leaders);
  const assigned = new Set(leaders.flatMap(l => l.storeCodes));
  const everyCode = [...new Set([...Object.keys(goals || {}), ...Object.keys(data.shapes)])];
  const unassigned = everyCode.filter(c => !assigned.has(c));
  const groups = unassigned.length ? [...leaders, { name: 'Other Stores', storeCodes: unassigned }] : leaders;

  const allHtml = shell({
    data, siteUrl,
    intro: 'Company totals first, then each DL group.',
    sections: `${sectionBand('Company Totals', BRAND.navy)}${groupTable('All Stores', everyCode, data)}${sectionBand('DL Groups', BRAND.navy)}${groups.map(g => groupTable(g.name, g.storeCodes, data)).join('')}`,
  });
  const byLeader = Object.fromEntries(leaders.map(l => [l.name, shell({
    data, siteUrl,
    intro: `Your stores combined, ${escapeHtml(l.name)}.`,
    sections: groupTable('Your Stores', l.storeCodes, data),
  })]));
  const subject = `Supercuts ${data.monthName} Goal Progress (through ${dayLabel(end)})`;
  return { subject, allHtml, byLeader, end };
}
