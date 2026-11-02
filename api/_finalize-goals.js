// Server-side handler (not its own Vercel function — see handleFinalizeGoals).
// Leadership's "Finalize & email DLs" button on the Goals tab (Monthly
// Goals). Builds one email per District Leader / Area Supervisor listing
// their stores' Sales goal for the month (with the per-day and per-week
// breakdown), the same month last year and last month for comparison, and
// a reminder of which of their other monthly goals (Retail, Color,
// Bottles, Signature Service) are still blank.
//
// It doesn't send mail itself. The site has no email service; the emails
// go out through the same Google Apps Script as the Monday recap,
// deployed as a web app (GOALS_EMAIL_WEBAPP_URL), which looks up each
// leader's address in its own RECIPIENTS list. Shared secret is the same
// LEADERBOARD_EMAIL_SECRET that script already uses. Owner sessions only.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { LEADER_ROSTER_SECTIONS } from '../src/leaderRoster.js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';
import { shiftMonthKey, monthKeyRange, monthlyReference, salesGoalBreakdown } from '../src/metrics.js';
import { loadHistory, BRAND, FONT, escapeHtml, fmt$, sectionBand } from './leaderboard-email.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = mk => { const [y, m] = mk.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };
const OTHER_GOALS = [
  { key: 'retailGoal', label: 'Retail $' },
  { key: 'colorGoal', label: 'Color $' },
  { key: 'bottleGoal', label: 'Bottles' },
  { key: 'signatureSGoal', label: 'Signature Service' },
  { key: 'retailAttachGoal', label: 'Retail Attach %' },
  { key: 'bottleToColorGoal', label: 'Bottle-to-Color %' },
  { key: 'bottleToSSGoal', label: 'Bottle-to-SS %' },
];

function leaderEmail({ leader, rows, month, lyMonth, prevMonth, prevPartial, siteUrl }) {
  const td = `padding:7px 8px;font-family:${FONT};font-size:12.5px;border-bottom:1px solid ${BRAND.line};`;
  const th = `padding:7px 8px;font-family:${FONT};font-size:11.5px;font-weight:700;color:#fff;background:${BRAND.navy2};`;
  const money = n => (n == null ? '&mdash;' : fmt$(n));
  // Per-day / per-week averages: bigger and bold so they read at a glance.
  const avg = 'font-size:13.5px;font-weight:700;margin-top:3px;';
  const goalAvg = `${avg}color:${BRAND.navy};`;
  const refAvg = `${avg}color:#444;`;
  const body = rows.map((r, i) => `
    <tr style="background:${i % 2 ? BRAND.paper : BRAND.card};">
      <td style="${td}color:${BRAND.navy};font-weight:700;">${escapeHtml(r.name)}</td>
      <td style="${td}text-align:right;">
        <div style="font-weight:700;color:${BRAND.navy};font-size:14px;">${money(r.goal)}</div>
        ${r.breakdown ? `<div style="${goalAvg}">${fmt$(r.breakdown.daily)}/day &middot; ${fmt$(r.breakdown.weekly)}/wk</div>` : ''}
      </td>
      <td style="${td}text-align:right;">${money(r.ly?.sales)}<div style="${refAvg}">${r.ly?.daily != null ? `${fmt$(r.ly.daily)}/day` : ''}</div></td>
      <td style="${td}text-align:right;">${money(r.prev?.sales)}<div style="${refAvg}">${r.prev?.daily != null ? `${fmt$(r.prev.daily)}/day` : ''}</div></td>
    </tr>`).join('');
  const sum = f => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const totalGoal = sum(r => r.goal);
  const totalBreak = salesGoalBreakdown(totalGoal, month);
  const totalRow = `
    <tr style="background:${BRAND.line};">
      <td style="${td}font-weight:700;color:${BRAND.navy};">Total</td>
      <td style="${td}text-align:right;font-weight:700;color:${BRAND.navy};">${fmt$(totalGoal)}${totalBreak ? `<div style="${goalAvg}">${fmt$(totalBreak.daily)}/day &middot; ${fmt$(totalBreak.weekly)}/wk</div>` : ''}</td>
      <td style="${td}text-align:right;font-weight:700;">${fmt$(sum(r => r.ly?.sales))}</td>
      <td style="${td}text-align:right;font-weight:700;">${fmt$(sum(r => r.prev?.sales))}</td>
    </tr>`;

  const missing = rows.map(r => ({ name: r.name, labels: OTHER_GOALS.filter(g => r.other[g.key] == null).map(g => g.label) })).filter(m => m.labels.length);
  const reminder = missing.length
    ? `<p style="margin:0 0 8px;font-weight:700;">Please set your other ${monthLabel(month)} goals on the Goals tab:</p>
       <ul style="margin:0;padding-left:18px;">${missing.map(m => `<li style="margin:2px 0;"><strong>${escapeHtml(m.name)}</strong>: ${m.labels.join(', ')}</li>`).join('')}</ul>`
    : `<p style="margin:0;">Your Retail, Color, Bottles and Signature Service goals for ${monthLabel(month)} are all set. Thank you!</p>`;
  const button = siteUrl ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0;"><tr><td style="border-radius:6px;background:${BRAND.red};">
      <a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:10px 22px;font-family:${FONT};font-size:13px;font-weight:700;color:#fff;text-decoration:none;">Open the Goals tab &#8594;</a>
    </td></tr></table>` : '';

  const html = `
    <div style="background:${BRAND.paper};padding:24px 12px;font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:${BRAND.card};border-radius:10px;overflow:hidden;">
        <tr><td style="background:${BRAND.navy};padding:24px 28px;text-align:center;">
          <div style="font-size:11px;letter-spacing:2px;color:#9FB3CE;text-transform:uppercase;">Supercuts Analytics</div>
          <div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">${monthLabel(month)} Sales Goals</div>
          <div style="font-size:13px;color:#C7D3E3;margin-top:6px;">For ${escapeHtml(leader)}</div>
        </td></tr>
        <tr><td style="padding:20px 24px 24px;">
          <p style="margin:0 0 4px;font-family:${FONT};font-size:13.5px;color:#333;line-height:1.5;">Leadership has finalized your stores' Sales goals for ${monthLabel(month)}. Each goal is shown per day and per week, next to ${monthLabel(lyMonth)} and ${monthLabel(prevMonth)}${prevPartial ? ' (so far)' : ''} for comparison.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${sectionBand(`Your stores`, BRAND.navy)}
            <tr><td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${BRAND.line};">
                <tr>
                  <td style="${th}">Store</td>
                  <td style="${th}text-align:right;background:${BRAND.red};">${monthLabel(month)} Goal</td>
                  <td style="${th}text-align:right;">${monthLabel(lyMonth)}</td>
                  <td style="${th}text-align:right;">${monthLabel(prevMonth)}${prevPartial ? ' (so far)' : ''}</td>
                </tr>
                ${body}${totalRow}
              </table>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;background:#FBF6E6;border-left:4px solid ${BRAND.gold};border-radius:6px;">
            <tr><td style="padding:14px 16px;font-family:${FONT};font-size:13px;color:#333;line-height:1.5;">
              <div style="font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.bronze};margin-bottom:6px;">Reminder</div>
              ${reminder}
              ${button}
            </td></tr>
          </table>
        </td></tr>
      </table>
    </div>`.replace(/>\s*\n\s*</g, '><');
  return { subject: `${monthLabel(month)} Sales Goals — ${leader}`, html };
}

// Builds every leader's email for `month` from the stored goals + history.
export function buildGoalEmails({ goals, history, weeklyHistory, month, todayISO, siteUrl }) {
  const lyMonth = shiftMonthKey(month, -12);
  const prevMonth = shiftMonthKey(month, -1);
  const prevPartial = monthKeyRange(prevMonth, todayISO).end < monthKeyRange(prevMonth).end;
  const ly = monthlyReference(history, weeklyHistory, lyMonth, todayISO);
  const prev = monthlyReference(history, weeklyHistory, prevMonth, todayISO);
  const emails = {};
  const withoutGoals = [];
  LEADER_ROSTER_SECTIONS.flatMap(sec => sec.leaders).forEach(l => {
    const rows = l.storeCodes.map(code => {
      const g = goals?.[code] || {};
      const goal = g[`salesGoal:${month}`] ?? null;
      const other = Object.fromEntries(OTHER_GOALS.map(o => [o.key, g[`${o.key}:${month}`] ?? null]));
      return { code, name: STORE_CODE_TO_NAME[code] || `Store ${code}`, goal, breakdown: salesGoalBreakdown(goal, month), ly: ly[code], prev: prev[code], other };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.some(r => r.goal != null)) { withoutGoals.push(l.name); return; }
    emails[l.name] = leaderEmail({ leader: l.name, rows, month, lyMonth, prevMonth, prevPartial, siteUrl });
  });
  return { emails, withoutGoals };
}

// Called from api/scoped-data.js ({ action: 'finalize-goals' }) rather than
// being its own function: the Hobby plan allows 12 serverless functions per
// deployment, and the leading underscore keeps Vercel from counting this file.
export async function handleFinalizeGoals(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, month, test } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'owner') {
    res.status(403).json({ error: 'Only leadership can finalize and email goals.' });
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(month || '')) {
    res.status(400).json({ error: 'Pick a month first.' });
    return;
  }
  const webAppUrl = process.env.GOALS_EMAIL_WEBAPP_URL;
  const secret = process.env.LEADERBOARD_EMAIL_SECRET;
  if (!webAppUrl || !secret) {
    res.status(500).json({ error: 'Goal emails aren\'t set up yet: the Apps Script web app URL (GOALS_EMAIL_WEBAPP_URL) is missing in Vercel.' });
    return;
  }

  try {
    const todayISO = new Date().toISOString().slice(0, 10);
    const ranges = [shiftMonthKey(month, -12), shiftMonthKey(month, -1)].map(mk => monthKeyRange(mk, todayISO));
    const [{ history, weeklyHistory }, goalsRow] = await Promise.all([
      loadHistory(ranges),
      supabase.from('weekly_report').select('payload').eq('report_id', 'store_goals').maybeSingle(),
    ]);
    if (goalsRow.error) throw new Error(goalsRow.error.message);
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const siteUrl = req.headers.host ? `${proto}://${req.headers.host}` : null;
    const { emails, withoutGoals } = buildGoalEmails({ goals: goalsRow.data?.payload || {}, history, weeklyHistory, month, todayISO, siteUrl });
    if (!Object.keys(emails).length) {
      res.status(400).json({ error: `No store has a ${monthLabel(month)} Sales goal yet, so there's nothing to send.` });
      return;
    }

    const scriptRes = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action: 'goals', test: !!test, emails }),
      redirect: 'follow',
    });
    const text = await scriptRes.text();
    let result;
    try { result = JSON.parse(text); } catch {
      throw new Error('The Apps Script web app didn\'t answer. Check it\'s deployed with "Who has access: Anyone".');
    }
    if (!result.ok) throw new Error(result.error || 'The Apps Script web app reported a problem.');
    res.status(200).json({ ok: true, sent: result.sent || [], skipped: result.skipped || [], withoutGoals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
