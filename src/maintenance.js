import React, { useMemo, useState } from 'react';
import { sendMaintenanceRequest } from './auth';
import { STORE_CODE_TO_NAME } from './storeDirectory';

// ─── Maintenance requests ──────────────────────────────────────────────────
// Homepage sidebar widget (under Shoutouts): pick a store, type the issue,
// Send. api/_maintenance.js saves it (`maintenance_request_<id>` rows) and
// passes it to a Google Sheet's Apps Script web app, which adds the row and
// keeps the Sheet sorted by DL. The DL is looked up on the server from
// leaderRoster.js. Setup → Maintenance has the script and setup steps.

const MAX_ISSUE = 2000; // same limit as MAINTENANCE_MAX_ISSUE on the server

// Stores this person can pick: every store for the owner, otherwise their own.
export function maintenanceStoreOptions(role, storeCodes) {
  const codes = role === 'owner' ? Object.keys(STORE_CODE_TO_NAME) : (storeCodes || []).map(String).filter(c => STORE_CODE_TO_NAME[c]);
  return [...new Set(codes)]
    .map(code => ({ code, name: STORE_CODE_TO_NAME[code] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function MaintenanceRequestWidget({ token, role, storeCodes, disabledNote = null }) {
  const stores = useMemo(() => maintenanceStoreOptions(role, storeCodes), [role, storeCodes]);
  const [store, setStore] = useState(stores.length === 1 ? stores[0].code : '');
  const [issue, setIssue] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null); // { kind: 'ok' | 'warn' | 'error', text }

  const canSend = !disabledNote && token && store && issue.trim() && !sending;

  const submit = async e => {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setStatus(null);
    const res = await sendMaintenanceRequest(token, store, issue.trim());
    setSending(false);
    if (!res.ok) {
      setStatus({ kind: 'error', text: res.error || 'Could not send. Please try again.' });
      return;
    }
    setIssue('');
    if (stores.length !== 1) setStore('');
    setStatus(res.sheetError
      ? { kind: 'warn', text: `Request saved, but it didn't reach the Google Sheet: ${res.sheetError}` }
      : { kind: 'ok', text: `Sent for ${res.request?.storeName || 'your store'}. Thank you!` });
  };

  return (
    <div className="homepage-widget maintenance-widget">
      <div className="homepage-widget-head">
        <p className="homepage-widget-title">🔧 Maintenance Request</p>
      </div>
      {disabledNote ? (
        <p className="empty-note">{disabledNote}</p>
      ) : !stores.length ? (
        <p className="empty-note">No store is assigned to your login yet, so there's nothing to pick. Ask the owner to add your store.</p>
      ) : (
        <form className="maintenance-form" onSubmit={submit}>
          <select className="homepage-input" value={store} onChange={e => setStore(e.target.value)} aria-label="Store">
            {stores.length !== 1 && <option value="">Select a store…</option>}
            {stores.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          <textarea
            className="homepage-textarea" rows={4} maxLength={MAX_ISSUE} value={issue}
            onChange={e => { setIssue(e.target.value); if (status) setStatus(null); }}
            placeholder="What's the issue? (e.g. Station 3 chair won't go up)" aria-label="Issue"
          />
          <button type="submit" className="btn-primary homepage-post-btn" disabled={!canSend}>{sending ? 'Sending…' : 'Send Request'}</button>
          {status && <p className={`maintenance-status maintenance-status--${status.kind}`}>{status.text}</p>}
        </form>
      )}
    </div>
  );
}

// Owner-only Setup → Maintenance: the Google Sheet script and setup steps.
export function MaintenanceSetupTab() {
  const script = `// Google Apps Script - bound to a Google Sheet. Receives maintenance
// requests from the site's Homepage widget, adds each one as a row on the
// "Requests" tab, and keeps the tab sorted by DL (newest first within each DL).
// Status and Notes are yours to fill in; they stay with their row when it sorts.

const SHARED_SECRET = 'PASTE_YOUR_SECRET_HERE'; // must exactly match MAINTENANCE_SHEET_SECRET in Vercel

const TAB = 'Requests';
const HEADER = ['DL', 'Store', 'Store #', 'Issue', 'Submitted By', 'Submitted', 'Status', 'Notes'];
const NAVY = '#1F3A5F';
const STATUSES = ['Open', 'In Progress', 'Done'];

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply_({ ok: false, error: 'Bad request.' }); }
  if (body.secret !== SHARED_SECRET) return reply_({ ok: false, error: 'Wrong secret.' });
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    addRequest_(body.request || {});
  } finally {
    lock.releaseLock();
  }
  return reply_({ ok: true });
}

// Run this once from the editor to check the Sheet is set up (adds a TEST row; delete it after).
function testRequest() {
  addRequest_({ dl: 'TEST', storeName: 'Test Store', storeCode: '00000', issue: 'Test request - delete me', submittedBy: 'Setup test', submittedAt: new Date().toISOString() });
}

function addRequest_(r) {
  const sheet = getSheet_();
  const row = [r.dl || 'No DL', r.storeName || '', String(r.storeCode || ''), r.issue || '', r.submittedBy || '', r.submittedAt ? new Date(r.submittedAt) : new Date(), 'Open', ''];
  const at = sheet.getLastRow() + 1;
  sheet.getRange(at, 3).setNumberFormat('@');
  sheet.getRange(at, 1, 1, row.length).setValues([row]);
  sheet.getRange(at, 6).setNumberFormat('M/d/yyyy h:mm am/pm');
  sheet.getRange(at, 7).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build());
  sheet.getRange(at, 4).setWrap(true);
  sortByDl_(sheet);
}

// DL A-Z, then newest first within each DL.
function sortByDl_(sheet) {
  const last = sheet.getLastRow();
  if (last < 3) return;
  sheet.getRange(2, 1, last - 1, HEADER.length).sort([{ column: 1, ascending: true }, { column: 6, ascending: false }]);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB);
  if (!sheet) sheet = ss.insertSheet(TAB, 0);
  if (sheet.getRange(1, 1).getValue() !== HEADER[0]) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold').setFontColor('#ffffff').setBackground(NAVY);
    sheet.setFrozenRows(1);
    [150, 150, 70, 380, 150, 140, 100, 220].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  }
  return sheet;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}`;

  return (
    <div className="setup-section">
      <div className="setup-sql-card">
        <p className="chart-title">Maintenance requests → Google Sheet</p>
        <p className="step-body">The Homepage has a "Maintenance Request" box under Shoutouts. Anyone logged in picks a store (their own store; you can pick any) and types the issue. Each request is saved on the site and sent to a Google Sheet, where it's added to a "Requests" tab sorted by DL (newest first within each DL). The DL comes from the store roster. Status (Open / In Progress / Done) and Notes are columns for you to fill in, and they move with their row when the Sheet re-sorts. Until steps 1–4 are done, requests are still saved, and the sender sees a note that the Sheet isn't connected.</p>
      </div>
      <div className="setup-step">
        <div className="step-num">1</div>
        <div><p className="step-title">Create the Sheet + add the script</p><p className="step-body">Make a new Google Sheet → Extensions → Apps Script → paste in the code below (replacing everything) → make up a long password and paste it into <code>SHARED_SECRET</code> → Save. Then pick <code>testRequest</code> from the function dropdown and click Run (click through the "unverified app" warning: Advanced → Go to (project name) (unsafe) → Allow). A TEST row should appear on a "Requests" tab; delete it.</p></div>
      </div>
      <pre className="setup-sql">{script}</pre>
      <div className="setup-step">
        <div className="step-num">2</div>
        <div><p className="step-title">Deploy it as a web app</p><p className="step-body">In the script editor: Deploy → New deployment → gear icon → Web app. Execute as: <strong>Me</strong>. Who has access: <strong>Anyone</strong>. Deploy, then copy the Web app URL (ends in <code>/exec</code>).</p></div>
      </div>
      <div className="setup-step">
        <div className="step-num">3</div>
        <div><p className="step-title">Add two settings in Vercel</p><p className="step-body">Vercel project → Settings → Environment Variables → add <code>MAINTENANCE_SHEET_WEBAPP_URL</code> (the /exec URL) and <code>MAINTENANCE_SHEET_SECRET</code> (the same password as in the script). Do this on both Vercel projects for this site, then redeploy.</p></div>
      </div>
      <div className="setup-step">
        <div className="step-num">4</div>
        <div><p className="step-title">Send a test from the Homepage</p><p className="step-body">Send a request from the Homepage box. It should say "Sent" and show up in the Sheet within a few seconds. If you ever change the script, use Deploy → Manage deployments → edit → Version: <strong>New version</strong>, or the site keeps using the old code.</p></div>
      </div>
    </div>
  );
}
