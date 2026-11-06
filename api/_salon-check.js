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
// - handleSalonCheckPhoto: section photos, in the private `salon-check-photos`
//   Storage bucket. Same pattern as api/lease-files.js: the bytes go straight
//   from the browser to Storage on a signed URL, never through this function.
//   A visit stores only paths, under visit.photos[sectionId]. The email shows
//   them through long-lived signed links, which is why the Apps Script needed
//   no change for photos either.

import { createServiceClient, requireSession } from '../src/serverAuth.js';
import { getLeaderForStoreCode } from '../src/leaderRoster.js';
import { STORE_CODE_TO_NAME } from '../src/storeDirectory.js';
import { SALON_CHECK_ANSWERS, SALON_CHECK_MAX_PHOTOS, activeChecklist, checklistItems, salonCheckPhotoPaths, scoreSalonCheck, visitChecklist } from '../src/salonCheck.js';
import { BRAND, FONT, escapeHtml } from './leaderboard-email.js';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const PHOTO_BUCKET = 'salon-check-photos';
const PHOTO_VIEW_SECONDS = 60 * 60;
// A DL may open the email long after the visit, so its links last a year. The
// photos stay on the site for good; only old emails stop showing them.
const PHOTO_EMAIL_SECONDS = 60 * 60 * 24 * 365;
const STORE_CODE = /^[A-Za-z0-9_-]{1,20}$/;
const isPhotoPath = (code, p) => typeof p === 'string' && p.startsWith(`${code}/`) && /^[a-z0-9]{8,40}\.jpg$/.test(p.slice(code.length + 1));
let photoBucketEnsured = false;

async function ensurePhotoBucket(supabase) {
  if (photoBucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(error.message);
  if (!buckets.some(b => b.name === PHOTO_BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(PHOTO_BUCKET, { public: false, allowedMimeTypes: ['image/jpeg'], fileSizeLimit: 5 * 1024 * 1024 });
    if (createError && !/already exists/i.test(createError.message)) throw new Error(createError.message);
  }
  photoBucketEnsured = true;
}

// Only photos in a section this visit keeps, and only under its own store.
function cleanPhotos(code, photos, sections) {
  const out = {};
  sections.filter(s => s.items.length).forEach(s => {
    const list = Array.isArray(photos?.[s.id]) ? [...new Set(photos[s.id])].filter(p => isPhotoPath(code, p)).slice(0, SALON_CHECK_MAX_PHOTOS) : [];
    if (list.length) out[s.id] = list;
  });
  return out;
}

function cleanVisit(id, code, v, employee, sections) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'A visit must be an object.' };
  if (!ISO_DATE.test(v.date || '')) return { error: 'Pick the visit date.' };
  const itemIds = new Set(checklistItems(sections).map(i => i.id));
  const answers = {};
  Object.entries(v.answers || {}).forEach(([k, a]) => { if (itemIds.has(k) && SALON_CHECK_ANSWERS.includes(a)) answers[k] = a; });
  const notes = {};
  Object.entries(v.notes || {}).forEach(([k, n]) => { const t = str(n, 1000); if (itemIds.has(k) && t) notes[k] = t; });
  const sc = scoreSalonCheck(answers, sections);
  if (sc.answered < sc.total) {
    const left = sc.total - sc.answered;
    return { error: `Answer every item first (${left} still blank).` };
  }
  const photos = cleanPhotos(code, v.photos, sections);
  return {
    visit: {
      id, code, date: v.date,
      manager: str(v.manager, 120),
      team: str(v.team, 400),
      followUp: str(v.followUp, 3000),
      answers, notes,
      ...(Object.keys(photos).length ? { photos } : {}),
      // This visit's own copy of the questions, so adding or deleting one
      // later never changes this report.
      checklist: sections.filter(s => s.items.length),
      yes: sc.yes, no: sc.no, na: sc.na, total: sc.total, score: sc.score,
      by: str(v.by, 120) || employee.name || '',
      savedAt: str(v.savedAt, 40) || new Date().toISOString(),
      ...(typeof v.emailedAt === 'string' ? { emailedAt: v.emailedAt, emailedTo: str(v.emailedTo, 120) } : {}),
    },
  };
}

// patch: { [storeCode]: { [visitId]: visit | null } }. Returns { patch } or
// { error, status }. Store scoping (a DL only their own codes) is checked
// afterward by the caller, same as every other patchable key. `config` is the
// `salon_check_questions` row: visits are checked and scored against the
// questions in use now, not what the browser sent.
export function cleanSalonCheckPatch(patch, employee, config) {
  const sections = activeChecklist(config);
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
      const { visit, error } = cleanVisit(id, code, v, employee, sections);
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

export function buildSalonCheckEmail({ visit, storeName, siteUrl, photoUrls = {} }) {
  const td = `padding:7px 9px;font-family:${FONT};font-size:13px;border-bottom:1px solid ${BRAND.line};vertical-align:top;`;
  const checklist = visitChecklist(visit);
  const sections = checklist.map(sec => {
    const rows = sec.items.map(i => {
      const a = visit.answers?.[i.id];
      const m = MARK[a] || { text: '&mdash;', color: BRAND.inkSoft, bg: BRAND.card };
      const note = visit.notes?.[i.id];
      return `<tr style="background:${a === 'no' ? '#FFF6F6' : BRAND.card};">
        <td style="${td}color:#222;">${escapeHtml(i.label)}${note ? `<div style="margin-top:3px;font-size:12.5px;color:${BRAND.navy2};font-style:italic;">Note: ${escapeHtml(note)}</div>` : ''}</td>
        <td style="${td}text-align:center;width:56px;"><span style="display:inline-block;min-width:38px;padding:2px 6px;border-radius:10px;background:${m.bg};color:${m.color};font-weight:700;font-size:12px;">${m.text}</span></td>
      </tr>`;
    }).join('');
    const paths = visit.photos?.[sec.id] || [];
    const shown = paths.filter(p => photoUrls[p]);
    const imgs = shown.map(p => {
      const url = escapeHtml(photoUrls[p]);
      return `<a href="${url}" style="display:inline-block;margin:0 6px 6px 0;"><img src="${url}" width="180" alt="${escapeHtml(sec.title)} photo" style="display:block;width:180px;max-width:100%;height:auto;border:0;border-radius:6px;"></a>`;
    }).join('');
    const missing = paths.length - shown.length;
    const photoRow = paths.length ? `<tr><td colspan="2" style="padding:8px 9px 2px;background:${BRAND.card};border-bottom:1px solid ${BRAND.line};">${imgs}${missing ? `<div style="font-family:${FONT};font-size:12px;color:${BRAND.inkSoft};padding-bottom:6px;">${missing} photo${missing === 1 ? '' : 's'} could not be loaded.</div>` : ''}</td></tr>` : '';
    return `<tr><td colspan="2" style="padding:9px 9px 6px;font-family:${FONT};font-size:13px;font-weight:700;color:#fff;background:${BRAND.navy2};">${escapeHtml(sec.title)}</td></tr>${rows}${photoRow}`;
  }).join('');
  const noItems = checklistItems(checklist).filter(i => visit.answers?.[i.id] === 'no');
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

// Add or delete a checklist question (owner only). Body: { op: 'add',
// sectionId, label } or { op: 'remove', itemId }. Saved visits aren't touched.
export async function handleSalonCheckQuestion(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, op, sectionId, label, itemId } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'owner') {
    res.status(403).json({ error: 'Only leadership can change the checklist questions.' });
    return;
  }
  try {
    const { data: row, error: loadError } = await supabase.from('weekly_report').select('payload').eq('report_id', 'salon_check_questions').maybeSingle();
    if (loadError) throw new Error(loadError.message);
    const config = { added: row?.payload?.added || [], removed: row?.payload?.removed || [] };
    const sections = activeChecklist(config);
    let next;
    if (op === 'add') {
      const section = sections.find(s => s.id === sectionId);
      const text = str(label, 200);
      if (!section) { res.status(400).json({ error: 'That section does not exist.' }); return; }
      if (!text) { res.status(400).json({ error: 'Type the question first.' }); return; }
      if (section.items.some(i => i.label.toLowerCase() === text.toLowerCase())) {
        res.status(400).json({ error: 'That question is already in this section.' });
        return;
      }
      const id = `q-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      next = { ...config, added: [...config.added, { id, sectionId, label: text, by: employee.name || '', at: new Date().toISOString() }] };
    } else if (op === 'remove') {
      const items = checklistItems(sections);
      if (!items.some(i => i.id === itemId)) { res.status(400).json({ error: 'That question is already gone.' }); return; }
      if (items.length === 1) { res.status(400).json({ error: 'The checklist needs at least one question.' }); return; }
      next = { ...config, removed: [...config.removed, itemId] };
    } else {
      res.status(400).json({ error: 'Unknown question change.' });
      return;
    }
    const { error: saveError } = await supabase.from('weekly_report').upsert({ report_id: 'salon_check_questions', payload: next }, { onConflict: 'report_id' });
    if (saveError) throw new Error(saveError.message);
    res.status(200).json({ ok: true, data: next });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// Section photos. Body: { op: 'upload', code } for a one-time upload URL,
// { op: 'view', code, paths } for signed read links, or { op: 'delete', code,
// path } to take a photo off an unsaved visit. A photo on a saved visit can't
// be removed this way, so a saved report never changes.
export async function handleSalonCheckPhoto(req, res) {
  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }
  const { token, op, code, paths, path } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (typeof code !== 'string' || !STORE_CODE.test(code)) {
    res.status(400).json({ error: 'Pick a salon first.' });
    return;
  }
  if (employee.role !== 'owner' && !(employee.role === 'district_leader' && (employee.store_codes || []).includes(code))) {
    res.status(403).json({ error: 'You can only use salon check photos for your own stores.' });
    return;
  }
  try {
    await ensurePhotoBucket(supabase);
    if (op === 'upload') {
      const objectPath = `${code}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.jpg`;
      const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUploadUrl(objectPath);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, path: objectPath, uploadToken: data.token });
      return;
    }
    if (op === 'view') {
      const list = Array.isArray(paths) ? paths.slice(0, 100) : [];
      if (!list.every(p => isPhotoPath(code, p))) {
        res.status(400).json({ error: 'Bad photo path.' });
        return;
      }
      const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(list, PHOTO_VIEW_SECONDS);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, urls: Object.fromEntries((data || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl])) });
      return;
    }
    if (op === 'delete') {
      if (!isPhotoPath(code, path)) {
        res.status(400).json({ error: 'Bad photo path.' });
        return;
      }
      const { data: row, error: loadError } = await supabase.from('weekly_report').select('payload').eq('report_id', 'salon_checks').maybeSingle();
      if (loadError) throw new Error(loadError.message);
      if (Object.values(row?.payload?.[code] || {}).some(v => salonCheckPhotoPaths(v).includes(path))) {
        res.status(400).json({ error: 'That photo is part of a saved report.' });
        return;
      }
      const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([path]);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ error: 'Unknown photo action.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// After leadership deletes a visit: its photos go too. Best effort, since the
// visit is already gone and a leftover file harms nothing.
export async function removeDeletedVisitPhotos(supabase, before, patch) {
  const paths = Object.entries(patch).flatMap(([code, visits]) => Object.entries(visits || {})
    .filter(([, v]) => v === null)
    .flatMap(([id]) => salonCheckPhotoPaths(before?.[code]?.[id])));
  if (!paths.length) return;
  try {
    await supabase.storage.from(PHOTO_BUCKET).remove(paths);
  } catch { /* see above */ }
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
    const photoPaths = salonCheckPhotoPaths(visit);
    let photoUrls = {};
    if (photoPaths.length) {
      const { data: signed, error: signError } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(photoPaths, PHOTO_EMAIL_SECONDS);
      if (signError) throw new Error(signError.message);
      photoUrls = Object.fromEntries((signed || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
    }
    const email = buildSalonCheckEmail({ visit, storeName, siteUrl, photoUrls });

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
