// Google Apps Script - leadership goal + Thursday-call agenda emails.
// Runs entirely in Gmail; nothing on the Supercuts Analytics site is involved.
//
//   1st of the month, ~8am ........ asks everyone for their goal for the month
//   2nd of the month, ~12am ....... sends everyone the list of all goals
//   Wednesday, ~8am ............... asks everyone what to discuss on Thursday's call
//   Thursday, ~12am (Wed night) ... sends everyone the call agenda
//
// People answer by simply REPLYING to the ask email. The summary is built by
// reading those replies out of this Gmail account, so the script must run on
// the same Gmail account the asks are sent from (replies come back to it).
//
// Setup:
//   1. script.google.com > New project > paste this whole file in.
//   2. Fill in RECIPIENTS below.
//   3. Project Settings (gear icon) > Time zone > (GMT-05:00) Eastern Time - New York.
//   4. Run setupTriggers once (choose it in the function dropdown, click Run,
//      and approve the Gmail permissions).
//   5. Optional: run sendTestToMe to get a sample of all four emails sent
//      only to you.
//
// Keep this file plain ASCII (no curly quotes, emoji, or em dashes typed
// directly). Copy/paste has mangled non-ASCII characters in other scripts.
// Use HTML entities such as &mdash; inside HTML strings instead.

// Everyone who gets the asks AND the summaries. The name is what shows next
// to their answer in the summary.
const RECIPIENTS = [
  { name: 'Your Name', email: 'you@example.com' },
  { name: 'Someone Else', email: 'someone@example.com' },
];

const FROM_NAME = 'Supercuts Leadership';
const EXPECTED_TIME_ZONE = 'America/New_York';

// ---------------------------------------------------------------------------
// Trigger entry points

function sendMonthlyGoalAsk() {
  const month = monthLabel_(new Date());
  sendAsk_(RECIPIENTS, monthlyAskSubject_(month), {
    title: 'Your Goal for ' + month,
    intro: 'What is your goal for ' + month + '?',
    detail: 'Just reply to this email with your goal. Everyone\'s goals will be sent out together tomorrow.',
  });
}

function sendMonthlyGoalSummary() {
  const month = monthLabel_(new Date());
  const answers = collectReplies_(monthlyAskSubject_(month), 5);
  sendSummary_(RECIPIENTS, month + ' Goals', {
    title: month + ' Goals',
    subtitle: 'Everyone\'s goal for the month',
    answers: answers,
  });
}

function sendThursdayTopicsAsk() {
  const call = thursdayLabel_(new Date());
  sendAsk_(RECIPIENTS, thursdayAskSubject_(call), {
    title: 'Thursday Call Topics',
    intro: 'What would you like to discuss on Thursday\'s call (' + call + ')?',
    detail: 'Just reply to this email with your topics. The full agenda goes out tonight at midnight.',
  });
}

function sendThursdayAgenda() {
  const call = thursdayLabel_(new Date());
  const answers = collectReplies_(thursdayAskSubject_(call), 3);
  sendSummary_(RECIPIENTS, 'Thursday Call Agenda - ' + call, {
    title: 'Thursday Call Agenda',
    subtitle: 'Topics for the ' + call + ' call',
    answers: answers,
  });
}

// ---------------------------------------------------------------------------
// One-time setup and testing

function setupTriggers() {
  const tz = Session.getScriptTimeZone();
  if (tz !== EXPECTED_TIME_ZONE) {
    throw new Error('Script time zone is ' + tz + '. Set Project Settings > Time zone to Eastern Time - New York, then run setupTriggers again.');
  }
  const handlers = ['sendMonthlyGoalAsk', 'sendMonthlyGoalSummary', 'sendThursdayTopicsAsk', 'sendThursdayAgenda'];
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return handlers.indexOf(t.getHandlerFunction()) !== -1; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendMonthlyGoalAsk').timeBased().onMonthDay(1).atHour(8).nearMinute(0).create();
  ScriptApp.newTrigger('sendMonthlyGoalSummary').timeBased().onMonthDay(2).atHour(0).nearMinute(0).create();
  ScriptApp.newTrigger('sendThursdayTopicsAsk').timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(8).nearMinute(0).create();
  ScriptApp.newTrigger('sendThursdayAgenda').timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(0).nearMinute(0).create();
  Logger.log('4 triggers created.');
}

// Sends all four emails to only you, subjects prefixed with [TEST], so you
// can see what they look like. The test summaries pick up any real replies
// that already exist for the current month / this week's call.
function sendTestToMe() {
  const me = [{ name: 'Me', email: Session.getActiveUser().getEmail() }];
  const month = monthLabel_(new Date());
  const call = thursdayLabel_(new Date());
  sendAsk_(me, '[TEST] ' + monthlyAskSubject_(month), {
    title: 'Your Goal for ' + month,
    intro: 'What is your goal for ' + month + '?',
    detail: 'Just reply to this email with your goal. Everyone\'s goals will be sent out together tomorrow.',
  });
  sendSummary_(me, '[TEST] ' + month + ' Goals', {
    title: month + ' Goals', subtitle: 'Everyone\'s goal for the month',
    answers: collectReplies_(monthlyAskSubject_(month), 31),
  });
  sendAsk_(me, '[TEST] ' + thursdayAskSubject_(call), {
    title: 'Thursday Call Topics',
    intro: 'What would you like to discuss on Thursday\'s call (' + call + ')?',
    detail: 'Just reply to this email with your topics. The full agenda goes out tonight at midnight.',
  });
  sendSummary_(me, '[TEST] Thursday Call Agenda - ' + call, {
    title: 'Thursday Call Agenda', subtitle: 'Topics for the ' + call + ' call',
    answers: collectReplies_(thursdayAskSubject_(call), 7),
  });
}

// ---------------------------------------------------------------------------
// Subjects and dates. The summary finds replies by the ask's exact subject,
// so each ask subject must be unique to its month / call date.

function monthlyAskSubject_(month) { return 'Your goal for ' + month; }
function thursdayAskSubject_(call) { return 'Topics for Thursday call - ' + call; }

function monthLabel_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMMM yyyy');
}

// The upcoming Thursday, or today if today is Thursday (the agenda runs just
// after midnight Wednesday night, which is already Thursday).
function thursdayLabel_(date) {
  const tz = Session.getScriptTimeZone();
  const dow = Number(Utilities.formatDate(date, tz, 'u')); // 1 = Monday ... 7 = Sunday
  const daysAhead = (4 - dow + 7) % 7;
  const thursday = new Date(date.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(thursday, tz, 'EEE, MMM d, yyyy');
}

// ---------------------------------------------------------------------------
// Sending

// Each person gets their own copy so a reply goes only back to this account,
// not reply-all to the whole group.
function sendAsk_(recipients, subject, content) {
  const html = wrapHtml_(content.title,
    '<p style="font-size:16px;font-weight:bold;color:#142A4A;margin:0 0 10px;">' + escapeHtml_(content.intro) + '</p>' +
    '<p style="font-size:14px;color:#5A6B80;margin:0;">' + escapeHtml_(content.detail) + '</p>');
  const plain = content.intro + '\n\n' + content.detail;
  recipients.forEach(function (r) {
    GmailApp.sendEmail(r.email, subject, plain, { htmlBody: html, name: FROM_NAME });
  });
}

function sendSummary_(recipients, subject, content) {
  const byEmail = {};
  content.answers.forEach(function (a) { byEmail[a.email] = a; });
  // Everyone on the list first, in list order (with "No reply" if they
  // didn't answer), then anyone who replied but isn't on the list.
  const rows = recipients.map(function (r) {
    const a = byEmail[r.email.toLowerCase()];
    delete byEmail[r.email.toLowerCase()];
    return { name: r.name, text: a ? a.text : null };
  }).concat(Object.keys(byEmail).map(function (k) { return { name: byEmail[k].name, text: byEmail[k].text }; }));

  const cards = rows.map(function (row) {
    const body = row.text
      ? '<div style="font-size:14px;color:#333;line-height:1.5;margin-top:4px;">' + escapeHtml_(row.text).replace(/\n/g, '<br>') + '</div>'
      : '<div style="font-size:13px;color:#9AA7B4;font-style:italic;margin-top:4px;">No reply</div>';
    return '<div style="border:1px solid #E1E7ED;border-left:4px solid ' + (row.text ? '#2E7D4F' : '#9AA7B4') + ';border-radius:6px;padding:12px 14px;margin:0 0 10px;">' +
      '<div style="font-size:15px;font-weight:bold;color:#142A4A;">' + escapeHtml_(row.name) + '</div>' + body + '</div>';
  }).join('');
  const html = wrapHtml_(content.title,
    '<p style="font-size:14px;color:#5A6B80;margin:0 0 14px;">' + escapeHtml_(content.subtitle) + '</p>' + cards);
  const plain = rows.map(function (row) { return row.name + ':\n' + (row.text || '(no reply)'); }).join('\n\n');
  GmailApp.sendEmail(recipients.map(function (r) { return r.email; }).join(','), subject, plain, { htmlBody: html, name: FROM_NAME });
}

function wrapHtml_(title, inner) {
  return '<div style="background:#F4F6F8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:10px;overflow:hidden;">' +
    '<div style="background:#142A4A;padding:22px 24px;text-align:center;">' +
    '<div style="font-size:11px;letter-spacing:2px;color:#9FB3CE;text-transform:uppercase;">Supercuts Leadership</div>' +
    '<div style="font-size:22px;font-weight:bold;color:#FFFFFF;margin-top:4px;">' + escapeHtml_(title) + '</div></div>' +
    '<div style="padding:20px 24px 24px;">' + inner + '</div></div></div>';
}

// ---------------------------------------------------------------------------
// Reading replies

// Returns [{ email, name, text }], one per person who replied. If someone
// replied more than once, their replies are joined in the order sent.
function collectReplies_(askSubject, lookbackDays) {
  const me = Session.getActiveUser().getEmail().toLowerCase();
  const threads = GmailApp.search('subject:"' + askSubject + '" newer_than:' + lookbackDays + 'd', 0, 200);
  const byEmail = {};
  threads.forEach(function (thread) {
    // Only the threads this script started for exactly this ask.
    if (thread.getFirstMessageSubject() !== askSubject) return;
    thread.getMessages().slice(1).forEach(function (msg) {
      if (msg.isDraft()) return;
      const sender = parseFrom_(msg.getFrom());
      // A reply sent from this account to someone else's copy isn't an answer.
      if (sender.email === me && msg.getTo().toLowerCase().indexOf(me) === -1) return;
      const text = stripQuoted_(msg.getPlainBody());
      if (!text) return;
      const entry = byEmail[sender.email] || (byEmail[sender.email] = { email: sender.email, name: sender.name, parts: [] });
      entry.parts.push({ date: msg.getDate().getTime(), text: text });
    });
  });
  return Object.keys(byEmail).map(function (k) {
    const e = byEmail[k];
    e.parts.sort(function (a, b) { return a.date - b.date; });
    return { email: e.email, name: e.name, text: e.parts.map(function (p) { return p.text; }).join('\n\n') };
  });
}

function parseFrom_(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || m[2], email: m[2].trim().toLowerCase() };
  return { name: String(from).trim(), email: String(from).trim().toLowerCase() };
}

// Keeps only what the person typed: cuts everything from the first quoted-
// reply marker on, drops ">" lines and phone signatures.
function stripQuoted_(body) {
  // Leading newline so a marker on the very first line still matches.
  let text = '\n' + String(body || '').replace(/\r\n/g, '\n');
  const cutMarkers = [
    /\n\s*On [^\n]*(\n[^\n]*){0,2}?wrote:/,  // Gmail / Apple Mail (may wrap)
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,  // Outlook
    /\n\s*_{5,}/,                               // Outlook separator line
    /\n\s*From:\s[^\n]*\n\s*(Sent|Date):/i,     // Outlook header block
  ];
  cutMarkers.forEach(function (re) {
    const m = text.match(re);
    if (m) text = text.slice(0, m.index);
  });
  text = text.split('\n')
    .filter(function (line) { return !/^\s*>/.test(line); })
    .join('\n')
    .replace(/\n\s*Sent from my [^\n]*/gi, '')
    .replace(/\n\s*Get Outlook for [^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
