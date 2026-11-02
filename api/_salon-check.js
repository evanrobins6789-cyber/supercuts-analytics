// Shear Check (salon visit checklist tab), server side. Not its own Vercel
// function: the Hobby plan caps a deployment at 12 functions, so this is
// reached through api/scoped-data.js, and the leading underscore keeps
// Vercel from counting this file.
//
// - cleanSalonCheckPatch: validates a save to the `salon_checks` row and
//   recomputes each visit's score, so stored scores always match answers.
// - handleSalonCheckEmail: emails one saved visit to the store's District
//   Leader / Area Supervisor (src/leaderRoster.js). Mail goes through the
//   same Apps Script web app as the Goals tab (GOALS_EMAIL_WEBAPP_URL). It
//   reuses that script's `goals` action, which sends emails[leaderName] to
//   whichever RECIPIENTS addresses are mapped to that leader, so the script
//   needed no changes for this.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { getLeaderForStoreCode } from '../src/leaderRoster.js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';
import { SALON_CHECK_SECTIONS, SALON_CHECK_ITEMS, SALON_CHECK_ANSWERS, scoreSalonCheck } from '../src/salonCheck.js';
import { BRAND, FONT, escapeHtml } from './leaderboard-email.js';

const ITEM_IDS = new Set(SALON_CHECK_ITEMS.map(i => i.id));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanVisit(id, code, v, employee) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'A visit must be an object.' };
  if (!ISO_DATE.test(v.date || '')) return { error: 'Pick the visit date.' };
  const answers = {};
  Object.entries(v.answers || {}).forEach(([k, a]) => { if (ITEM_IDS.has(k) && SALON_CHECK_ANSWERS.includes(a)) answers[k] = a; });
  const notes = {};
  Object.entries(v.notes || {}).forEach(([k, n]) => { const t = str(n, 1000); if (ITEM_IDS.has(k) && t) notes[k] = t; });
  const sc = scoreSalonCheck(answers);
  if (sc.answered < sc.total) {
    const left = sc.total - sc.answered;
    return { error: `Answer every item first (${left} still blank).` };
  }
  return {
    visit: {
      id, code, date: v.date,
      manager: str(v.manager, 120),
      team: str(v.team, 400),
      followUp: str(v.followUp, 3000),
      answers, notes,
      yes: sc.yes, no: sc.no, na: sc.na, total: sc.total, score: sc.score,
      by: str(v.by, 120) || employee.name || '',
      savedAt: str(v.savedAt, 40) || new Date().toISOString(),
      ...(typeof v.emailedAt === 'string' ? { emailedAt: v.emailedAt, emailedTo: str(v.emailedTo, 120) } : {}),
    },
  };
}

// patch: { [storeCode]: { [visitId]: visit | null } }. Returns { patch } or
// { error, status }. Store scoping (a DL only their own codes) is checked
// afterward by the caller, same as every other patchable key.
export function cleanSalonCheckPatch(patch, employee) {
  if (!patch || typeof patch !== 'object') return { error: 'Nothing to save.' };
  const out = {};
  for (const [code, visits] of Object.entries(patch)) {
    if (!visits || typeof visits !== 'object' || Array.isArray(visits)) return { error: 'Salon checks are saved one visit at a time.' };
    out[code] = {};
    for (const [id, v] of Object.entries(visits)) {
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return { error: 'Bad visit id.' };
      if (v === null) {
        if (employee.role !== 'owner') return { error: 'Only leadership can delete a salon check.', status: 403 };
        out[code][id] = null;
        continue;
      }
      const { visit, error } = cleanVisit(id, code, v, employee);
      if (error) return { error };
      out[code][id] = visit;
    }
  }
  return { patch: out };
}

const pct = s => (s == null ? '&mdash;' : `${Math.round(s * 100)}%`);
const fmtDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};
const scoreColor = s => (s == null ? BRAND.inkSoft : s >= 0.9 ? BRAND.green : s >= 0.75 ? BRAND.bronze : BRAND.red);
const MARK = {
  yes: { text: 'Yes', color: BRAND.green, bg: '#EAF5EE' },
  no: { text: 'No', color: BRAND.red, bg: '#FBECEC' },
  na: { text: 'N/A', color: BRAND.inkSoft, bg: BRAND.paper },
};

export function buildSalonCheckEmail({ visit, storeName, siteUrl }) {
  const td = `padding:7px 9px;font-family:${FONT};font-size:13px;border-bottom:1px solid ${BRAND.line};vertical-align:top;`;
  const sections = SALON_CHECK_SECTIONS.map(sec => {
    const rows = sec.items.map(i => {
      const a = visit.answers?.[i.id];
      const m = MARK[a] || { text: '&mdash;', color: BRAND.inkSoft, bg: BRAND.card };
      const note = visit.notes?.[i.id];
      return `<tr style="background:${a === 'no' ? '#FFF6F6' : BRAND.card};">
        <td style="${td}color:#222;">${escapeHtml(i.label)}${note ? `<div style="margin-top:3px;font-size:12.5px;color:${BRAND.navy2};font-style:italic;">Note: ${escapeHtml(note)}</div>` : ''}</td>
        <td style="${td}text-align:center;width:56px;"><span style="display:inline-block;min-width:38px;padding:2px 6px;border-radius:10px;background:${m.bg};color:${m.color};font-weight:700;font-size:12px;">${m.text}</span></td>
      </tr>`;
    }).join('');
    return `<tr><td colspan="2" style="padding:9px 9px 6px;font-family:${FONT};font-size:13px;font-weight:700;color:#fff;background:${BRAND.navy2};">${escapeHtml(sec.title)}</td></tr>${rows}`;
  }).join('');
  const noItems = SALON_CHECK_ITEMS.filter(i => visit.answers?.[i.id] === 'no');
  const info = [
    ['Visit date', fmtDate(visit.date)],
    ['Manager', visit.manager || '&mdash;'],
    ['Team on shift', visit.team || '&mdash;'],
    ['Checked by', visit.by || '&mdash;'],
  ].map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;font-family:${FONT};font-size:13px;color:${BRAND.inkSoft};white-space:nowrap;">${k}</td><td style="padding:3px 0;font-family:${FONT};font-size:13px;color:#222;font-weight:600;">${v === '&mdash;' ? v : escapeHtml(v)}</td></tr>`).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.paper};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};"><tr><td align="center" style="padding:20px 10px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${BRAND.card};border-radius:12px;overflow:hidden;">
      <tr><td style="background:${BRAND.navy};padding:18px 22px;">
        <div style="font-family:${FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#C9D4E3;">Shear Check &middot; Salon Visit</div>
        <div style="font-family:${FONT};font-size:22px;font-weight:700;color:#fff;margin-top:4px;">${escapeHtml(storeName)}</div>
      </td></tr>
      <tr><td style="padding:18px 22px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;"><table role="presentation" cellpadding="0" cellspacing="0">${info}</table></td>
          <td style="vertical-align:top;text-align:right;width:150px;">
            <div style="font-family:${FONT};font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:${BRAND.inkSoft};">Salon Score</div>
            <div style="font-family:${FONT};font-size:38px;font-weight:700;color:${scoreColor(visit.score)};line-height:1.1;">${pct(visit.score)}</div>
            <div style="font-family:${FONT};font-size:12px;color:${BRAND.inkSoft};">${visit.yes} Yes &middot; ${visit.no} No &middot; ${visit.na} N/A</div>
          </td>
        </tr></table>
      </td></tr>
      ${noItems.length ? `<tr><td style="padding:10px 22px 0;">
        <div style="border:1px solid #F0C9C9;background:#FFF6F6;border-radius:8px;padding:10px 14px;font-family:${FONT};font-size:13px;color:#222;">
          <div style="font-weight:700;color:${BRAND.red};margin-bottom:4px;">Needs attention (${noItems.length})</div>
          ${noItems.map(i => `&bull; ${escapeHtml(i.label)}`).join('<br>')}
        </div></td></tr>` : ''}
      ${visit.followUp ? `<tr><td style="padding:10px 22px 0;">
        <div style="border:1px solid #EBDDB0;background:#FBF6E6;border-radius:8px;padding:10px 14px;font-family:${FONT};font-size:13px;color:#222;">
          <div style="font-weight:700;color:${BRAND.bronze};margin-bottom:4px;">Follow up for next visit</div>
          ${escapeHtml(visit.followUp).replace(/\n/g, '<br>')}
        </div></td></tr>` : ''}
      <tr><td style="padding:14px 22px 6px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-collapse:collapse;">${sections}</table>
      </td></tr>
      <tr><td style="padding:12px 22px 22px;font-family:${FONT};font-size:12px;color:${BRAND.inkSoft};">
        Score = Yes &divide; (Yes + No); N/A items don't count.${siteUrl ? ` <a href="${siteUrl}" style="color:${BRAND.navy2};">Open Shear Check</a> to see this store's history.` : ''}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { subject: `Shear Check: ${storeName} scored ${visit.score == null ? 'n/a' : `${Math.round(visit.score * 100)}%`} (${fmtDate(visit.date)})`, html };
}

export async function handleSalonCheckEmail(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, code, id } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'owner' && !(employee.role === 'district_leader' && (employee.store_codes || []).includes(code))) {
    res.status(403).json({ error: 'You can only email salon checks for your own stores.' });
    return;
  }
  const leader = getLeaderForStoreCode(code);
  if (!leader) {
    res.status(400).json({ error: 'This store has no District Leader in the roster, so there\'s no one to email.' });
    return;
  }
  const webAppUrl = process.env.GOALS_EMAIL_WEBAPP_URL;
  const secret = process.env.LEADERBOARD_EMAIL_SECRET;
  if (!webAppUrl || !secret) {
    res.status(500).json({ error: 'Email isn\'t set up yet: the Apps Script web app URL (GOALS_EMAIL_WEBAPP_URL) is missing in Vercel.' });
    return;
  }
  try {
    const { data: row, error: loadError } = await supabase.from('weekly_report').select('payload').eq('report_id', 'salon_checks').maybeSingle();
    if (loadError) throw new Error(loadError.message);
    const visit = row?.payload?.[code]?.[id];
    if (!visit) {
      res.status(404).json({ error: 'That salon check isn\'t saved yet.' });
      return;
    }
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const siteUrl = req.headers.host ? `${proto}://${req.headers.host}` : null;
    const storeName = STORE_CODE_TO_NAME[code] || `Store ${code}`;
    const email = buildSalonCheckEmail({ visit, storeName, siteUrl });

    const scriptRes = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action: 'goals', test: false, emails: { [leader.leaderName]: email } }),
      redirect: 'follow',
    });
    const text = await scriptRes.text();
    let result;
    try { result = JSON.parse(text); } catch {
      throw new Error('The Apps Script web app didn\'t answer. Check it\'s deployed with "Who has access: Anyone".');
    }
    if (!result.ok) throw new Error(result.error || 'The Apps Script web app reported a problem.');
    if (!(result.sent || []).length) {
      res.status(400).json({ error: `No email address is set up for ${leader.leaderName} in the Apps Script RECIPIENTS list, so nothing was sent.` });
      return;
    }

    // Mark the visit as emailed (re-read so a save in between isn't lost).
    const emailedAt = new Date().toISOString();
    const { data: fresh, error: freshError } = await supabase.from('weekly_report').select('payload').eq('report_id', 'salon_checks').maybeSingle();
    if (!freshError && fresh?.payload?.[code]?.[id]) {
      const payload = { ...fresh.payload, [code]: { ...fresh.payload[code], [id]: { ...fresh.payload[code][id], emailedAt, emailedTo: leader.leaderName } } };
      await supabase.from('weekly_report').upsert({ report_id: 'salon_checks', payload }, { onConflict: 'report_id' });
    }
    res.status(200).json({ ok: true, leader: leader.leaderName, sent: result.sent, emailedAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
