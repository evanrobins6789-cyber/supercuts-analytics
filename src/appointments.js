import { readWorkbookGrid } from './parser';
import { guestKey } from './lossPrevention';

// ─── Appointments (lost guests + guest check-ins) ───────────────────────────
// From the Appointments report. User (2026-11-13): compare when cancelled,
// no-show and deleted appointments happen and what they line up with; then
// (same day) don't count one as lost when the guest was serviced anyway,
// since that's usually a stylist editing the ticket.
//
// What the data showed (Oct 21–Nov 12): 84% of "Deleted" had a sale for the
// same guest at the same store that day (82% the very same invoice number),
// 35% of cancellations and 14% of no-shows too. Sales-Accrual has no time of
// sale, so the check is same guest + same store + same day, not minutes.
//
// Every row is sorted, at upload, into:
//   C cancelled · N no-show · W walked out (a "Walked out" reason, or checked
//   in then deleted with no sale) — the real lost guests
//   F service started, then deleted, no sale that day → Loss Prevention list
//   S serviced that day anyway · X marked Incorrect/Duplicate/Test
//   U can't tell (no Sales-Accrual guest names for that store-day)
//   V a visit (any other status, in an export with every status)
// The match needs guest names from Sales-Accrual, which only the Loss
// Prevention capture keeps (as short codes, `g` in lp_sales, owner-only).
//
// Stored as `appt_history_YYYY-MM` weekly_report rows, same scoping as
// shift_history (src/scopeFilter.js). Guest names are never stored:
//   { [isoDate]: { [code]: [[minuteOfDay, status, flags], ...] },        ← C N W F V
//     ['_r:' + start + '_' + end]: { [code]: totals } }                   ← every row, plus `d`: dates checked against sales
//   flags: 1 booked in the app, 2 asked for a specific stylist, 4 first visit
// F rows with names (stylist, who deleted, times) go to lp_appt_YYYY-MM in
// the owner-only loss_prevention table instead.

export const LOST_LABEL = { C: 'Cancelled', N: 'No-shows', W: 'Walked out' };
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
const isoOf = t => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(t || '').trim()); return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null; };
const headerDate = s => { const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/.exec(s || ''); return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}` : null; };
const durMin = t => { const m = /^(\d+):(\d\d)$/.exec(String(t || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const emptyTotals = () => ({ C: 0, N: 0, W: 0, F: 0, S: 0, X: 0, U: 0, V: 0, wait: 0, app: 0, spec: 0, first: 0, n: 0, d: [] });

// Reads the file into plain rows (in memory only; names never saved).
export function parseAppointmentsGrid(grid) {
  const hdr = grid.findIndex(row => row.some(c => txt(c).toLowerCase() === 'guest name'));
  if (hdr === -1) return null;
  const col = {};
  grid[hdr].forEach((c, i) => { const k = txt(c).toLowerCase(); if (k && !(k in col)) col[k] = i; });
  if (!('center name' in col) || !('status' in col)) return null;
  const get = (row, k) => (k in col ? txt(row[col[k]]) : '');
  let start = null, end = null;
  for (let r = 0; r < hdr; r++) {
    const line = grid[r].map(txt).join(' ');
    const f = /From\s*:\s*([^T]+?)\s+To\s*:\s*(\d{1,2}\s+\w+\s+\d{4})/i.exec(line);
    if (f) { start = headerDate(f[1]); end = headerDate(f[2]); }
  }
  const rows = [];
  for (let r = hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const code = codeOf(get(row, 'center name'));
    const status = get(row, 'status');
    if (!code || !status) continue;
    const startAt = stamp(get(row, 'start time'));
    const checkin = stamp(get(row, 'checkin time'));
    const aStart = stamp(get(row, 'actual starttime'));
    const aEnd = stamp(get(row, 'actual endtime'));
    const date = isoOf(get(row, 'appointment date')) || startAt?.date || checkin?.date || null;
    if (!date) continue;
    rows.push({
      code, date, status: status.toLowerCase(), reason: get(row, 'reason'),
      guest: guestKey(get(row, 'guest name')),
      start: startAt?.min ?? null, checkin: checkin?.min ?? null, aStart: aStart?.min ?? null, aEnd: aEnd?.min ?? null,
      mins: aStart && aEnd ? Math.max(0, aEnd.min - aStart.min) : durMin(get(row, 'actual duration')),
      stylist: get(row, 'stylist'), by: get(row, 'modified by'), service: get(row, 'service name'),
      flags: (/clientapp/i.test(get(row, 'booking source')) ? 1 : 0) | (/specific/i.test(get(row, 'request type')) ? 2 : 0) | (/^y/i.test(get(row, 'first visit')) ? 4 : 0),
    });
  }
  if (!rows.length) return null;
  const dates = rows.map(x => x.date).sort();
  return { start: start || dates[0], end: end || dates[dates.length - 1], rows };
}

export async function parseAppointmentsFile(file) {
  return parseAppointmentsGrid(await readWorkbookGrid(file));
}

const LOST_STATUS = { cancelled: 1, 'no show': 1, noshow: 1, deleted: 1 };
const ADMIN = /incorrect|duplicate|test/i;

// Sort every row. salesFor(code, date) → a Set of guest codes with a ticket
// that store-day, or null if there's no Sales-Accrual guest data for it.
export function classifyAppointments(parsed, salesFor) {
  const days = {}, totals = {}, lp = {};
  const T = code => (totals[code] = totals[code] || emptyTotals());
  const checked = {};
  const push = (r, s, min) => {
    if (min == null) return;
    ((days[r.date] = days[r.date] || {})[r.code] = days[r.date][r.code] || []).push([min, s, r.flags]);
  };
  parsed.rows.forEach(r => {
    const t = T(r.code);
    t.n++;
    if (!LOST_STATUS[r.status]) { t.V++; push(r, 'V', r.checkin ?? r.start); return; }
    if (ADMIN.test(r.reason)) { t.X++; return; }
    const sold = salesFor ? salesFor(r.code, r.date) : null;
    if (!sold) { t.U++; return; }
    (checked[r.code] = checked[r.code] || new Set()).add(r.date);
    if (r.guest && sold.has(r.guest)) { t.S++; return; }
    let s;
    if (r.status === 'deleted' && r.aStart != null) s = 'F';
    else if (/^walked out/i.test(r.reason) || (r.status === 'deleted' && r.checkin != null)) s = 'W';
    else if (r.status === 'no show' && !/cancel/i.test(r.reason)) s = 'N';
    else s = 'C';
    t[s]++;
    if (s === 'W' && /long wait/i.test(r.reason)) t.wait++;
    if (s !== 'F') {
      if (r.flags & 1) t.app++;
      if (r.flags & 2) t.spec++;
      if (r.flags & 4) t.first++;
    }
    push(r, s, s === 'F' ? r.aStart : s === 'W' ? (r.checkin ?? r.start) : (r.start ?? r.checkin));
    if (s === 'F') ((lp[r.date] = lp[r.date] || {})[r.code] = lp[r.date][r.code] || []).push([r.stylist, r.by, r.service, r.checkin, r.aStart, r.aEnd, r.mins ?? 0]);
  });
  // Dates each store had sales guest data for, across the whole file range
  // (a store-day with no lost guests still counts toward its cuts).
  if (salesFor) {
    for (let d = new Date(`${parsed.start}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (iso > parsed.end) break;
      Object.keys(totals).forEach(code => { if (salesFor(code, iso)) (checked[code] = checked[code] || new Set()).add(iso); });
    }
  }
  Object.entries(checked).forEach(([code, set]) => { T(code).d = [...set].sort(); });
  return { start: parsed.start, end: parsed.end, days, totals, lp };
}

export const apptMonths = c => {
  const out = new Set([c.start.slice(0, 7), c.end.slice(0, 7), ...Object.keys(c.days).map(d => d.slice(0, 7))]);
  return [...out].sort();
};

// A month's stored row with a classified file merged in. Dates the file
// covers are replaced (the report is company-wide); stored totals for any
// range that overlaps the file's are dropped, so re-uploading never double
// counts. The file's totals live in the row for its start month.
export function mergeApptMonth(existing, c, month) {
  const out = {};
  const inFile = d => d >= c.start && d <= c.end;
  Object.entries(existing || {}).forEach(([k, v]) => {
    if (k.startsWith('_r:')) {
      const [a, b] = k.slice(3).split('_');
      if (!(a <= c.end && b >= c.start)) out[k] = v;
    } else if (!inFile(k)) out[k] = v;
  });
  Object.entries(c.days).forEach(([d, v]) => { if (d.slice(0, 7) === month) out[d] = v; });
  if (c.start.slice(0, 7) === month) out[`_r:${c.start}_${c.end}`] = c.totals;
  return out;
}

// ─── Analysis ───────────────────────────────────────────────────────────────
const HOURS = 24;
const LOST_KEYS = ['C', 'N', 'W'];
const isLost = s => s === 'C' || s === 'N' || s === 'W';
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

// apptHistory: merged appt_history rows. Uses every file range overlapping
// [start, end] (whole range). Rates are per 100 cuts over the store-days that
// were checked against sales (`d`), so unchecked days don't dilute them.
// sched: analyzeSchedules() result for busy % / time alone; shiftHistory for
// who was on at the moment.
export function analyzeAppointments({ apptHistory, start, end, cutsFor, sched = null, shiftHistory = null, codes = null }) {
  const ranges = Object.entries(apptHistory || {}).filter(([k]) => k.startsWith('_r:')).map(([k, v]) => {
    const [a, b] = k.slice(3).split('_');
    return { start: a, end: b, totals: v };
  }).filter(r => r.start <= end && r.end >= start).sort((x, y) => (x.start < y.start ? -1 : 1));
  if (!ranges.length) return null;
  const from = ranges[0].start;
  const to = ranges.reduce((m, r) => (r.end > m ? r.end : m), ranges[0].end);
  const keep = code => !codes || codes.has(code);

  const stores = {};
  const st = code => (stores[code] = stores[code] || {
    code, ...emptyTotals(), d: new Set(), cuts: 0,
    heat: { V: Array.from({ length: 7 }, () => new Array(HOURS).fill(0)), L: Array.from({ length: 7 }, () => new Array(HOURS).fill(0)) },
    daysByWd: new Array(7).fill(0), timedLost: 0,
  });
  ranges.forEach(r => Object.entries(r.totals || {}).forEach(([code, t]) => {
    if (!keep(code)) return;
    const s = st(code);
    Object.keys(emptyTotals()).forEach(k => { if (k !== 'd') s[k] += t[k] || 0; });
    (t.d || []).forEach(d => s.d.add(d));
  }));
  const checkedDates = new Set();
  Object.values(stores).forEach(s => {
    s.d.forEach(d => { s.cuts += cutsFor ? (cutsFor(s.code, d) || 0) : 0; s.daysByWd[weekdayOf(d)]++; checkedDates.add(d); });
  });

  // Timed rows on checked store-days: heat by weekday × hour, by hour, by
  // weekday, and who was on at that moment.
  const byHour = { L: new Array(HOURS).fill(0), W: new Array(HOURS).fill(0) };
  const lostByWd = new Array(7).fill(0), cutsByWd = new Array(7).fill(0);
  const atCount = { L: [0, 0, 0, 0], V: [0, 0, 0, 0], W: [0, 0, 0, 0] };
  Object.values(stores).forEach(s => s.d.forEach(d => { cutsByWd[weekdayOf(d)] += cutsFor ? (cutsFor(s.code, d) || 0) : 0; }));
  checkedDates.forEach(d => {
    const wd = weekdayOf(d);
    Object.entries((apptHistory || {})[d] || {}).forEach(([code, recs]) => {
      const s = stores[code];
      if (!keep(code) || !s || !s.d.has(d)) return;
      const shifts = shiftHistory?.[d]?.[code];
      const worked = shifts && shifts.some(r => r[5] > 0);
      recs.forEach(([min, status]) => {
        const h = Math.floor(min / 60);
        if (h < 0 || h >= HOURS) return;
        if (status === 'V') { s.heat.V[wd][h]++; if (worked) atCount.V[Math.min(3, onAt(shifts, min))]++; return; }
        if (!isLost(status)) return;
        s.heat.L[wd][h]++; byHour.L[h]++; lostByWd[wd]++; s.timedLost++;
        if (status === 'W') byHour.W[h]++;
        if (worked) {
          const n = Math.min(3, onAt(shifts, min));
          if (status !== 'C') atCount.L[n]++; // a cancellation was made ahead, so who was on then says little
          if (status === 'W') atCount.W[n]++;
        }
      });
    });
  });
  Object.values(stores).forEach(s => {
    ['V', 'L'].forEach(k => s.heat[k].forEach((row, wd) => { const n = s.daysByWd[wd] || 1; row.forEach((v, h) => { row[h] = v / n; }); }));
    s.lost = s.C + s.N + s.W;
    s.per100 = s.cuts > 0 ? { C: (s.C / s.cuts) * 100, N: (s.N / s.cuts) * 100, W: (s.W / s.cuts) * 100, all: (s.lost / s.cuts) * 100 } : null;
  });

  const list = Object.values(stores);
  const sum = k => list.reduce((t, s) => t + (s[k] || 0), 0);
  const cuts = sum('cuts');
  const company = { cuts };
  Object.keys(emptyTotals()).forEach(k => { if (k !== 'd') company[k] = sum(k); });
  company.lost = company.C + company.N + company.W;
  company.per100 = cuts > 0 ? { C: (company.C / cuts) * 100, N: (company.N / cuts) * 100, W: (company.W / cuts) * 100, all: (company.lost / cuts) * 100 } : null;
  const hasVisits = company.V > 0;

  // Share of open time at each headcount on the same store-days.
  const openAt = [0, 0, 0, 0];
  if (shiftHistory) checkedDates.forEach(d => Object.entries(shiftHistory[d] || {}).forEach(([code, recs]) => {
    if (!stores[code] || !stores[code].d.has(d) || !recs.some(r => r[5] > 0)) return;
    const ivs = recs.filter(r => r[2] != null && r[3] != null);
    if (!ivs.length) return;
    const o = Math.min(...ivs.map(r => r[2])), c = Math.max(...ivs.map(r => r[3]));
    for (let m = o; m < c; m += 15) openAt[Math.min(3, onAt(recs, m))]++;
  }));

  const findings = [];
  const pct = v => `${Math.round(v * 100)}%`;
  const fmt1 = v => v.toFixed(1);
  const marked = company.lost + company.F + company.S + company.X;
  if (marked) {
    findings.push({ kind: 'info', text: `Of ${marked.toLocaleString()} appointments marked cancelled, no-show or deleted, ${company.S.toLocaleString()} (${pct(company.S / marked)}) were serviced at that store the same day anyway (mostly ticket edits) and ${company.X.toLocaleString()} were marked incorrect, duplicate or test. Those aren't counted.${company.U ? ` ${company.U.toLocaleString()} more couldn't be checked (no Sales-Accrual guest names for those days) and are left out too.` : ''}` });
  }
  if (company.per100) {
    findings.push({ kind: 'total', text: `Real lost guests per 100 cuts: ${fmt1(company.per100.C)} cancelled, ${fmt1(company.per100.N)} no-shows, ${fmt1(company.per100.W)} walked out (${company.lost.toLocaleString()} in all).${company.wait ? ` ${company.wait} walkouts were marked "long wait".` : ''}` });
  }
  if (company.F) findings.push({ kind: 'payroll', text: `${company.F} service${company.F === 1 ? ' was' : 's were'} started, then deleted, with no sale for that guest that day. They're listed on the Loss Prevention tab.` });
  // When.
  const lostTimed = byHour.L.reduce((a, b) => a + b, 0);
  if (lostTimed >= 30) {
    let best = 0, bestH = 0;
    for (let h = 0; h < HOURS - 2; h++) { const w = byHour.L[h] + byHour.L[h + 1] + byHour.L[h + 2]; if (w > best) { best = w; bestH = h; } }
    findings.push({ kind: 'when', text: `Lost guests bunch up ${hourText(bestH)}–${hourText(bestH + 3)}: ${pct(best / lostTimed)} of them.${hasVisits ? '' : ' Guests come in most then too, so that alone isn\'t a problem.'}` });
  }
  const wdRates = lostByWd.map((n, wd) => ({ wd, n, rate: cutsByWd[wd] > 0 ? (n / cutsByWd[wd]) * 100 : null })).filter(x => x.rate != null && cutsByWd[x.wd] >= 200);
  if (wdRates.length >= 4) {
    const avg = (wdRates.reduce((t, x) => t + x.n, 0) / wdRates.reduce((t, x) => t + cutsByWd[x.wd], 0)) * 100;
    const top = [...wdRates].sort((a, b) => b.rate - a.rate)[0];
    const nDays = [...checkedDates].filter(d => weekdayOf(d) === top.wd).length;
    if (top.rate >= avg * 1.2) findings.push({ kind: 'when', text: `${DAYS_LONG[top.wd]}s lose the most for the cuts done: ${fmt1(top.rate)} per 100 cuts vs ${fmt1(avg)} on an average day${nDays <= 2 ? ` (only ${nDays} ${DAYS_LONG[top.wd]}${nDays === 1 ? '' : 's'} so far)` : ''}.` });
  }
  // Staffing at the moment (walkouts first: they're the ones staffing can fix).
  const openTot = openAt.reduce((a, b) => a + b, 0);
  const useW = atCount.W.reduce((a, b) => a + b, 0) >= 30;
  const at = useW ? atCount.W : atCount.L;
  const atTot = at.reduce((a, b) => a + b, 0);
  const what = useW ? 'walkouts' : 'no-shows and walkouts';
  if (atTot >= 30 && openTot) {
    if (hasVisits && atCount.V.reduce((a, b) => a + b, 0) >= 30) {
      const rate = i => (at[i] + atCount.V[i] > 0 ? at[i] / (at[i] + atCount.V[i]) : null);
      const r1 = rate(1), r3 = rate(3);
      if (r1 != null && r3 != null) findings.push({ kind: r1 > r3 * 1.2 ? 'staff' : 'info', text: `Of guests who came in with one person on, ${pct(r1)} became ${what}, vs ${pct(r3)} with 3+ on.${r1 > r3 * 1.2 ? ' Time alone is costing guests.' : ''}` });
    } else {
      const s1 = at[1] / atTot, o1 = openAt[1] / openTot, s0 = at[0] / atTot;
      findings.push({ kind: s1 > o1 * 1.2 ? 'staff' : 'info', text: s1 > o1 * 1.2
        ? `${pct(s1)} of ${what} came while one person was on, though one person is on only ${pct(o1)} of open hours. Time alone looks like it's losing guests.`
        : `${pct(s1)} of ${what} came while one person was on (one person is on ${pct(o1)} of open hours), so time alone doesn't stand out.` });
      if (s0 >= 0.03) findings.push({ kind: 'staff', text: `${pct(s0)} came while nobody was clocked in.` });
    }
  }
  // Store-level links.
  if (sched) {
    const pts = list.filter(s => s.cuts >= 50 && s.per100 && sched.stores[s.code] && sched.stores[s.code].busy != null);
    if (pts.length >= 10) {
      const tests = [
        ['how busy the store runs (busy %)', s => sched.stores[s.code].busy],
        ['time with one person alone', s => sched.stores[s.code].soloPerWeek],
        ['staff hours per week', s => sched.stores[s.code].hoursPerWeek],
        ['bookings made in the app', s => (s.lost ? s.app / s.lost : 0)],
      ];
      const links = [];
      [['W', 'walkouts'], ['N', 'no-shows'], ['C', 'cancellations']].forEach(([k, label]) => tests.forEach(([whatX, fn]) => {
        const r = pearson(pts.map(s => s.per100[k]), pts.map(fn));
        if (r != null && Math.abs(r) >= 0.3) links.push({ r, text: `Stores with more ${whatX} have ${r > 0 ? 'more' : 'fewer'} ${label} per cut (r = ${r.toFixed(2)}, ${Math.abs(r) >= 0.5 ? 'a clear link' : 'a modest link'}).` });
      }));
      links.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 3).forEach(l => findings.push({ kind: 'link', text: l.text }));
      if (!links.length) findings.push({ kind: 'info', text: `Across ${pts.length} stores, no strong link between lost guests and busy %, time alone or staff hours (all |r| < 0.3).` });
    }
  }
  if (company.lost >= 50) findings.push({ kind: 'who', text: `Of the real lost guests, ${pct(company.app / company.lost)} booked in the app, ${pct(company.spec / company.lost)} asked for a specific stylist, ${pct(company.first / company.lost)} were first visits.` });
  const worst = list.filter(s => s.cuts >= 50 && s.per100).sort((a, b) => b.per100.all - a.per100.all).slice(0, 3);
  if (worst.length && company.per100) findings.push({ kind: 'stores', text: `Most lost per 100 cuts: ${worst.map(s => `{${s.code}} ${fmt1(s.per100.all)}`).join(', ')} (company ${fmt1(company.per100.all)}).` });

  return { from, to, stores, company, findings, hasVisits, byHour, timedLost: lostTimed };
}

// What to say about one store.
export function storeApptFindings(a, code) {
  const s = a?.stores?.[code];
  if (!s || !s.per100) return [];
  const out = [];
  const c = a.company.per100;
  const vs = (v, base) => (base ? (v >= base * 1.25 ? 'well above' : v <= base * 0.75 ? 'well below' : 'about the same as') : '');
  out.push({ kind: 'total', text: `${s.lost} lost guests for ${s.cuts.toLocaleString()} cuts: ${s.per100.C.toFixed(1)} cancelled, ${s.per100.N.toFixed(1)} no-shows, ${s.per100.W.toFixed(1)} walked out per 100 cuts, ${vs(s.per100.all, c.all)} the company's ${c.all.toFixed(1)}.${s.S ? ` (${s.S} more were serviced the same day and aren't counted.)` : ''}` });
  if (s.wait) out.push({ kind: 'staff', text: `${s.wait} walked out over a long wait.` });
  if (s.F) out.push({ kind: 'payroll', text: `${s.F} service${s.F === 1 ? '' : 's'} started then deleted with no sale (see Loss Prevention).` });
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
  const lines = ['', `LOST GUESTS (Appointments report, ${a.from} to ${a.to}). Rows marked cancelled/no-show/deleted were checked against Sales-Accrual: if the same guest had a sale at that store that day (usually a ticket edit) or the row was marked incorrect/duplicate/test, it is NOT counted. "Walked out" = a walked-out reason, or checked in then deleted with no sale. Times are the appointment start (check-in for walkouts):`];
  a.findings.forEach(f => lines.push(`- ${f.text.replace(/\{(\d+)\}/g, (_, c) => storeName(c))}`));
  Object.values(a.stores).filter(s => s.per100).sort((x, y) => y.per100.all - x.per100.all).forEach(s => {
    lines.push(`${storeName(s.code)}: ${s.C} cancelled, ${s.N} no-shows, ${s.W} walked out${s.wait ? ` (${s.wait} long wait)` : ''}, ${s.cuts} cuts (${s.per100.all.toFixed(1)} lost per 100 cuts); ${s.S} serviced anyway, ${s.F} started-then-deleted.`);
  });
  return lines.join('\n');
}
