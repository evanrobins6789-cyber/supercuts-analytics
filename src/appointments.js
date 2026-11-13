import { readWorkbookGrid } from './parser';

// ─── Appointments (lost guests + guest check-ins) ───────────────────────────
// From the Appointments report. User (2026-11-13): compare when cancelled,
// no-show and deleted appointments happen, look for anything they line up
// with, and show guest visits on the Scheduling heat map.
//
// The report has no appointment date/time column. What it has:
//   Checkin Time  — set on most Deleted rows (checked in, then removed:
//                   usually a walkout) and some No Shows; almost never on
//                   Cancelled. A full export (every status) also gives each
//                   completed visit's check-in, which is what the Guests
//                   heat map needs.
//   Status, Booking Source (ClientApp/Zenoti), Request Type (Specific/Any),
//   First Visit, Center Name.
// Guest names are never stored.
//
// Stored as `appt_history_YYYY-MM` weekly_report rows, same scoping as
// shift_history (src/scopeFilter.js):
//   { [isoDate]: { [code]: [[minuteOfDay, status, flags], ...] },
//     ['_r:' + start + '_' + end]: { [code]: totals } }   ← every row of a file, timed or not
//   status: 'V' visit (any status but the three below), 'C' cancelled, 'N' no show, 'D' deleted
//   flags: 1 booked in the app, 2 asked for a specific stylist, 4 first visit

const LOST = { cancelled: 'C', 'no show': 'N', noshow: 'N', deleted: 'D' };
export const LOST_LABEL = { C: 'Cancelled', N: 'No-shows', D: 'Deleted' };
const txt = c => String(c?.w ?? c?.v ?? '').trim();
const pad = n => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const codeOf = t => { const m = String(t).match(/^\s*(\d+)/); return m ? String(parseInt(m[1], 10)) : null; };
function stamp(t) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d\d)\s*([AP]M)/i.exec(String(t || ''));
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') h += 12;
  return { date: `${m[3]}-${pad(m[1])}-${pad(m[2])}`, min: h * 60 + Number(m[5]) };
}
const headerDate = s => { const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/.exec(s || ''); return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}` : null; };
const emptyTotals = () => ({ C: 0, N: 0, D: 0, V: 0, app: 0, spec: 0, first: 0, n: 0 });

export function parseAppointmentsGrid(grid) {
  const hdr = grid.findIndex(row => row.some(c => txt(c).toLowerCase() === 'guest name'));
  if (hdr === -1) return null;
  const col = {};
  grid[hdr].forEach((c, i) => { const k = txt(c).toLowerCase(); if (k && !(k in col)) col[k] = i; });
  if (!('center name' in col) || !('status' in col)) return null;
  // "Appointments  From : 01 Nov 2026  To : 12 Nov 2026 ..."
  let start = null, end = null;
  for (let r = 0; r < hdr; r++) {
    const line = grid[r].map(txt).join(' ');
    const f = /From\s*:\s*([^T]+?)\s+To\s*:\s*(\d{1,2}\s+\w+\s+\d{4})/i.exec(line);
    if (f) { start = headerDate(f[1]); end = headerDate(f[2]); }
  }
  const days = {}, totals = {};
  let rows = 0, timed = 0;
  for (let r = hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const code = codeOf(txt(row[col['center name']]));
    const status = txt(row[col.status]);
    if (!code || !status) continue;
    const s = LOST[status.toLowerCase()] || 'V';
    const flags = (/clientapp/i.test(txt(row[col['booking source']])) ? 1 : 0)
      | (/specific/i.test(txt(row[col['request type']])) ? 2 : 0)
      | (/^y/i.test(txt(row[col['first visit']])) ? 4 : 0);
    const t = totals[code] = totals[code] || emptyTotals();
    t[s]++; t.n++;
    if (flags & 1) t.app++;
    if (flags & 2) t.spec++;
    if (flags & 4) t.first++;
    rows++;
    const at = stamp(txt(row[col['checkin time']]));
    if (at) {
      ((days[at.date] = days[at.date] || {})[code] = days[at.date][code] || []).push([at.min, s, flags]);
      timed++;
    }
  }
  if (!rows) return null;
  const dates = Object.keys(days).sort();
  start = start || dates[0] || null;
  end = end || dates[dates.length - 1] || null;
  return { start, end, days, totals, rows, timed };
}

export async function parseAppointmentsFile(file) {
  return parseAppointmentsGrid(await readWorkbookGrid(file));
}

export const apptMonths = parsed => {
  const out = new Set([parsed.start.slice(0, 7), parsed.end.slice(0, 7), ...Object.keys(parsed.days).map(d => d.slice(0, 7))]);
  return [...out].sort();
};

// A month's stored row with a file merged in. Dates the file covers are
// replaced (the report is company-wide); stored totals for any range that
// overlaps the file's are dropped, so re-uploading never double counts.
// The file's totals live in the row for its start month.
export function mergeApptMonth(existing, parsed, month) {
  const out = {};
  const inFile = d => d >= parsed.start && d <= parsed.end;
  Object.entries(existing || {}).forEach(([k, v]) => {
    if (k.startsWith('_r:')) {
      const [a, b] = k.slice(3).split('_');
      if (!(a <= parsed.end && b >= parsed.start)) out[k] = v;
    } else if (!inFile(k)) out[k] = v;
  });
  Object.entries(parsed.days).forEach(([d, v]) => { if (d.slice(0, 7) === month) out[d] = v; });
  if (parsed.start.slice(0, 7) === month) out[`_r:${parsed.start}_${parsed.end}`] = parsed.totals;
  return out;
}

// ─── Analysis ───────────────────────────────────────────────────────────────
const HOURS = 24;
const datesBetween = (a, b) => { const out = []; const d = new Date(`${a}T12:00:00`); const e = new Date(`${b}T12:00:00`); while (d <= e) { out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`); d.setDate(d.getDate() + 1); } return out; };
const weekdayOf = iso => new Date(`${iso}T12:00:00`).getDay();
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourText = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

// People clocked in at one minute, from a shift_history store-day.
function onAt(recs, min) {
  let n = 0;
  (recs || []).forEach(r => {
    const s = r[4] || [];
    for (let i = 0; i < s.length; i += 2) {
      const a = s[i];
      const b = s[i + 1] == null ? (r[3] != null && r[3] > a ? r[3] : a + Math.max(0, r[5] * 60)) : s[i + 1];
      if (min >= a && min < b) { n++; return; }
    }
  });
  return n;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  a.forEach((v, i) => { sab += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; });
  return sa && sb ? sab / Math.sqrt(sa * sb) : null;
}

// apptHistory: merged appt_history rows. Uses every file range that overlaps
// [start, end] (whole range, since cancellations carry no date). cutsFor(code,
// date) → haircuts, for rates per 100 cuts. sched: analyzeSchedules() result
// for the same dates (busy %, time alone) and shiftHistory for headcount.
export function analyzeAppointments({ apptHistory, start, end, cutsFor, sched = null, shiftHistory = null, codes = null }) {
  const ranges = Object.entries(apptHistory || {}).filter(([k]) => k.startsWith('_r:')).map(([k, v]) => {
    const [a, b] = k.slice(3).split('_');
    return { start: a, end: b, totals: v };
  }).filter(r => r.start <= end && r.end >= start).sort((x, y) => (x.start < y.start ? -1 : 1));
  if (!ranges.length) return null;
  const covered = new Set(ranges.flatMap(r => datesBetween(r.start, r.end)));
  const from = ranges[0].start;
  const to = ranges.reduce((m, r) => (r.end > m ? r.end : m), ranges[0].end);
  const keep = code => !codes || codes.has(code);

  const stores = {};
  const st = code => (stores[code] = stores[code] || {
    code, ...emptyTotals(), cuts: 0,
    heat: { V: Array.from({ length: 7 }, () => new Array(HOURS).fill(0)), L: Array.from({ length: 7 }, () => new Array(HOURS).fill(0)) },
    daysByWd: new Array(7).fill(0), timedLost: 0,
  });
  ranges.forEach(r => Object.entries(r.totals || {}).forEach(([code, t]) => {
    if (!keep(code)) return;
    const s = st(code);
    ['C', 'N', 'D', 'V', 'app', 'spec', 'first', 'n'].forEach(k => { s[k] += t[k] || 0; });
  }));
  Object.values(stores).forEach(s => {
    covered.forEach(d => {
      s.cuts += cutsFor ? (cutsFor(s.code, d) || 0) : 0;
      s.daysByWd[weekdayOf(d)]++;
    });
  });

  // Timed rows: heat by weekday × hour, and headcount at the moment.
  const byHour = { L: new Array(HOURS).fill(0), V: new Array(HOURS).fill(0) };
  const lostByWd = new Array(7).fill(0);
  const cutsByWd = new Array(7).fill(0);
  const atCount = { L: [0, 0, 0, 0], V: [0, 0, 0, 0] }; // 0, 1, 2, 3+ people on
  let matched = 0;
  covered.forEach(d => {
    const wd = weekdayOf(d);
    Object.values(stores).forEach(s => { cutsByWd[wd] += cutsFor ? (cutsFor(s.code, d) || 0) : 0; });
    Object.entries((apptHistory || {})[d] || {}).forEach(([code, recs]) => {
      if (!keep(code) || !stores[code]) return;
      const s = stores[code];
      const shifts = shiftHistory?.[d]?.[code];
      recs.forEach(([min, status]) => {
        const h = Math.floor(min / 60);
        if (h < 0 || h >= HOURS) return;
        const kind = status === 'V' ? 'V' : status === 'C' ? null : 'L'; // timed cancellations are too few to use
        if (!kind) return;
        s.heat[kind][wd][h]++;
        byHour[kind][h]++;
        if (kind === 'L') { lostByWd[wd]++; s.timedLost++; }
        if (shifts && shifts.some(r => r[5] > 0)) { atCount[kind][Math.min(3, onAt(shifts, min))]++; if (kind === 'L') matched++; }
      });
    });
  });
  // Average per day of that weekday.
  Object.values(stores).forEach(s => {
    ['V', 'L'].forEach(k => s.heat[k].forEach((row, wd) => { const n = s.daysByWd[wd] || 1; row.forEach((v, h) => { row[h] = v / n; }); }));
    s.per100 = s.cuts > 0 ? { C: (s.C / s.cuts) * 100, N: (s.N / s.cuts) * 100, D: (s.D / s.cuts) * 100, all: ((s.C + s.N + s.D) / s.cuts) * 100 } : null;
    s.lost = s.C + s.N + s.D;
  });

  const list = Object.values(stores);
  const sum = k => list.reduce((t, s) => t + (s[k] || 0), 0);
  const cuts = sum('cuts');
  const company = {
    C: sum('C'), N: sum('N'), D: sum('D'), V: sum('V'), cuts, n: sum('n'),
    app: sum('app'), spec: sum('spec'), first: sum('first'),
    per100: cuts > 0 ? { C: (sum('C') / cuts) * 100, N: (sum('N') / cuts) * 100, D: (sum('D') / cuts) * 100, all: ((sum('C') + sum('N') + sum('D')) / cuts) * 100 } : null,
  };
  const hasVisits = company.V > 0;

  // Share of open time at each headcount, from the same store-days, to
  // compare against where the lost guests fall.
  const openAt = [0, 0, 0, 0];
  if (shiftHistory) covered.forEach(d => Object.entries(shiftHistory[d] || {}).forEach(([code, recs]) => {
    if (!stores[code] || !recs.some(r => r[5] > 0)) return;
    const ivs = recs.filter(r => r[2] != null && r[3] != null);
    if (!ivs.length) return;
    const o = Math.min(...ivs.map(r => r[2])), c = Math.max(...ivs.map(r => r[3]));
    for (let m = o; m < c; m += 15) openAt[Math.min(3, onAt(recs, m))]++;
  }));

  const findings = [];
  const pct = v => `${Math.round(v * 100)}%`;
  const fmt1 = v => v.toFixed(1);
  if (company.per100) {
    findings.push({ kind: 'total', text: `For every 100 cuts: ${fmt1(company.per100.D)} deleted, ${fmt1(company.per100.N)} no-shows and ${fmt1(company.per100.C)} cancelled (${company.C + company.N + company.D} in all, ${from} to ${to}).` });
  }
  // When: peak hours of lost guests.
  const lostTimed = byHour.L.reduce((a, b) => a + b, 0);
  if (lostTimed >= 30) {
    let best = 0, bestH = 0;
    for (let h = 0; h < HOURS - 2; h++) { const w = byHour.L[h] + byHour.L[h + 1] + byHour.L[h + 2]; if (w > best) { best = w; bestH = h; } }
    findings.push({ kind: 'when', text: `Deleted check-ins and no-shows bunch up ${hourText(bestH)}–${hourText(bestH + 3)}: ${pct(best / lostTimed)} of the ones with a time.${hasVisits ? '' : ' (Guests come in most then too, so this alone doesn\'t mean anything went wrong.)'}` });
  }
  // Which weekday, per 100 cuts.
  const wdRates = lostByWd.map((n, wd) => ({ wd, n, rate: cutsByWd[wd] > 0 ? (n / cutsByWd[wd]) * 100 : null })).filter(x => x.rate != null && cutsByWd[x.wd] >= 200);
  if (wdRates.length >= 4) {
    const avg = wdRates.reduce((t, x) => t + x.n, 0) / wdRates.reduce((t, x) => t + cutsByWd[x.wd], 0) * 100;
    const top = [...wdRates].sort((a, b) => b.rate - a.rate)[0];
    const nDays = [...covered].filter(d => weekdayOf(d) === top.wd).length;
    if (top.rate >= avg * 1.2) findings.push({ kind: 'when', text: `${DAYS_LONG[top.wd]}s lose the most for the cuts done: ${fmt1(top.rate)} deleted/no-shows per 100 cuts vs ${fmt1(avg)} on an average day${nDays <= 2 ? ` (only ${nDays} ${DAYS_LONG[top.wd]}${nDays === 1 ? '' : 's'} so far)` : ''}.` });
  }
  // Staffing at the moment it happened.
  const lostAt = atCount.L.reduce((a, b) => a + b, 0);
  const openTot = openAt.reduce((a, b) => a + b, 0);
  if (lostAt >= 30 && openTot) {
    if (hasVisits && atCount.V.reduce((a, b) => a + b, 0) >= 30) {
      const rate = i => (atCount.L[i] + atCount.V[i] > 0 ? atCount.L[i] / (atCount.L[i] + atCount.V[i]) : null);
      const r1 = rate(1), r3 = rate(3);
      if (r1 != null && r3 != null) findings.push({ kind: r1 > r3 * 1.2 ? 'staff' : 'info', text: `Of guests who checked in with one person on, ${pct(r1)} were deleted or no-showed, vs ${pct(r3)} with 3+ on.${r1 > r3 * 1.2 ? ' Time alone is costing guests.' : ''}` });
    } else {
      const shareLost1 = atCount.L[1] / lostAt, shareOpen1 = openAt[1] / openTot;
      const shareLost0 = atCount.L[0] / lostAt;
      findings.push({ kind: shareLost1 > shareOpen1 * 1.2 ? 'staff' : 'info', text: shareLost1 > shareOpen1 * 1.2
        ? `${pct(shareLost1)} of deleted check-ins and no-shows came while one person was on, though one person is on only ${pct(shareOpen1)} of open hours. Time alone looks like it's losing guests.`
        : `${pct(shareLost1)} of deleted check-ins and no-shows came while one person was on (one person is on ${pct(shareOpen1)} of open hours), so time alone doesn't stand out. Most come when 2–3 are on, which is also when guests come in.` });
      if (shareLost0 >= 0.03) findings.push({ kind: 'staff', text: `${pct(shareLost0)} came while nobody was clocked in.` });
    }
  }
  // Store-level links.
  if (sched) {
    const pts = list.filter(s => s.cuts >= 50 && s.per100 && sched.stores[s.code] && sched.stores[s.code].busy != null);
    if (pts.length >= 10) {
      const tests = [
        ['busy', 'how busy the store runs (busy %)', s => sched.stores[s.code].busy],
        ['solo', 'time with one person alone', s => sched.stores[s.code].soloPerWeek],
        ['hours', 'staff hours per week', s => sched.stores[s.code].hoursPerWeek],
        ['app', 'share booked in the app', s => (s.n ? s.app / s.n : 0)],
      ];
      const links = [];
      [['D', 'deleted'], ['N', 'no-shows'], ['C', 'cancellations']].forEach(([k, label]) => tests.forEach(([, what, fn]) => {
        const r = pearson(pts.map(s => s.per100[k]), pts.map(fn));
        if (r != null && Math.abs(r) >= 0.3) links.push({ r, text: `Stores with more ${what} have ${r > 0 ? 'more' : 'fewer'} ${label} per cut (r = ${r.toFixed(2)}, ${Math.abs(r) >= 0.5 ? 'a clear link' : 'a modest link'}).` });
      }));
      links.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 3).forEach(l => findings.push({ kind: 'link', text: l.text }));
      if (!links.length) findings.push({ kind: 'info', text: `Across ${pts.length} stores, no strong link between lost guests and busy %, time alone or staff hours (all |r| < 0.3). It's more store by store than a staffing pattern.` });
    }
  }
  // Who: booking source / request / first visit.
  if (company.n >= 50) {
    findings.push({ kind: 'who', text: `${pct(company.app / company.n)} were booked in the app, ${pct(company.spec / company.n)} asked for a specific stylist, ${pct(company.first / company.n)} were first visits.` });
  }
  // Worst stores.
  const worst = list.filter(s => s.cuts >= 50 && s.per100).sort((a, b) => b.per100.all - a.per100.all).slice(0, 3);
  if (worst.length && company.per100) findings.push({ kind: 'stores', codes: worst.map(s => s.code), text: `Most lost per 100 cuts: ${worst.map(s => `{${s.code}} ${fmt1(s.per100.all)}`).join(', ')} (company ${fmt1(company.per100.all)}).` });

  return { from, to, stores, company, findings, hasVisits, byHour, timedLost: lostTimed, matched };
}

// What to say about one store.
export function storeApptFindings(a, code) {
  const s = a?.stores?.[code];
  if (!s || !s.per100) return [];
  const out = [];
  const c = a.company.per100;
  const vs = (v, base) => (base ? (v >= base * 1.25 ? 'well above' : v <= base * 0.75 ? 'well below' : 'about the same as') : '');
  out.push({ kind: 'total', text: `${s.lost} lost guests for ${s.cuts.toLocaleString()} cuts: ${s.per100.D.toFixed(1)} deleted, ${s.per100.N.toFixed(1)} no-shows, ${s.per100.C.toFixed(1)} cancelled per 100 cuts, ${vs(s.per100.all, c.all)} the company's ${c.all.toFixed(1)}.` });
  if (s.timedLost >= 8) {
    const cells = [];
    s.heat.L.forEach((row, wd) => row.forEach((v, h) => { if (v > 0) cells.push({ wd, h, v }); }));
    cells.sort((x, y) => y.v - x.v);
    const top = cells.slice(0, 2).map(x => `${DAYS_LONG[x.wd]}s ${hourText(x.h)}`);
    if (top.length) out.push({ kind: 'when', text: `Most often around ${top.join(' and ')}.` });
  }
  return out;
}

// ─── Tilly ──────────────────────────────────────────────────────────────────
export function appointmentsContext(a, storeName) {
  if (!a) return '';
  const lines = ['', `LOST GUESTS (Appointments report, ${a.from} to ${a.to}: cancelled, no-show and deleted appointments; "deleted" is mostly guests who checked in and were removed, likely walkouts. The report has no appointment time, so "when" only covers rows with a check-in time):`];
  a.findings.forEach(f => lines.push(`- ${f.text.replace(/\{(\d+)\}/g, (_, c) => storeName(c))}`));
  Object.values(a.stores).filter(s => s.per100).sort((x, y) => y.per100.all - x.per100.all).forEach(s => {
    lines.push(`${storeName(s.code)}: ${s.D} deleted, ${s.N} no-shows, ${s.C} cancelled, ${s.cuts} cuts (${s.per100.all.toFixed(1)} lost per 100 cuts).`);
  });
  return lines.join('\n');
}
