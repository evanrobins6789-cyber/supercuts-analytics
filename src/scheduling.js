import React, { useEffect, useMemo, useState } from 'react';
import { readWorkbookGrid } from './parser';
import { analyzeAppointments, lostForSchedules, DOOR_MINUTES } from './appointments';

// ─── Scheduling tab ─────────────────────────────────────────────────────────
// Hours, coverage gaps and payroll, from the Attendance report's shift times
// (Schedule + Actual Check-Ins). User (2026-11-10): a tab on hours and gaps
// in the schedule, with tips to grow sales or watch payroll, flagging stores
// with too many people on at certain times — and a suggested cut must never
// leave someone working alone.
//
// Stored as `shift_history_YYYY-MM` weekly_report rows, written by the
// Attendance upload in Setup → Historical Import:
//   { [isoDate]: { [storeCode]: [ [name, job, schedIn, schedOut, segs, actual, serviced, schedHours], ... ] } }
//   job: 'S' stylist, 'M' manager, 'R' receptionist, 'O' other
//   schedIn/schedOut: minutes after midnight (null when unscheduled)
//   segs: flat [in, out, in, out, ...] minutes; out is null on a missed checkout
// Read through api/scoped-data (owner all, DL/manager own stores, employee
// nothing: src/scopeFilter.js).

const SLOT = 15;                 // minutes per timeline slot
const SLOTS = (24 * 60) / SLOT;  // 96
export const MIN_ON_AFTER_CUT = 2;   // the user's rule: a cut never leaves one person alone
const MIN_SHIFT_HOURS = 4;       // a suggested cut never shortens a shift below this (display choice)
const BUSY_GAP_PTS = 0.15;       // "much busier than target" for the add-coverage tip (display choice)
const OVER_SCHED_FLAG_MIN = 15;  // minutes past schedule that count as "stayed late" (display choice)
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Parsing ────────────────────────────────────────────────────────────────
const txt = c => String(c?.w ?? c?.v ?? '').trim();
const num = c => { const v = c?.v; if (typeof v === 'number') return v; const n = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const codeOf = t => { const m = String(t).match(/^\s*(\d+)/); return m ? String(parseInt(m[1], 10)) : null; };
const isoOf = t => { const m = String(t).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
export function clockToMin(s) {
  const m = /(\d{1,2}):(\d\d)\s*([AP]M)/i.exec(String(s || ''));
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
function parseRange(s) {
  const [a, b] = String(s || '').split(' - ');
  return [clockToMin(a), clockToMin(b)];
}
const jobLetter = j => (/^stylist/i.test(j) ? 'S' : /^manager/i.test(j) ? 'M' : /^reception/i.test(j) ? 'R' : 'O');

// Grid from parser.js's sheetToGrid. Returns { days, rangeStart, rangeEnd, shifts }
// or null when the file has no Actual Check-Ins column (older layouts).
export function parseShiftGrid(grid) {
  const hdr = grid.findIndex(row => row.some(c => txt(c).toLowerCase() === 'employee name'));
  if (hdr === -1) return null;
  const col = {};
  grid[hdr].forEach((c, i) => { const k = txt(c).toLowerCase(); if (k && !(k in col)) col[k] = i; });
  const need = ['date', 'employee name', 'work center', 'schedule', 'actual check-ins', 'actual hours'];
  if (need.some(k => !(k in col))) return null;
  const days = {};
  let shifts = 0;
  for (let r = hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const date = isoOf(txt(row[col.date]));
    const code = codeOf(txt(row[col['work center']]));
    const name = txt(row[col['employee name']]).replace(/\s+/g, ' ');
    if (!date || !code || !name) continue;
    const [sIn, sOut] = parseRange(txt(row[col.schedule]).split(',')[0]);
    const segs = [];
    txt(row[col['actual check-ins']]).split(',').forEach(part => {
      const [a, b] = parseRange(part);
      if (a != null) segs.push(a, b);
    });
    const rec = [name, jobLetter(txt(row[col.job])), sIn, sOut, segs,
      r2(num(row[col['actual hours']])),
      'serviced hours' in col ? r2(num(row[col['serviced hours']])) : 0,
      'scheduled hours' in col ? r2(num(row[col['scheduled hours']])) : 0];
    ((days[date] = days[date] || {})[code] = days[date][code] || []).push(rec);
    shifts++;
  }
  const dates = Object.keys(days).sort();
  return { days, shifts, rangeStart: dates[0] || null, rangeEnd: dates[dates.length - 1] || null };
}

export async function parseShiftFile(file) {
  return parseShiftGrid(await readWorkbookGrid(file));
}

// One month's stored row with a parsed file merged in: every date the file
// covers is replaced whole (the report is company-wide), others kept.
export function mergeShiftMonth(existing, parsed, month) {
  const out = {};
  const inFile = d => d >= parsed.rangeStart && d <= parsed.rangeEnd;
  Object.entries(existing || {}).forEach(([d, v]) => { if (!inFile(d)) out[d] = v; });
  // A file pulled before a day was over has that day's schedule with no
  // clock-ins. Don't let it replace a store-day that already has clock-ins
  // (an older file uploaded after a newer one).
  const hasHours = recs => (recs || []).some(r => r[5] > 0);
  Object.entries(parsed.days).forEach(([d, v]) => {
    if (d.slice(0, 7) !== month) return;
    const prev = (existing || {})[d] || {};
    const day = { ...v };
    Object.entries(prev).forEach(([code, recs]) => {
      if (hasHours(recs) && !hasHours(day[code])) day[code] = recs;
    });
    out[d] = day;
  });
  return out;
}

// ─── Timelines ──────────────────────────────────────────────────────────────
const slotOf = m => Math.max(0, Math.min(SLOTS, Math.round(m / SLOT)));

// The slots one person actually worked: [[startSlot, endSlot), ...].
function workedIntervals(rec) {
  const [, , sIn, sOut, segs, actual] = rec;
  const out = [];
  if (segs && segs.length) {
    let used = 0;
    for (let i = 0; i < segs.length; i += 2) {
      const a = segs[i];
      let b = segs[i + 1];
      if (b == null) { // missed checkout: schedule end, else the rest of their hours
        b = sOut != null && sOut > a ? sOut : a + Math.max(0, actual * 60 - used);
      }
      if (b > a) { out.push([slotOf(a), slotOf(b)]); used += b - a; }
    }
  } else if (actual > 0 && sIn != null && sOut != null && sOut > sIn) {
    out.push([slotOf(sIn), slotOf(sOut)]);
  }
  return out.filter(([a, b]) => b > a);
}
const schedInterval = rec => (rec[2] != null && rec[3] != null && rec[3] > rec[2] ? [slotOf(rec[2]), slotOf(rec[3])] : null);

function countsFrom(intervalLists) {
  const c = new Array(SLOTS).fill(0);
  intervalLists.forEach(list => list.forEach(([a, b]) => { for (let s = a; s < b; s++) c[s]++; }));
  return c;
}

export const slotLabel = s => {
  const m = s * SLOT;
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, '0');
  return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
};
const hourLabel = s => { const h = Math.floor((s * SLOT) / 60) % 24; return `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`; };
const weekdayOf = iso => new Date(`${iso}T12:00:00`).getDay();
const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Runs of slots in [lo, hi) where test(count) holds, as "9:00 AM–10:30 AM".
function runsWhere(counts, lo, hi, test) {
  const runs = [];
  let start = null;
  for (let s = lo; s <= hi; s++) {
    const on = s < hi && test(counts[s]);
    if (on && start == null) start = s;
    if (!on && start != null) { runs.push([start, s]); start = null; }
  }
  return runs;
}
const runText = ([a, b]) => `${slotLabel(a)}–${slotLabel(b)}`;

// ─── The safe-trim plan ─────────────────────────────────────────────────────
// Trim scheduled shifts from their start or end edge, 15 minutes at a time,
// only where 3+ people are scheduled, so every slot keeps at least
// MIN_ON_AFTER_CUT people. Slots already at 1 or 2 are never touched, and no
// shift goes under MIN_SHIFT_HOURS. Takes the most-overlapped edge first and
// stops once `targetHours` are trimmed.
// `scheduled: true` is for a day that hasn't happened yet: everyone on the
// schedule counts as coverage (there are no clock-ins to go by).
export function safeTrimPlan(recs, targetHours, { scheduled = false } = {}) {
  // Past days: only people who actually worked that day. A call-out's
  // scheduled shift isn't real coverage, so counting it could leave someone alone.
  const worked = recs.map((r, idx) => ({ r, idx })).filter(({ r }) => scheduled || r[5] > 0 || (r[4] && r[4].length));
  const people = worked.map(({ r, idx }) => ({ name: r[0], idx, iv: schedInterval(r) })).filter(p => p.iv && p.iv[1] > p.iv[0]);
  const counts = countsFrom(people.map(p => [p.iv]));
  const minSlots = (MIN_SHIFT_HOURS * 60) / SLOT;
  const cuts = people.map(p => ({ name: p.name, idx: p.idx, from: [...p.iv], start: 0, end: 0 }));
  const goal = Math.round((targetHours * 60) / SLOT);
  let trimmed = 0;
  while (trimmed < goal) {
    let best = null;
    people.forEach((p, i) => {
      const [a, b] = p.iv;
      if (b - a <= minSlots) return;
      [['start', a], ['end', b - 1]].forEach(([side, s]) => {
        if (counts[s] - 1 < MIN_ON_AFTER_CUT) return;
        if (!best || counts[s] > best.count || (counts[s] === best.count && side === 'end' && best.side === 'start')) best = { i, side, s, count: counts[s] };
      });
    });
    if (!best) break;
    const p = people[best.i];
    counts[best.s]--;
    if (best.side === 'start') { p.iv[0]++; cuts[best.i].start++; } else { p.iv[1]--; cuts[best.i].end++; }
    trimmed++;
  }
  // Safety check on the result: no slot that had 2+ people now has fewer than 2.
  const before = countsFrom(worked.map(({ r }) => schedInterval(r)).filter(Boolean).map(iv => [iv]));
  const ok = counts.every((c, s) => before[s] < MIN_ON_AFTER_CUT || c >= MIN_ON_AFTER_CUT);
  const list = cuts.map((c, i) => ({ ...c, to: people[i].iv })).filter(c => c.start || c.end).map(c => ({
    name: c.name, idx: c.idx, fromS: c.from, toS: [...c.to], hours: ((c.start + c.end) * SLOT) / 60,
    was: `${slotLabel(c.from[0])}–${slotLabel(c.from[1])}`, now: `${slotLabel(c.to[0])}–${slotLabel(c.to[1])}`,
  }));
  return { cuts: ok ? list : [], hours: ok ? (trimmed * SLOT) / 60 : 0, ok };
}

// ─── Analysis ───────────────────────────────────────────────────────────────
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const anyHours = stores => Object.values(stores || {}).some(recs => (recs || []).some(r => r[5] > 0));
const anyClockIn = stores => Object.values(stores || {}).some(recs => (recs || []).some(r => r[5] > 0 || (r[4] && r[4].length)));

// The latest day that has hours worked. Days after it can be a future
// schedule (an Attendance file pulled ahead of time has shifts but no hours),
// so the tab's "latest day" must not be the last date stored.
export function lastWorkedDate(shiftHistory) {
  return Object.keys(shiftHistory || {}).filter(d => anyHours(shiftHistory[d])).sort().pop() || null;
}

// Dates after `end`, from today on, with shifts scheduled but nobody clocked
// in anywhere: the schedule still to come.
export function upcomingDates(shiftHistory, end, today = localISO(new Date())) {
  return Object.keys(shiftHistory || {}).filter(d => (!end || d > end) && d >= today && !anyClockIn(shiftHistory[d])).sort();
}

// One upcoming day for one store, judged against that weekday's history `w`.
// need = hours that day should take at the busy target: the usual serviced
// hours for that weekday plus the guests it usually loses (GUEST_HOURS each),
// or what's already booked if more, ÷ target. A held weekday (losing more
// guests per cut than the company) never gets a cut plan.
// Hours of stylist time one lost guest would have taken: 20 minutes, the
// Appointments report's default Supercut duration (display choice).
const GUEST_HOURS = 1 / 3;
const LIGHT_DAY = 0.5; // scheduled under half a usual day: a holiday or short day, not judged (display choice)
function upcomingDay(date, recs, w, target, holiday = false) {
  const sched = recs.map(schedInterval);
  const ivs = sched.filter(Boolean);
  const counts = countsFrom(ivs.map(iv => [iv]));
  const schedHours = r2(recs.reduce((t, r, i) => t + (r[7] || (sched[i] ? ((sched[i][1] - sched[i][0]) * SLOT) / 60 : 0)), 0));
  const booked = r2(recs.reduce((t, r) => t + (r[6] || 0), 0));
  const open = ivs.length ? Math.min(...ivs.map(s => s[0])) : null;
  const close = ivs.length ? Math.max(...ivs.map(s => s[1])) : null;
  const hasHistory = !!(w && w.n);
  const light = holiday || (hasHistory && w.actual > 0 && schedHours < w.actual * LIGHT_DAY);
  const expected = hasHistory ? Math.max(w.serviced + (w.lostDay || 0) * GUEST_HOURS, booked) : null;
  const need = expected != null && target ? expected / target : null;
  const over = need != null && !light ? schedHours - need : null;
  const plan = over != null && over >= 0.5 && !(w && w.hold) ? safeTrimPlan(recs, over, { scheduled: true }) : null;
  // Short only when under both what the day needs and what it usually gets:
  // a store busier than the target isn't told to add past its usual hours
  // (the weekday advice already says it can use more).
  const gap = need != null && !light ? Math.min(need, w.actual) - schedHours : 0;
  const short = gap >= 2 ? gap : 0;
  const aloneRuns = open != null ? runsWhere(counts, open, close, c => c === 1) : [];
  const zeroRuns = open != null ? runsWhere(counts, open, close, c => c === 0) : [];
  const aloneHours = aloneRuns.reduce((t, [a, b]) => t + ((b - a) * SLOT) / 60, 0);
  return { date, wd: weekdayOf(date), recs, counts, schedHours, booked, people: ivs.length, open, close, light, holiday, expected, need, over, plan, short, aloneRuns, zeroRuns, aloneHours, hold: !!(w && w.hold) };
}

// What to do on one weekday, in plain words. History first (how that day
// usually runs), then each upcoming date of that weekday on the schedule.
function weekdayAdvice(st, w) {
  const out = [];
  const day = WEEKDAYS_LONG[w.wd];
  const t = st.target;
  if (w.hold) {
    out.push({ kind: 'grow', text: `Hold hours on ${day}s: losing ${w.lostRate.toFixed(1)} guests per 100 cuts (company ${w.companyRate.toFixed(1)}), ${w.lostDay.toFixed(1)} a day. No cuts suggested.` });
  }
  if (w.n && t != null) {
    const hot = w.busy != null && w.busy >= t + BUSY_GAP_PTS;
    if (hot && w.soloHours >= 0.5) {
      out.push({ kind: 'grow', text: `${day}s run ${pct(w.busy)} busy (target ${pct(t)}) with ${hrs(w.soloHours)} a day of one person alone${w.soloRuns.length ? `, mostly ${w.soloRuns.slice(0, 2).map(runText).join(' and ')}` : ''}. Put a second person on then; guests may be walking out.` });
    } else if (hot) {
      out.push({ kind: 'grow', text: `${day}s run ${pct(w.busy)} busy, above the ${pct(t)} target. This is a day that can use more hours if you have them.` });
    }
    if (w.trimmable >= 0.5) {
      out.push({ kind: 'trim', text: `About ${hrs(w.trimmable)} a ${day} can come off without leaving anyone alone${w.busy != null && w.busy < t ? ` (only ${pct(w.busy)} busy)` : ''}${w.crowdRuns.length ? `. 3+ are usually on ${w.crowdRuns.slice(0, 2).map(runText).join(' and ')}` : ''}.` });
    }
    if (w.zeroDays.length) {
      const ex = w.zeroDays[w.zeroDays.length - 1];
      out.push({ kind: 'gap', text: `Nobody was clocked in during open hours on ${w.zeroDays.length} of ${w.n} ${day}s (latest ${ex.date}, ${ex.runs.slice(0, 2).map(runText).join(', ')}). Check for a late open, an uncovered call-out or a missed clock-in.` });
    }
    if (w.callOuts.length) out.push({ kind: 'gap', text: `${w.callOuts.length} call-out${w.callOuts.length > 1 ? 's' : ''} on ${day}s: ${w.callOuts.slice(0, 4).join(', ')}${w.callOuts.length > 4 ? '…' : ''}.` });
    if (w.lateStays.length && w.lateStays[0].hours >= 0.5) out.push({ kind: 'payroll', text: `Clocked out ${OVER_SCHED_FLAG_MIN}+ min past schedule on ${day}s: ${w.lateStays.slice(0, 3).map(l => `${l.name} ${hrs(l.hours)}`).join(', ')}.` });
    if (w.earlyHours >= 0.5) out.push({ kind: 'payroll', text: `${hrs(w.earlyHours)} of early clock-ins (${OVER_SCHED_FLAG_MIN}+ min before schedule) on ${day}s.` });
  }
  return out;
}

// Advice for one upcoming date, from upcomingDay().
function upcomingAdvice(u, w, t) {
  const out = [];
  if (u.holiday) {
    out.push({ kind: 'info', text: `Most stores aren't scheduled this day (a holiday?), so it isn't judged. ${hrs(u.schedHours)} scheduled here.` });
    return out;
  }
  if (u.light) {
    out.push({ kind: 'gap', text: `Light day: ${hrs(u.schedHours)} scheduled vs ${hrs(w.actual)} on a usual ${WEEKDAYS_LONG[u.wd]}. A holiday or short day? Not judged.` });
    return out;
  }
  if (u.plan && u.plan.cuts.length) {
    const rest = u.over - u.plan.hours;
    out.push({ kind: 'trim', text: `${hrs(u.schedHours)} scheduled; a usual ${WEEKDAYS_LONG[u.wd]} needs about ${hrs(u.need)} at ${pct(t)} busy. Cut ${hrs(u.plan.hours)} as below${rest >= 0.5 ? ` (the other ${hrs(rest)} can't come off without leaving someone alone)` : ''}.` });
  } else if (u.over != null && u.over >= 0.5 && u.hold) {
    out.push({ kind: 'info', text: `${hrs(u.schedHours)} scheduled vs about ${hrs(u.need)} usually needed. Not cut: ${WEEKDAYS_LONG[u.wd]}s lose more guests than average.` });
  } else if (u.over != null && u.over >= 0.5) {
    out.push({ kind: 'trim', text: `${hrs(u.schedHours)} scheduled vs about ${hrs(u.need)} needed, but no cut works without leaving someone alone or a shift under ${MIN_SHIFT_HOURS} hrs.` });
  }
  if (u.short) {
    out.push({ kind: 'grow', text: `Short: ${hrs(u.schedHours)} scheduled, a usual ${WEEKDAYS_LONG[u.wd]} works ${hrs(w.actual)} and needs about ${hrs(u.need)}. Add about ${hrs(u.short)}${u.aloneRuns.length ? `, starting with ${u.aloneRuns.slice(0, 2).map(runText).join(' and ')} (one person on)` : ''}.` });
  }
  if (u.aloneRuns.length && !u.short) {
    const busyDay = w && w.n && w.busy != null && t != null && w.busy >= t;
    out.push({ kind: busyDay ? 'grow' : 'info', text: `One person on alone ${u.aloneRuns.slice(0, 3).map(runText).join(', ')}${busyDay ? `. ${WEEKDAYS_LONG[u.wd]}s run ${pct(w.busy)} busy, so a second person then could add cuts` : ''}.` });
  }
  if (u.zeroRuns.length) out.push({ kind: 'gap', text: `Nobody scheduled ${u.zeroRuns.slice(0, 3).map(runText).join(', ')}, between the first start and the last end.` });
  if (u.booked > 0) out.push({ kind: 'info', text: `${hrs(u.booked)} already booked.` });
  if (!out.length || (out.length === 1 && out[0].kind === 'info' && u.booked > 0)) {
    if (u.need != null) out.unshift({ kind: 'ok', text: `${hrs(u.schedHours)} scheduled, close to the ${hrs(u.need)} a usual ${WEEKDAYS_LONG[u.wd]} needs.` });
  }
  return out;
}

// shiftHistory: { date: { code: recs } }; salesFor(code, date) → $ (service + retail).
// Returns per-store results for dates in [start, end], plus the schedule
// still to come (dates after `end` with no clock-ins yet) judged by weekday.
// lost: lostForSchedules() from src/appointments.js (optional). Lost guests
// count toward the hours a weekday needs, and a weekday losing more guests
// per 100 cuts than the company is "held": no cuts suggested.
// skip(date): leave a date out of the history (planSchedules leaves holiday
// weeks out of the "usual week" it projects from).
export function analyzeSchedules({ shiftHistory, start, end, salesFor, codes = null, targetBusy = null, today = undefined, lost = null, skip = null }) {
  const ahead = {};
  const aheadDates = upcomingDates(shiftHistory, end, today);
  // A date most stores aren't scheduled at all (under half the usual number
  // of stores) is a holiday: shown, never judged.
  const storesOn = d => Object.values(shiftHistory[d] || {}).filter(recs => (recs || []).some(r => schedInterval(r))).length;
  const usualStores = median(aheadDates.map(storesOn));
  const holidays = new Set(aheadDates.filter(d => usualStores && storesOn(d) < usualStores / 2));
  aheadDates.forEach(date => {
    Object.entries(shiftHistory[date] || {}).forEach(([code, recs]) => {
      if (codes && !codes.has(code)) return;
      if (!(recs || []).some(r => schedInterval(r))) return;
      (ahead[code] = ahead[code] || []).push({ date, recs });
    });
  });
  const byStore = {};
  Object.entries(shiftHistory || {}).forEach(([date, stores]) => {
    if (date < start || date > end) return;
    if (skip && skip(date)) return;
    Object.entries(stores || {}).forEach(([code, recs]) => {
      if (codes && !codes.has(code)) return;
      // A day with no hours on anyone is a closed day or a report pulled
      // before the day was over (clock-ins but 0 hours), not a gap. Skip it.
      if (!(recs || []).some(r => r[5] > 0)) return;
      (byStore[code] = byStore[code] || []).push({ date, recs });
    });
  });

  // Pass 1: per store-day numbers.
  const stores = {};
  Object.entries(byStore).forEach(([code, days]) => {
    const dayRows = days.sort((a, b) => (a.date < b.date ? -1 : 1)).map(({ date, recs }) => {
      const worked = recs.map(workedIntervals);
      const counts = countsFrom(worked);
      const sched = recs.map(schedInterval).filter(Boolean);
      let actual = 0, serviced = 0, schedHours = 0, overSched = 0, early = 0, missedOut = 0;
      const callOuts = [], lateStays = [];
      recs.forEach((r, i) => {
        actual += r[5]; serviced += r[6]; schedHours += r[7];
        if (r[4] && r[4].some((v, j) => j % 2 === 1 && v == null)) missedOut++;
        if (r[2] != null && r[3] != null && r[5] === 0 && !(r[4] && r[4].length)) callOuts.push(r[0]);
        const iv = worked[i];
        if (iv.length && r[3] != null) {
          const lastOut = iv[iv.length - 1][1] * SLOT;
          const firstIn = iv[0][0] * SLOT;
          if (lastOut - r[3] >= OVER_SCHED_FLAG_MIN) lateStays.push({ name: r[0], mins: lastOut - r[3] });
          if (r[2] != null && r[2] - firstIn >= OVER_SCHED_FLAG_MIN) early += r[2] - firstIn;
        }
        if (r[7] > 0 && r[5] > r[7]) overSched += r[5] - r[7];
      });
      return {
        date, wd: weekdayOf(date), recs, counts, actual: r2(actual), serviced: r2(serviced), schedHours: r2(schedHours),
        overSched: r2(overSched), earlyHours: r2(early / 60), missedOut, callOuts, lateStays,
        open: sched.length ? Math.min(...sched.map(s => s[0])) : null,
        close: sched.length ? Math.max(...sched.map(s => s[1])) : null,
        sales: salesFor ? (salesFor(code, date) || 0) : 0,
      };
    });
    stores[code] = { code, days: dayRows };
  });
  // A store with a schedule ahead but no worked days in range still shows.
  Object.keys(ahead).forEach(code => { if (!stores[code]) stores[code] = { code, days: [] }; });

  // Target "busy %" (serviced ÷ clocked hours): the user's number if given,
  // else the median of the stores shown (3+), else each store's own average.
  const storeBusy = Object.values(stores).map(s => {
    const a = s.days.reduce((t, d) => t + d.actual, 0);
    return a > 0 ? s.days.reduce((t, d) => t + d.serviced, 0) / a : null;
  }).filter(v => v != null);
  const groupTarget = storeBusy.length >= 3 ? median(storeBusy) : null;

  Object.values(stores).forEach(st => {
    const totA = st.days.reduce((t, d) => t + d.actual, 0);
    const totS = st.days.reduce((t, d) => t + d.serviced, 0);
    st.busy = totA > 0 ? totS / totA : null;
    st.target = targetBusy || groupTarget || st.busy || null;
    st.targetSource = targetBusy ? 'yours' : groupTarget ? 'group' : 'own';

    // Per weekday.
    st.weekdays = WEEKDAYS.map((_, wd) => {
      const ds = st.days.filter(d => d.wd === wd);
      const n = ds.length;
      if (!n) return { wd, n: 0 };
      const mo = median(ds.map(d => d.open).filter(v => v != null));
      const mc = median(ds.map(d => d.close).filter(v => v != null));
      const open = mo == null ? null : Math.round(mo);
      const close = mc == null ? null : Math.round(mc);
      const avg = new Array(SLOTS).fill(0);
      ds.forEach(d => d.counts.forEach((c, s) => { avg[s] += c / n; }));
      let solo = 0, zero = 0, peak3 = 0, above2 = 0;
      const zeroDays = [];
      // Person-hours beyond 2 on, on an average day: the most a lighter day
      // can drop while still keeping 2 people on at all times.
      if (open != null && close != null) for (let s = open; s < close; s++) above2 += Math.max(0, avg[s] - MIN_ON_AFTER_CUT);
      ds.forEach(d => {
        if (open == null || close == null) return;
        let z = 0;
        for (let s = open; s < close; s++) {
          if (d.counts[s] === 1) solo++;
          if (d.counts[s] === 0) { zero++; z++; }
          if (d.counts[s] >= 3) peak3++;
        }
        if (z) zeroDays.push({ date: d.date, runs: runsWhere(d.counts, open, close, c => c === 0) });
      });
      const actual = ds.reduce((t, d) => t + d.actual, 0);
      const serviced = ds.reduce((t, d) => t + d.serviced, 0);
      const sales = ds.reduce((t, d) => t + d.sales, 0);
      const busy = actual > 0 ? serviced / actual : null;
      // Lost guests (Appointments report) that weekday: they count toward the
      // hours the day needs, and a weekday losing more per 100 cuts than the
      // company is held (no cuts).
      const li = lost?.stores?.[st.code];
      const lostDay = li ? li.perDay[wd] || 0 : 0;
      const lostRate = li ? li.rate[wd] : null;
      const hold = lostRate != null && lost.companyRate != null && lostRate > lost.companyRate;
      // Extra hours: clocked beyond what the busy target needs, capped at what
      // can be cut without leaving anyone alone (from each day's schedule).
      let extra = 0, trimmable = 0;
      ds.forEach(d => {
        const over = st.target ? Math.max(0, d.actual - (d.serviced + lostDay * GUEST_HOURS) / st.target) : 0;
        extra += over;
        if (over >= 0.25 && !hold) trimmable += safeTrimPlan(d.recs, over).hours;
      });
      const latest = ds[ds.length - 1];
      const latestOver = st.target && !hold ? Math.max(0, latest.actual - (latest.serviced + lostDay * GUEST_HOURS) / st.target) : 0;
      const lateBy = {};
      ds.forEach(d => d.lateStays.forEach(l => { lateBy[l.name] = (lateBy[l.name] || 0) + l.mins; }));
      return {
        wd, n, open, close, avg, dates: ds.map(d => d.date),
        lostDay, lostRate, hold, companyRate: lost ? lost.companyRate : null,
        callOuts: ds.flatMap(d => d.callOuts),
        lateStays: Object.entries(lateBy).map(([name, mins]) => ({ name, hours: mins / 60 })).sort((a, b) => b.hours - a.hours),
        earlyHours: ds.reduce((t, d) => t + d.earlyHours, 0),
        actual: actual / n, serviced: serviced / n, sales: sales / n,
        busy, salesPerHour: actual > 0 && sales > 0 ? sales / actual : null,
        soloHours: (solo * SLOT) / 60 / n, zeroHours: (zero * SLOT) / 60 / n, peakHours: (peak3 * SLOT) / 60 / n,
        zeroDays, extra: extra / n, trimmable: trimmable / n, above2: (above2 * SLOT) / 60,
        soloRuns: open != null ? runsWhere(avg, open, close, c => c > 0 && c < 1.5) : [],
        crowdRuns: open != null ? runsWhere(avg, open, close, c => c >= 3) : [],
        plan: latestOver >= 0.25 ? { date: latest.date, ...safeTrimPlan(latest.recs, latestOver) } : null,
      };
    });

    const weeks = Math.max(1, st.days.length / 7);
    const sum = k => st.days.reduce((t, d) => t + d[k], 0);
    st.hoursPerWeek = sum('actual') / weeks;
    st.sales = sum('sales');
    st.salesPerHour = sum('actual') > 0 && st.sales > 0 ? st.sales / sum('actual') : null;
    st.overSched = sum('overSched');
    st.earlyHours = sum('earlyHours');
    st.missedOut = sum('missedOut');
    st.callOuts = st.days.reduce((t, d) => t + d.callOuts.length, 0);
    st.soloPerWeek = st.weekdays.reduce((t, w) => t + (w.n ? w.soloHours * w.n : 0), 0) / weeks;
    st.zeroPerWeek = st.weekdays.reduce((t, w) => t + (w.n ? w.zeroHours * w.n : 0), 0) / weeks;
    st.trimPerWeek = st.weekdays.reduce((t, w) => t + (w.n ? w.trimmable * w.n : 0), 0) / weeks;
    const late = {};
    st.days.forEach(d => d.lateStays.forEach(l => { late[l.name] = (late[l.name] || 0) + l.mins; }));
    st.lateStays = Object.entries(late).map(([name, mins]) => ({ name, hours: mins / 60 })).sort((a, b) => b.hours - a.hours);
    st.tips = storeTips(st);

    // The schedule ahead, judged against each weekday's history.
    st.upcoming = (ahead[st.code] || []).map(({ date, recs }) => {
      const u = upcomingDay(date, recs, st.weekdays[weekdayOf(date)], st.target, holidays.has(date));
      return { ...u, advice: upcomingAdvice(u, st.weekdays[u.wd], st.target) };
    });
    st.upcomingCut = st.upcoming.reduce((t, u) => t + (u.plan ? u.plan.hours : 0), 0);
    st.upcomingShort = st.upcoming.reduce((t, u) => t + u.short, 0);
    st.upcomingHours = st.upcoming.reduce((t, u) => t + u.schedHours, 0);
    st.weekdays.forEach(w => {
      w.advice = weekdayAdvice(st, w);
      w.upcoming = st.upcoming.filter(u => u.wd === w.wd);
    });
  });
  return { stores, groupTarget, start, end, upcoming: aheadDates, holidays: [...holidays] };
}

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const hrs = v => `${(Math.round(v * 10) / 10).toFixed(1)} hr${Math.abs(v - 1) < 0.05 ? '' : 's'}`;
const money = v => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);

// Plain-language tips, all from the store's own numbers. They say where to
// look; the schedule call stays with the manager.
function storeTips(st) {
  const tips = [];
  const wds = st.weekdays.filter(w => w.n);
  if (!wds.length || st.target == null) return tips;
  // Busy days with one person alone → where more coverage could add cuts.
  wds.filter(w => w.busy != null && w.busy >= st.target + BUSY_GAP_PTS && w.soloHours >= 1).sort((a, b) => b.busy - a.busy).slice(0, 2).forEach(w => {
    tips.push({ kind: 'grow', text: `${WEEKDAYS_LONG[w.wd]}s run ${pct(w.busy)} busy (target ${pct(st.target)}) with ${hrs(w.soloHours)} a day of one person alone${w.soloRuns.length ? `, mostly ${w.soloRuns.slice(0, 2).map(runText).join(' and ')}` : ''}. Guests may be walking out then; a second person there is the first place to look for more cuts.` });
  });
  // Move hours from the slowest to the busiest day.
  const ranked = wds.filter(w => w.busy != null && w.n >= 2).sort((a, b) => a.busy - b.busy);
  if (ranked.length >= 2) {
    const slow = ranked[0], busy = ranked[ranked.length - 1];
    if (busy.busy - slow.busy >= BUSY_GAP_PTS && slow.trimmable >= 0.5) {
      tips.push({ kind: 'move', text: `${WEEKDAYS_LONG[slow.wd]} is the slowest day (${pct(slow.busy)} busy) and ${WEEKDAYS_LONG[busy.wd]} the busiest (${pct(busy.busy)}). About ${hrs(slow.trimmable)} a ${WEEKDAYS[slow.wd]} can come off without leaving anyone alone, and ${WEEKDAYS[busy.wd]} is where extra hours would do the most.` });
    }
  }
  // Too many on at once on a slow day.
  wds.filter(w => w.trimmable >= 0.5 && w.crowdRuns.length && (w.busy == null || w.busy < st.target)).sort((a, b) => b.trimmable - a.trimmable).slice(0, 2).forEach(w => {
    tips.push({ kind: 'trim', text: `${WEEKDAYS_LONG[w.wd]}s average 3+ people on ${w.crowdRuns.slice(0, 2).map(runText).join(' and ')} but only ${pct(w.busy)} busy. About ${hrs(w.trimmable)} a ${WEEKDAYS[w.wd]} could come off without anyone working alone (see the plan below).` });
  });
  // Nobody on while the store is usually open.
  const zero = wds.filter(w => w.zeroDays.length).reduce((t, w) => t + w.zeroDays.length, 0);
  if (zero) {
    const ex = wds.flatMap(w => w.zeroDays).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    tips.push({ kind: 'gap', text: `${zero} day${zero > 1 ? 's' : ''} had nobody clocked in during normal hours (latest ${ex.date}, ${ex.runs.slice(0, 2).map(runText).join(', ')}). Check for a late open, a call-out with no cover, or a missed clock-in.` });
  }
  if (st.callOuts) tips.push({ kind: 'gap', text: `${st.callOuts} scheduled shift${st.callOuts > 1 ? 's' : ''} had no hours worked (call-outs or no-shows).` });
  // Payroll creep.
  if (st.lateStays.length && st.lateStays[0].hours >= 1) {
    tips.push({ kind: 'payroll', text: `Clocked out ${OVER_SCHED_FLAG_MIN}+ minutes past schedule: ${st.lateStays.slice(0, 3).map(l => `${l.name} ${hrs(l.hours)}`).join(', ')} in this range.` });
  }
  if (st.earlyHours >= 1) tips.push({ kind: 'payroll', text: `${hrs(st.earlyHours)} of clock-ins came ${OVER_SCHED_FLAG_MIN}+ minutes before the scheduled start.` });
  if (st.missedOut) tips.push({ kind: 'payroll', text: `${st.missedOut} missed checkout${st.missedOut > 1 ? 's' : ''}. Hours on those shifts may be off until they're fixed.` });
  return tips;
}

// ─── Holidays and last year ─────────────────────────────────────────────────
// User (2026-11-20): tips should reflect holidays, from 2025 sales and
// attendance — the week before Thanksgiving staffs differently from the week
// after. Each date is matched to its twin last year: the same day around a
// moving holiday (Thanksgiving, Easter, Memorial Day, Labor Day), the same
// calendar date around Christmas / New Year's / July 4th, else 364 days back
// (same weekday). That day's cuts vs a usual day of that weekday last year
// scale how many hours the date needs.
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / 86400000);
function nthWeekday(y, m, wd, n) { const first = new Date(y, m - 1, 1).getDay(); return ymd(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); }
function lastWeekday(y, m, wd) { const last = new Date(y, m, 0); return ymd(y, m, last.getDate() - ((last.getDay() - wd + 7) % 7)); }
function easterOf(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}
const MOVING_HOLIDAYS = [
  { on: y => nthWeekday(y, 11, 4, 4), from: -9, to: 10, label: o => (o === -1 ? 'the day before Thanksgiving' : o === 0 ? 'Thanksgiving' : o === 1 ? 'Black Friday' : o === 2 ? 'the Saturday after Thanksgiving' : o === 3 ? 'the Sunday after Thanksgiving' : o < 0 ? 'the week before Thanksgiving' : 'the week after Thanksgiving') },
  { on: easterOf, from: -2, to: 1, label: o => (o === 0 ? 'Easter' : o < 0 ? 'Easter weekend' : 'the day after Easter') },
  { on: y => lastWeekday(y, 5, 1), from: -3, to: 0, label: o => (o === 0 ? 'Memorial Day' : 'Memorial Day weekend') },
  { on: y => nthWeekday(y, 9, 1, 1), from: -3, to: 0, label: o => (o === 0 ? 'Labor Day' : 'Labor Day weekend') },
];
function fixedHoliday(md) {
  if (md >= '12-20' && md <= '12-23') return 'the days before Christmas';
  if (md === '12-24') return 'Christmas Eve';
  if (md === '12-25') return 'Christmas';
  if (md >= '12-26' && md <= '12-30') return 'the week after Christmas';
  if (md === '12-31') return "New Year's Eve";
  if (md === '01-01') return "New Year's Day";
  if (md === '01-02') return "the day after New Year's";
  if (md === '07-03') return 'the day before July 4th';
  if (md === '07-04') return 'July 4th';
  if (md === '07-05') return 'the day after July 4th';
  return null;
}
// { label, ly } for a date in a holiday window, else null.
export function holidayInfo(iso) {
  const y = Number(iso.slice(0, 4));
  const fixed = fixedHoliday(iso.slice(5));
  if (fixed) return { label: fixed, ly: `${y - 1}${iso.slice(4)}` };
  for (const h of MOVING_HOLIDAYS) {
    const off = dayDiff(iso, h.on(y));
    if (off >= h.from && off <= h.to) return { label: h.label(off), ly: addDays(h.on(y - 1), off) };
  }
  return null;
}
export const lastYearDate = iso => (holidayInfo(iso) || {}).ly || addDays(iso, -364);

// cutsFor/hoursFor(code, date) come from the daily sales history. Returns
// { [date]: { ly, label, f (company), stores: { code: { f, lyCuts, base, lyHours, baseHours, closed } } } }.
// f = cuts that day last year ÷ cuts on a usual day of that weekday in the
// same weeks last year as the "usual week" now. A store's own f leans toward
// the company's when the store is small (one day of one store is noisy).
const SHRINK_CUTS = 15; // display choice
export function seasonFactors({ dates, codes, baseStart, baseEnd, cutsFor, hoursFor = null }) {
  const out = {};
  if (!cutsFor || !dates.length) return out;
  const lyBase = [];
  for (let d = addDays(baseStart, -364); d <= addDays(baseEnd, -364); d = addDays(d, 1)) if (!holidayInfo(d)) lyBase.push(d);
  const avgOf = (code, ds, fn) => { const v = ds.map(d => fn(code, d) || 0).filter(x => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  dates.forEach(date => {
    const h = holidayInfo(date);
    const ly = h ? h.ly : addDays(date, -364);
    const bds = lyBase.filter(d => weekdayOf(d) === weekdayOf(ly));
    const stores = {};
    let cLy = 0, cBase = 0;
    codes.forEach(code => {
      const base = avgOf(code, bds, cutsFor);
      if (base == null) return;
      const lyCuts = cutsFor(code, ly) || 0;
      stores[code] = { base, lyCuts, lyHours: hoursFor ? hoursFor(code, ly) || 0 : null, baseHours: hoursFor ? avgOf(code, bds, hoursFor) : null };
      cLy += lyCuts; cBase += base;
    });
    const cf = cBase > 0 ? cLy / cBase : null;
    Object.values(stores).forEach(s => {
      const w = s.base / (s.base + SHRINK_CUTS);
      s.closed = s.lyCuts === 0 && !(s.lyHours > 0);
      s.f = s.closed ? 0 : Math.min(3, cf == null ? s.lyCuts / s.base : w * (s.lyCuts / s.base) + (1 - w) * cf);
    });
    out[date] = { ly, label: h ? h.label : null, f: cf, stores };
  });
  return out;
}

// ─── The two tips per store ─────────────────────────────────────────────────
// User (2026-11-20): too many tips. Per store, just the #1 tip to protect
// TSTH (the days that can cut or save hours, or "you're doing great") and
// the #1 tip to grow sales (the days that need more stylists), for the date
// range picked at the top of the tab.
//  - Days in the range that are already worked: judged on what happened
//    (by weekday), same safe-cut rules as before.
//  - Days still to come: the store's usual week (the BASE_WEEKS of clock-ins
//    up to the latest day, holiday weeks left out) scaled by last year's
//    cuts that day (seasonFactors), against the posted schedule if there is
//    one, else against the hours that weekday usually gets.
export const BASE_WEEKS = 8;
const SEASON_PTS = 0.1;  // last year ±10% counts as a holiday swing (display choice)
const SAVE_MIN = 1;      // hrs in the range before a "save" tip shows (display choice)
const GROW_MIN = 2;      // hrs in the range before a "grow" tip shows (display choice)
const signedPct = f => { const p = Math.round((f - 1) * 100); return p > 0 ? `+${p}%` : p < 0 ? `−${-p}%` : '0%'; };
const pctDelta = f =>`${Math.round(Math.abs(f - 1) * 100)}% ${f >= 1 ? 'more' : 'fewer'}`;

function lyWhy(sf, s, wd) {
  if (!sf) return null;
  const f = s ? s.f : sf.f;
  if (f == null || Math.abs(f - 1) < SEASON_PTS) return null;
  const when = sf.label ? `${sf.label} ` : '';
  const lyDay = WEEKDAYS_LONG[weekdayOf(sf.ly)];
  const own = s && s.base >= 5 ? ` (${s.lyCuts} cuts on ${shortDate(sf.ly)}/${sf.ly.slice(2, 4)} vs ${Math.round(s.base)} on a usual ${lyDay})` : '';
  return `last year ${when}had ${pctDelta(f)} cuts than a usual ${lyDay}${own}`;
}

// One short reason for the store list ("Black Friday: 37% fewer cuts last
// year", "35 hrs scheduled, needs about 27").
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
function lyBrief(sf, s) {
  if (!sf) return null;
  const f = s ? s.f : sf.f;
  if (f == null || Math.abs(f - 1) < SEASON_PTS) return null;
  return `${sf.label ? `${cap(sf.label)}: ` : ''}${pctDelta(f)} cuts last year`;
}

function buildTip(spots, kind) {
  const list = spots.filter(s => s.kind === kind);
  const future = list.filter(s => !s.past);
  const use = (future.length ? future : list).sort((a, b) => b.total - a.total);
  const total = use.reduce((t, s) => t + s.total, 0);
  if (!use.length || total < (kind === 'save' ? SAVE_MIN : GROW_MIN)) return { kind, ok: true };
  return { kind, top: use[0], more: use.slice(1, 3), total };
}
export const spotShort = s => `${s.label} ${s.kind === 'save' ? '−' : '+'}${s.per.toFixed(1)} hrs${s.past ? '/day' : ''}`;
// "≈ 2 shifts" next to bigger adds, so 26 hrs reads as people (8-hr shift).
const shifts = h => (h >= 6 ? ` (≈ ${Math.round(h / 8)} ${Math.round(h / 8) === 1 ? 'shift' : 'shifts'})` : '');
export function tipAction(t) {
  if (t.ok) return t.kind === 'save' ? "You're doing great: no hours to cut" : 'Covered: no day is short';
  const s = t.top;
  return t.kind === 'save'
    ? `Cut ${s.per.toFixed(1)} hrs${s.past ? ' each' : ' on'} ${s.label}`
    : `Add ${s.per.toFixed(1)} hrs${shifts(s.per)}${s.past ? ' each' : ' on'} ${s.label}`;
}
export function tipHeadline(t) {
  if (t.ok) return t.kind === 'save' ? "You're doing great! No day here has hours to spare." : 'No day here looks short on stylists.';
  return tipAction(t);
}
export function tipText(t) {
  if (t.ok) return tipHeadline(t);
  return `${tipHeadline(t)}: ${t.top.why}.${t.more.length ? ` Also ${t.more.map(spotShort).join(', ')}.` : ''}`;
}
export const tipShort = t => (t.ok ? tipAction(t) : `${tipAction(t)}${t.top.brief ? ` (${t.top.brief})` : ''}`);

// The whole plan for a date range. lostFor(start, end) → lostForSchedules()
// output or null. Returns { base, range, view, viewStart, viewEnd, future,
// factors, closedDays, stores: { code: { save, grow, days } } } or null.
export function planSchedules({ shiftHistory, rangeStart, rangeEnd, salesFor, cutsFor = null, hoursFor = null, targetBusy = null, lostFor = () => null, today = localISO(new Date()), codes = null }) {
  const latest = lastWorkedDate(shiftHistory);
  if (!latest) return null;
  const baseEnd = latest;
  const baseStart = addDays(latest, -BASE_WEEKS * 7 + 1);
  const base = analyzeSchedules({ shiftHistory, start: baseStart, end: baseEnd, salesFor, codes, targetBusy, today, lost: lostFor(baseStart, baseEnd), skip: d => !!holidayInfo(d) });
  const target = targetBusy || base.groupTarget || null;
  const pastEnd = rangeEnd < latest ? rangeEnd : latest;
  const range = rangeStart <= pastEnd ? analyzeSchedules({ shiftHistory, start: rangeStart, end: pastEnd, salesFor, codes, targetBusy: target, today, lost: lostFor(rangeStart, pastEnd) }) : null;
  const workedDays = range ? new Set(Object.values(range.stores).flatMap(s => s.days.map(d => d.date))).size : 0;
  const view = range && workedDays >= 7 ? range : base;

  // Days still to come in the range.
  const future = [];
  const first = [rangeStart, today, addDays(latest, 1)].sort().pop();
  for (let d = first; d <= rangeEnd; d = addDays(d, 1)) future.push(d);
  // A date most stores aren't scheduled (under half the usual) is a day off.
  const storesOn = d => Object.values(shiftHistory[d] || {}).filter(recs => (recs || []).some(r => schedInterval(r))).length;
  const withSched = future.filter(d => storesOn(d) > 0);
  const usualOn = median(withSched.map(storesOn));
  const closedDays = new Set(withSched.filter(d => usualOn && storesOn(d) < usualOn / 2));
  const allCodes = [...new Set([...Object.keys(base.stores), ...Object.keys(range ? range.stores : {})])];
  const factors = seasonFactors({ dates: future, codes: allCodes, baseStart, baseEnd, cutsFor, hoursFor });

  const stores = {};
  allCodes.forEach(code => {
    const bst = base.stores[code];
    const rst = range && range.stores[code];
    const t = (rst || bst || {}).target || target;
    const spots = [];
    const days = [];
    // Worked days in the range, by weekday.
    if (rst && t) rst.weekdays.filter(w => w.n).forEach(w => {
      const day = `${WEEKDAYS_LONG[w.wd]}s`;
      if (w.trimmable >= 0.25 && !w.hold) {
        spots.push({ kind: 'save', past: true, label: day, per: w.trimmable, total: w.trimmable * w.n,
          brief: `only ${pct(w.busy)} busy, target ${pct(t)}`,
          why: `${day} ran ${pct(w.busy)} busy (target ${pct(t)})${w.crowdRuns.length ? ` with 3+ on ${w.crowdRuns.slice(0, 2).map(runText).join(' and ')}` : ''}; trimming shift edges keeps 2+ on at all times` });
      }
      const hot = w.busy != null && w.busy >= t + BUSY_GAP_PTS;
      const add = (w.serviced + w.lostDay * GUEST_HOURS) / t - w.actual;
      if ((hot || w.hold) && add >= 0.5) {
        const bits = [hot ? `${day} ran ${pct(w.busy)} busy (target ${pct(t)})` : null,
          w.hold ? `losing ${w.lostRate.toFixed(1)} guests per 100 cuts (company ${w.companyRate.toFixed(1)})` : null,
          w.soloRuns.length ? `one person alone ${w.soloRuns.slice(0, 2).map(runText).join(' and ')}` : null].filter(Boolean);
        spots.push({ kind: 'grow', past: true, label: day, per: add, total: add * w.n, why: bits.join(', '),
          brief: hot ? `${pct(w.busy)} busy, target ${pct(t)}` : 'losing more guests than average' });
      }
    });
    // Days to come.
    if (bst && t) future.forEach(date => {
      const wd = weekdayOf(date);
      const w = bst.weekdays[wd];
      if (!w.n) return;
      const sf = factors[date];
      const s = sf && sf.stores[code];
      const f = s ? s.f : sf && sf.f != null ? sf.f : 1;
      const recs = ((shiftHistory[date] || {})[code] || []);
      const scheduled = recs.some(r => schedInterval(r));
      const sched = recs.map(schedInterval);
      const schedHours = scheduled ? r2(recs.reduce((x, r, i) => x + (r[7] || (sched[i] ? ((sched[i][1] - sched[i][0]) * SLOT) / 60 : 0)), 0)) : null;
      const row = { date, wd, f, label: sf ? sf.label : null, ly: sf ? sf.ly : null, lyCuts: s ? s.lyCuts : null, baseCuts: s ? s.base : null, lyHours: s ? s.lyHours : null, usual: w.actual, schedHours, need: null, save: 0, grow: 0, hold: w.hold, cuts: [] };
      days.push(row);
      if (f === 0) { row.note = 'Closed last year'; return; }
      if (closedDays.has(date)) { row.note = 'Most stores off'; return; }
      const need = (w.serviced * f + w.lostDay * f * GUEST_HOURS) / t;
      // Under half the usual hours posted = a schedule still being built:
      // judged against the usual hours instead (same LIGHT_DAY rule as before).
      const partial = scheduled && schedHours < w.actual * LIGHT_DAY;
      if (partial) row.note2 = 'Schedule looks unfinished';
      const useSched = scheduled && !partial;
      const have = useSched ? schedHours : w.actual;
      row.need = need;
      if (!w.hold) {
        if (useSched) {
          const plan = have - need >= 0.5 ? safeTrimPlan(recs, have - need, { scheduled: true }) : null;
          row.save = plan ? plan.hours : 0;
          row.cuts = plan ? plan.cuts : [];
        } else {
          row.save = Math.max(0, Math.min(have - need, w.above2));
        }
      }
      const seasonal = f >= 1 + SEASON_PTS;
      const hot = w.busy != null && w.busy >= t + BUSY_GAP_PTS;
      row.grow = seasonal || hot || w.hold ? Math.max(0, need - have) : 0;
      const ly = lyWhy(sf, s, wd);
      const haveText = useSched ? `${hrs(schedHours)} scheduled vs about ${hrs(need)} needed` : `plan about ${hrs(need)} vs the usual ${hrs(w.actual)}${partial ? ` (only ${hrs(schedHours)} posted so far)` : ''}`;
      if (row.save >= 0.25) {
        const bits = [(f < 1 && ly) || `${WEEKDAYS_LONG[wd]}s usually run ${pct(w.busy)} busy (target ${pct(t)})`, haveText,
          row.cuts.length ? `cut ${row.cuts.slice(0, 3).map(c => `${c.name} ${c.was} → ${c.now}`).join(', ')}` : null, 'keeps 2+ on at all times'].filter(Boolean);
        // Last year as the reason only when it points the same way (fewer cuts).
        const brief = (f < 1 && lyBrief(sf, s)) || (useSched ? `${schedHours.toFixed(1)} hrs scheduled, needs about ${need.toFixed(1)}` : `Usually ${w.actual.toFixed(1)} hrs, needs about ${need.toFixed(1)}`);
        spots.push({ kind: 'save', label: shortDate(date), per: row.save, total: row.save, why: bits.join('; '), brief });
      }
      if (row.grow >= 0.5) {
        const bits = [f > 1 ? ly : null, hot ? `${WEEKDAYS_LONG[wd]}s usually run ${pct(w.busy)} busy (target ${pct(t)})` : null,
          w.hold ? `${WEEKDAYS_LONG[wd]}s lose ${w.lostRate.toFixed(1)} guests per 100 cuts (company ${w.companyRate.toFixed(1)})` : null,
          haveText, w.soloRuns.length ? `usually one person alone ${w.soloRuns.slice(0, 2).map(runText).join(' and ')}` : null].filter(Boolean);
        const brief = (f > 1 && lyBrief(sf, s)) || (hot ? `${WEEKDAYS_LONG[wd]}s run ${pct(w.busy)} busy, target ${pct(t)}` : w.hold ? `${WEEKDAYS_LONG[wd]}s lose more guests than average` : `${(have || 0).toFixed(1)} hrs scheduled, needs about ${need.toFixed(1)}`);
        spots.push({ kind: 'grow', label: shortDate(date), per: row.grow, total: row.grow, why: bits.join('; '), brief });
      }
    });
    stores[code] = { code, save: buildTip(spots, 'save'), grow: buildTip(spots, 'grow'), days };
  });
  return { base, range, view, viewStart: view === range ? rangeStart : baseStart, viewEnd: view === range ? pastEnd : baseEnd, baseStart, baseEnd, latest, future, factors, closedDays, target, stores };
}

// ─── Tilly ──────────────────────────────────────────────────────────────────
export function schedulingContext(result, storeName, plan = null) {
  const list = Object.values(result?.stores || {});
  if (!list.length) return '';
  const lines = ['', `SCHEDULING (Attendance shift times, ${result.start} to ${result.end}; "busy %" = serviced hours ÷ clocked hours; suggested cuts only trim where 3+ are on, so nobody is ever left working alone, and no shift goes under ${MIN_SHIFT_HOURS} hrs):`];
  // Every store gets a one-line summary; the 12 with the most to cut (and
  // up to 12 with the most time alone) also get by-day numbers and tips, to
  // keep the prompt a reasonable size.
  const detailed = new Set([
    ...[...list].sort((a, b) => b.trimPerWeek - a.trimPerWeek).slice(0, 12).map(s => s.code),
    ...[...list].sort((a, b) => b.soloPerWeek - a.soloPerWeek).slice(0, 12).map(s => s.code),
  ]);
  list.sort((a, b) => b.trimPerWeek - a.trimPerWeek).forEach(st => {
    let line = `${storeName(st.code)}: ${st.hoursPerWeek.toFixed(0)} hrs/wk, ${pct(st.busy)} busy vs target ${pct(st.target)}, sales/labor hr ${money(st.salesPerHour)}, alone ${st.soloPerWeek.toFixed(1)} hrs/wk, nobody on ${st.zeroPerWeek.toFixed(1)} hrs/wk, could cut ${st.trimPerWeek.toFixed(1)} hrs/wk safely, ${st.overSched.toFixed(1)} hrs over schedule, ${st.callOuts} call-outs.`;
    if (detailed.has(st.code)) {
      const wd = st.weekdays.filter(w => w.n).map(w => `${WEEKDAYS[w.wd]} ${pct(w.busy)}, ${w.actual.toFixed(0)} hrs, alone ${w.soloHours.toFixed(1)}, cut ${w.trimmable.toFixed(1)}`).join('; ');
      line += ` By day: ${wd}.${plan ? '' : ` Tips: ${st.tips.slice(0, 3).map(t => t.text).join(' ') || 'none'}`}`;
    }
    const p = plan && plan.stores[st.code];
    if (p) line += ` #1 to protect TSTH: ${tipText(p.save)} #1 to grow sales: ${tipText(p.grow)}`;
    // The schedule ahead: only days with something to change, kept short.
    const weekOut = result.upcoming && result.upcoming.length ? result.upcoming[Math.min(6, result.upcoming.length - 1)] : null;
    const flagged = (st.upcoming || []).filter(u => !u.light && u.date <= weekOut && ((u.plan && u.plan.hours >= 1) || u.short || u.zeroRuns.length));
    if (flagged.length) {
      line += ` Next 7 days on the schedule: ${flagged.slice(0, 5).map(u => {
        const bits = [`${WEEKDAYS[u.wd]} ${u.date.slice(5)} ${u.schedHours.toFixed(1)} hrs sched vs ~${u.need != null ? u.need.toFixed(1) : '?'} needed`];
        if (u.plan && u.plan.cuts.length) bits.push(`cut ${u.plan.hours.toFixed(1)}${detailed.has(st.code) ? ` (${u.plan.cuts.map(c => `${c.name} ${c.was}→${c.now}`).join('; ')})` : ''}`);
        if (u.short) bits.push(`short ~${u.short.toFixed(1)} hrs`);
        if (u.zeroRuns.length) bits.push(`nobody on ${u.zeroRuns.map(runText).join(', ')}`);
        return bits.join(', ');
      }).join(' | ')}.`;
    }
    lines.push(line);
  });
  if (plan && plan.future.length) {
    const swings = plan.future.map(d => ({ d, sf: plan.factors[d] })).filter(x => x.sf && x.sf.f != null && (x.sf.label || Math.abs(x.sf.f - 1) >= SEASON_PTS));
    lines.splice(2, 0, `Plan for ${plan.future[0]} to ${plan.future[plan.future.length - 1]}: each store's usual week (clock-ins ${plan.baseStart} to ${plan.baseEnd}, holiday weeks left out) scaled by last year's cuts on the matching day (holiday-aligned).${swings.length ? ` Company cuts last year: ${swings.map(x => `${x.d}${x.sf.label ? ` (${x.sf.label})` : ''} ${x.sf.f === 0 ? 'closed' : signedPct(x.sf.f)}`).join(', ')}.` : ''} Each store line ends with its #1 tip to protect TSTH and #1 to grow sales, the same ones the Scheduling tab shows.`);
  }
  if (result.upcoming && result.upcoming.length) lines.splice(2, 0, `Upcoming schedule on file: ${result.upcoming[0]} to ${result.upcoming[result.upcoming.length - 1]} (shifts planned, not worked yet)${result.holidays && result.holidays.length ? `; most stores closed ${result.holidays.join(', ')}` : ''}. Per-store lines below cover the next 7 days with something to change; the Scheduling tab has the rest. "needed" = that weekday's usual serviced hours (or hours already booked, if more) ÷ the busy target; cuts never leave anyone alone.`);
  return lines.join('\n');
}

// ─── UI ─────────────────────────────────────────────────────────────────────
// Quick picks for the date range at the top of the tab (custom dates too).
function rangePresets(today) {
  const wd = weekdayOf(today);
  const monday = addDays(today, wd === 0 ? -6 : 1 - wd);
  return [
    { id: 'next2', label: 'Next 2 weeks', start: today, end: addDays(today, 13) },
    { id: 'thisweek', label: 'This week', start: monday, end: addDays(monday, 6) },
    { id: 'nextweek', label: 'Next week', start: addDays(monday, 7), end: addDays(monday, 13) },
    { id: 'next4', label: 'Next 4 weeks', start: today, end: addDays(today, 27) },
    { id: 'last4', label: 'Last 4 weeks', start: addDays(today, -28), end: addDays(today, -1) },
    { id: 'last8', label: 'Last 8 weeks', start: addDays(today, -56), end: addDays(today, -1) },
  ];
}
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => { const out = []; for (let m = a.slice(0, 7); m <= b.slice(0, 7);) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } return out; };
const TARGET_KEY = 'supercuts_sched_target';

const HEAT = { zero: '#D9473F', solo: '#F2A541', two: '#BFD8F2', three: '#6E9FD6', four: '#1F5FBF' };
function heatColor(c) {
  if (!c) return HEAT.zero;
  if (c < 1.5) return HEAT.solo;
  if (c < 2.5) return HEAT.two;
  if (c < 3.5) return HEAT.three;
  return HEAT.four;
}

function CoverageHeatmap({ weekdays }) {
  const shown = weekdays.filter(w => w.n && w.open != null);
  if (!shown.length) return <p className="section-hint">No scheduled hours in this range.</p>;
  const lo = Math.max(0, Math.min(...shown.map(w => w.open)) - 2);
  const hi = Math.min(SLOTS, Math.max(...shown.map(w => w.close)) + 2);
  const cols = [];
  for (let s = lo; s < hi; s++) cols.push(s);
  return (
    <div className="sched-heat-wrap">
      <table className="sched-heat">
        <thead><tr><th />{cols.map(s => <th key={s}>{(s * SLOT) % 60 === 0 ? hourLabel(s) : ''}</th>)}</tr></thead>
        <tbody>
          {shown.map(w => (
            <tr key={w.wd}>
              <th>{WEEKDAYS[w.wd]}</th>
              {cols.map(s => {
                const c = w.avg[s];
                const inHours = s >= w.open && s < w.close;
                return <td key={s} className={inHours ? '' : 'sched-off'} style={{ background: inHours ? heatColor(c) : undefined }} title={`${WEEKDAYS_LONG[w.wd]} ${slotLabel(s)}: ${c.toFixed(1)} on average`} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sched-legend">
        <span><i style={{ background: HEAT.zero }} />Nobody</span>
        <span><i style={{ background: HEAT.solo }} />1 alone</span>
        <span><i style={{ background: HEAT.two }} />2</span>
        <span><i style={{ background: HEAT.three }} />3</span>
        <span><i style={{ background: HEAT.four }} />4+</span>

      </div>
    </div>
  );
}

function DayTimeline({ day }) {
  const worked = day.recs.map(workedIntervals);
  const all = [...worked.flat(), ...day.recs.map(schedInterval).filter(Boolean)];
  if (!all.length) return null;
  const lo = Math.min(...all.map(i => i[0])) - 1;
  const hi = Math.max(...all.map(i => i[1])) + 1;
  const pos = s => `${((s - lo) / (hi - lo)) * 100}%`;
  const width = (a, b) => `${((b - a) / (hi - lo)) * 100}%`;
  const solo = runsWhere(day.counts, day.open ?? lo, day.close ?? hi, c => c === 1);
  const zero = day.open != null ? runsWhere(day.counts, day.open, day.close, c => c === 0) : [];
  const ticks = [];
  for (let s = Math.ceil(lo / 4) * 4; s < hi; s += 4) ticks.push(s);
  return (
    <div className="sched-day">
      <div className="sched-day-axis">{ticks.map(s => <span key={s} style={{ left: pos(s) }}>{hourLabel(s)}</span>)}</div>
      {day.recs.map((r, i) => {
        const sv = schedInterval(r);
        return (
          <div className="sched-row" key={i}>
            <span className="sched-row-name">{r[0]}<em>{r[1] === 'M' ? ' · Mgr' : r[1] === 'R' ? ' · Desk' : ''}</em></span>
            <div className="sched-row-track">
              {sv && <div className="sched-bar-sched" style={{ left: pos(sv[0]), width: width(sv[0], sv[1]) }} />}
              {worked[i].map(([a, b], j) => <div key={j} className="sched-bar-worked" style={{ left: pos(a), width: width(a, b) }} />)}
              {!worked[i].length && sv && <span className="sched-callout" style={{ left: pos(sv[0]) }}>no hours</span>}
            </div>
          </div>
        );
      })}
      <div className="sched-row">
        <span className="sched-row-name"><b>Alone / nobody</b></span>
        <div className="sched-row-track">
          {solo.map(([a, b], j) => <div key={`s${j}`} className="sched-bar-solo" style={{ left: pos(a), width: width(a, b) }} title={`One person alone ${runText([a, b])}`} />)}
          {zero.map(([a, b], j) => <div key={`z${j}`} className="sched-bar-zero" style={{ left: pos(a), width: width(a, b) }} title={`Nobody clocked in ${runText([a, b])}`} />)}
        </div>
      </div>
      <p className="section-hint">Light = scheduled · dark = clocked in · orange = alone · red = nobody on</p>
    </div>
  );
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const shortDate = iso => { const d = new Date(`${iso}T12:00:00`); return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`; };
const hourShort = h => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const fmtLong = iso => { const d = new Date(`${iso}T12:00:00`); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

// One tip in the store list.
function TipCell({ t }) {
  if (t.ok) return <td className="sched-tip-cell"><span className="sched-tipline sched-tipline-ok">✅ {tipAction(t)}</span></td>;
  return (
    <td className="sched-tip-cell">
      <span className={`sched-tipline sched-tipline-${t.kind}`}>{tipAction(t)}</span>
      {t.top.brief && <span className="sched-tipwhy">{cap(t.top.brief)}</span>}
      {t.more.length > 0 && <span className="sched-tipmore">Also {t.more.map(spotShort).join(' · ')}</span>}
    </td>
  );
}

// The two tips for one store: #1 to protect TSTH, #1 to grow sales.
function TipPair({ p }) {
  const box = (t, title, icon) => (
    <div className={`sched-tip-box ${t.ok ? 'sched-tip-ok' : `sched-tip-${t.kind}`}`}>
      <span className="sched-tip-title">{icon} {title}</span>
      <b>{t.ok ? `✅ ${tipHeadline(t)}` : tipHeadline(t)}</b>
      {!t.ok && <p>{t.top.why.charAt(0).toUpperCase() + t.top.why.slice(1)}.</p>}
      {!t.ok && t.more.length > 0 && <p className="sched-tip-more">Also {t.more.map(spotShort).join(' · ')}</p>}
    </div>
  );
  return <div className="sched-tip-pair">{box(p.save, 'Protect TSTH', '✂️')}{box(p.grow, 'Grow sales', '📈')}</div>;
}

// Days to come in the range, one row each: last year, usual, scheduled, plan.
function PlanTable({ days, target }) {
  if (!days.length) return null;
  return (
    <div className="sched-table-wrap">
      <table className="ledger-table">
        <thead><tr><th className="ledger-name-col">Day</th><th>Holiday</th><th>Last year</th><th>Usual hrs</th><th>Scheduled</th><th>Plan</th><th>Change</th></tr></thead>
        <tbody>
          {days.map(r => (
            <tr key={r.date}>
              <td className="ledger-name-col">{shortDate(r.date)}</td>
              <td>{r.label || '—'}</td>
              <td title={r.ly ? `Matched to ${r.ly}` : ''}>{r.f === 0 ? 'closed' : r.baseCuts ? `${r.lyCuts} cuts vs ${Math.round(r.baseCuts)} usual (${signedPct(r.f)})` : '—'}</td>
              <td>{r.usual.toFixed(1)}</td>
              <td title={r.note2 || ''}>{r.schedHours != null ? `${r.schedHours.toFixed(1)}${r.note2 ? ' *' : ''}` : '—'}</td>
              <td>{r.need != null ? r.need.toFixed(1) : '—'}</td>
              <td className={r.save >= 0.25 ? 'sched-cool' : r.grow >= 0.5 ? 'sched-hot' : ''}>{r.note || (r.save >= 0.25 ? `−${r.save.toFixed(1)}` : r.grow >= 0.5 ? `+${r.grow.toFixed(1)}` : r.hold && r.need != null ? 'hold' : '✓')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="section-hint" style={{ padding: '0 10px' }} title={`Plan = this weekday's usual serviced hours × last year's cuts that day vs a usual day, ÷ the ${pct(target)} busy target. Cuts keep 2+ on at all times. * = under half the usual hours posted, so the plan compares to the usual hours instead.`}>− = hours to cut · + = hours to add · hold = this day loses guests, don't cut · * = schedule not finished</p>
    </div>
  );
}

// ─── Hourly heat maps (guests / lost guests / both) ─────────────────────────
// "both" colors each hour by staff on, with a dot sized by guests checking in
// (or by lost guests when the export has no completed visits).
const GUEST_SCALE = ['#FFFFFF', '#DCE6F2', '#A9C4E6', '#6E9FD6', '#1F5FBF'];
const LOST_SCALE = ['#FFFFFF', '#FBE0DC', '#F4A99F', '#E46A5C', '#B8281C'];
const scaleColor = (scale, v, max) => (!v || !max ? scale[0] : scale[Math.min(4, 1 + Math.floor((v / max) * 3.999))]);

function HourHeat({ st, appt, mode }) {
  const rows = WEEK_ORDER.map(i => st.weekdays[i]);
  const hasVisits = appt.V > 0;
  const opens = rows.filter(w => w.n && w.open != null);
  let lo = opens.length ? Math.floor(Math.min(...opens.map(w => w.open)) / 4) : null;
  let hi = opens.length ? Math.ceil(Math.max(...opens.map(w => w.close)) / 4) : null;
  if (lo == null) {
    const hrsWith = [];
    ['V', 'L'].forEach(k => appt.heat[k].forEach(r => r.forEach((v, h) => { if (v > 0) hrsWith.push(h); })));
    if (!hrsWith.length) return null;
    lo = Math.min(...hrsWith); hi = Math.max(...hrsWith) + 1;
  }
  const hours = [];
  for (let h = lo; h < hi; h++) hours.push(h);
  // Staff on, averaged over the hour; null outside that weekday's usual hours.
  const staffHour = (w, h) => (w.n && w.open != null && h * 4 + 4 > w.open && h * 4 < w.close ? (w.avg[h * 4] + w.avg[h * 4 + 1] + w.avg[h * 4 + 2] + w.avg[h * 4 + 3]) / 4 : null);
  const gKey = hasVisits ? 'V' : 'L';
  const maxOf = k => Math.max(0, ...appt.heat[k].flat());
  const maxV = maxOf('V'), maxL = maxOf('L'), maxG = maxOf(gKey);
  return (
    <div className="sched-heat-wrap">
      <table className="sched-heat sched-heat-hour">
        <thead><tr><th />{hours.map(h => <th key={h}>{hourShort(h)}</th>)}</tr></thead>
        <tbody>
          {rows.map(w => (
            <tr key={w.wd}>
              <th>{WEEKDAYS[w.wd]}</th>
              {hours.map(h => {
                const v = appt.heat.V[w.wd][h], l = appt.heat.L[w.wd][h];
                if (mode === 'guests') return <td key={h} style={{ background: scaleColor(GUEST_SCALE, v, maxV) }} title={`${WEEKDAYS_LONG[w.wd]} ${hourShort(h)}: ${v.toFixed(1)} guests a day`} />;
                if (mode === 'lost') {
                  const lN = appt.heatN ? appt.heatN.L[w.wd][h] : null;
                  const dark = maxL && l / maxL > 0.5;
                  return <td key={h} className="sched-num-cell" style={{ background: scaleColor(LOST_SCALE, l, maxL), color: dark ? '#fff' : 'var(--navy)' }} title={`${WEEKDAYS_LONG[w.wd]} ${hourShort(h)}: ${lN != null ? `${lN} lost in all, ` : ''}${l.toFixed(2)} a day`}>{lN ? lN : ''}</td>;
                }
                const s = staffHour(w, h);
                const g = appt.heat[gKey][w.wd][h];
                const gN = appt.heatN ? appt.heatN[gKey][w.wd][h] : null;
                // Big enough to hold the count; bigger = more.
                const size = maxG ? Math.round(15 + (g / maxG) * 11) : 0;
                return (
                  <td key={h} style={{ background: s == null ? 'transparent' : heatColor(s) }} title={`${WEEKDAYS_LONG[w.wd]} ${hourShort(h)}: ${s == null ? 'closed' : `${s.toFixed(1)} on`}, ${gN != null ? `${gN} ${hasVisits ? 'guests' : 'lost guests'} in all, ` : ''}${g.toFixed(hasVisits ? 1 : 2)} a day`}>
                    {g > 0 && <i className={`sched-dot ${hasVisits ? 'sched-dot-guest' : 'sched-dot-lost'}`} style={{ width: size, height: size }}>{gN != null ? gN : ''}</i>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sched-legend">
        {mode === 'both' ? <>
          <span><i style={{ background: HEAT.zero }} />Nobody</span><span><i style={{ background: HEAT.solo }} />1 alone</span><span><i style={{ background: HEAT.two }} />2</span><span><i style={{ background: HEAT.three }} />3</span><span><i style={{ background: HEAT.four }} />4+</span>
          <span><i className={`sched-dot ${hasVisits ? 'sched-dot-guest' : 'sched-dot-lost'}`} style={{ width: 14, height: 14, borderRadius: '50%' }} />= {hasVisits ? 'guests' : 'lost guests'} that hour, all days in range</span>
        </> : mode === 'guests'
          ? <span className="section-hint">Darker = more guests. Average per day.</span>
          : <span className="section-hint">Number = guests lost in that hour, all days in range. Darker = more.</span>}
      </div>
    </div>
  );
}

// ─── Coming up: guests booked vs stylists scheduled ─────────────────────────
// User (2026-11-23): a heat map of guests booked for the days ahead against
// the stylists on the posted schedule. Rows = each day still to come in the
// range, columns = hours. Square color = stylists scheduled that hour (same
// colors as the other maps; receptionists not counted); number = guests
// booked to start that hour (Appointments rows that aren't cancelled, no-show
// or deleted: the 'V' rows in appt_history). A red ring = more booked than
// the stylists on can cut at GUEST_HOURS (20 min) each.
const MAX_AHEAD_ROWS = 14;
export function bookedVsStaff({ code, shiftHistory, apptHistory, start, end, today }) {
  const from = start > today ? start : today;
  const rows = [];
  for (let d = from; d <= end && rows.length < MAX_AHEAD_ROWS; d = addDays(d, 1)) {
    const recs = ((shiftHistory || {})[d] || {})[code] || [];
    const sched = recs.filter(r => r[1] !== 'R').map(schedInterval).filter(Boolean);
    const appts = (((apptHistory || {})[d] || {})[code] || []).filter(r => r[1] === 'V' && r[0] != null);
    if (!sched.length && !appts.length) continue;
    const counts = countsFrom(sched.map(i => [i]));
    const staff = new Array(24).fill(null);
    const open = sched.length ? Math.min(...sched.map(i => i[0])) : null;
    const close = sched.length ? Math.max(...sched.map(i => i[1])) : null;
    for (let h = 0; h < 24; h++) {
      if (open == null || h * 4 + 4 <= open || h * 4 >= close) continue;
      staff[h] = (counts[h * 4] + counts[h * 4 + 1] + counts[h * 4 + 2] + counts[h * 4 + 3]) / 4;
    }
    const booked = new Array(24).fill(0);
    appts.forEach(r => { booked[Math.min(23, Math.floor(r[0] / 60))]++; });
    rows.push({ date: d, staff, booked, total: appts.length, sched: sched.length });
  }
  return rows;
}

// Tilly: guests booked ahead vs stylists scheduled (same numbers as the map).
export function bookedContext({ shiftHistory, apptHistory, start, end, today, storeName }) {
  const codes = new Set();
  for (let d = start > today ? start : today; d <= end; d = addDays(d, 1)) {
    Object.keys((shiftHistory || {})[d] || {}).forEach(c => codes.add(c));
    Object.keys((apptHistory || {})[d] || {}).forEach(c => codes.add(c));
  }
  const lines = [];
  [...codes].sort().forEach(code => {
    const rows = bookedVsStaff({ code, shiftHistory, apptHistory, start, end, today });
    const total = rows.reduce((t, r) => t + r.total, 0);
    if (!total) return;
    const over = [];
    rows.forEach(r => r.booked.forEach((b, h) => { if (b > 0 && (r.staff[h] || 0) / GUEST_HOURS < b) over.push(`${shortDate(r.date)} ${hourShort(h)} (${b} booked, ${(r.staff[h] || 0).toFixed(1)} scheduled)`); }));
    lines.push(`- ${storeName(code)}: ${total} guests booked ahead${over.length ? `; more booked than the scheduled stylists can cut at ${over.slice(0, 6).join(', ')}${over.length > 6 ? ` and ${over.length - 6} more hours` : ''}` : ''}`);
  });
  if (!lines.length) return '';
  return `\nBOOKED AHEAD vs STYLISTS SCHEDULED (${start > today ? start : today} to ${end}; Appointments bookings that aren't cancelled/no-show/deleted vs the posted schedule, receptionists not counted; a stylist can cut about 3 guests an hour):\n${lines.join('\n')}`;
}

function BookedHeat({ rows }) {
  const hrs = [];
  rows.forEach(r => r.staff.forEach((v, h) => { if (v != null || r.booked[h]) hrs.push(h); }));
  if (!hrs.length) return null;
  const hours = [];
  for (let h = Math.min(...hrs); h <= Math.max(...hrs); h++) hours.push(h);
  return (
    <div className="sched-heat-wrap">
      <table className="sched-heat sched-heat-hour">
        <thead><tr><th />{hours.map(h => <th key={h}>{hourShort(h)}</th>)}</tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.date}>
              <th>{shortDate(r.date)}</th>
              {hours.map(h => {
                const st = r.staff[h];
                const b = r.booked[h];
                const over = b > 0 && (st || 0) / GUEST_HOURS < b;
                return (
                  <td key={h} className={`sched-num-cell${over ? ' sched-over' : ''}`} style={{ background: st == null ? 'transparent' : heatColor(st) }}
                    title={`${shortDate(r.date)} ${hourShort(h)}: ${st == null ? 'nobody scheduled' : `${st.toFixed(1)} scheduled`}, ${b} booked${over ? ' (more than they can cut)' : ''}`}>
                    {b > 0 && <i className="sched-dot sched-dot-guest" style={{ width: 18, height: 18 }}>{b}</i>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sched-legend">
        <span><i style={{ background: HEAT.zero }} />Nobody</span><span><i style={{ background: HEAT.solo }} />1</span><span><i style={{ background: HEAT.two }} />2</span><span><i style={{ background: HEAT.three }} />3</span><span><i style={{ background: HEAT.four }} />4+</span>
        <span><i className="sched-dot sched-dot-guest" style={{ width: 14, height: 14, borderRadius: '50%' }} />= guests booked</span>
        <span><i className="sched-legend-over" />more booked than they can cut</span>
      </div>
    </div>
  );
}

// A titled block on the store page: what it is, in one short line.
const Section = ({ title, sub, children }) => (
  <section className="sched-sec">
    <h4 className="sched-sec-title">{title}</h4>
    {sub && <p className="sched-sec-sub">{sub}</p>}
    {children}
  </section>
);

function StoreDetail({ st, p, storeName, onBack, appt, apptCompany, viewNote, target, ahead }) {
  const [dayIdx, setDayIdx] = useState(st.days.length - 1);
  const day = st.days.length ? st.days[Math.max(0, Math.min(dayIdx, st.days.length - 1))] : null;
  const aheadBooked = (ahead || []).reduce((t, r) => t + r.total, 0);
  return (
    <div className="sched-store">
      <button className="link-btn" onClick={onBack}>← All stores</button>
      <h3 className="chart-title">{storeName(st.code)}</h3>

      {p && <Section title="What to do"><TipPair p={p} /></Section>}

      <div className="sched-cards">
        <div className="sched-card"><span>Busy %</span><strong>{pct(st.busy)}</strong><em>time spent on guests · target {pct(st.target)}</em></div>
        <div className="sched-card"><span>Staff hrs / week</span><strong>{st.hoursPerWeek.toFixed(0)}</strong><em>{st.soloPerWeek.toFixed(1)} hrs alone</em></div>
        {appt && appt.per100 && <div className="sched-card"><span>Lost guests</span><strong>{appt.per100.all.toFixed(1)}</strong><em>per 100 cuts{apptCompany?.per100 ? ` · company ${apptCompany.per100.all.toFixed(1)}` : ''}</em></div>}
      </div>

      <Section title="Coming up: booked vs stylists" sub="Is the schedule ready for who's booked?">
        {ahead && ahead.length > 0 && <BookedHeat rows={ahead} />}
        {ahead && ahead.length > 0 && aheadBooked === 0 && <p className="section-hint">No future bookings on file yet. Upload an Appointments export that runs into the coming days, with every status.</p>}
        {(!ahead || !ahead.length) && <p className="section-hint">No schedule or bookings on file for the days ahead in this range.</p>}
      </Section>

      {appt && appt.V > 0 && (
        <Section title="When guests come in" sub="Average guests checking in each hour.">
          <HourHeat st={st} appt={appt} mode="guests" />
        </Section>
      )}

      {appt && (
        <Section title="When guests are lost" sub="Cancelled, no-shows and walkouts by hour.">
          <HourHeat st={st} appt={appt} mode="lost" />
        </Section>
      )}
      {!appt && <p className="section-hint">Upload Appointments (Setup → Historical Import) to see guests and lost guests here.</p>}

      {appt && appt.V > 0 && (
        <Section title="Staff vs guests" sub="Enough people on when guests come in?">
          <HourHeat st={st} appt={appt} mode="both" />
        </Section>
      )}

      <Section title="Who's on the floor" sub="Average people clocked in, every 15 minutes.">
        <CoverageHeatmap weekdays={WEEK_ORDER.map(i => st.weekdays[i])} />
      </Section>

      {p && p.days.length > 0 && (
        <Section title="Day-by-day plan" sub="Hours each day ahead needs vs what's scheduled.">
          <PlanTable days={p.days} target={target} />
        </Section>
      )}

      {day && (
        <Section title="One day up close" sub="Scheduled vs clocked in, person by person.">
          <div className="sched-day-pick">
            <select value={dayIdx} onChange={e => setDayIdx(Number(e.target.value))}>
              {st.days.map((dd, i) => <option key={dd.date} value={i}>{WEEKDAYS[dd.wd]} {dd.date}</option>)}
            </select>
            <span className="section-hint">{day.actual.toFixed(1)} hrs clocked, {day.serviced.toFixed(1)} serviced, {money(day.sales)} sales</span>
          </div>
          <DayTimeline day={day} />
        </Section>
      )}

      <p className="section-hint">{viewNote}</p>
    </div>
  );
}

// ─── PDF report: the 5 stores losing the most bookings ──────────────────────
// Ranked by real lost guests (cancelled + no-show + walked out) per 100 cuts,
// so a big store isn't on the list just for being big. Opens as a full-page
// preview; "Save as PDF" is the browser's print dialog.
export const REPORT_MIN_CUTS = 100; // a store needs this many cuts in range to be ranked (display choice)

export function reportStores(result, appt, n = 5) {
  if (!appt) return [];
  return Object.values(appt.stores)
    .filter(s => s.per100 && s.cuts >= REPORT_MIN_CUTS && result.stores[s.code])
    .sort((a, b) => b.per100.all - a.per100.all)
    .slice(0, n);
}

// Hours and staffing lines for one store in the PDF report (plain data, no icons).
export function staffingRead(st, a, companyRate) {
  const out = [];
  const lostHigh = companyRate != null && a.per100 && a.per100.all > companyRate;
  const atTot = a.at.reduce((x, y) => x + y, 0);
  const openTot = a.openAt.reduce((x, y) => x + y, 0);
  if (atTot >= 5 && openTot) {
    const s1 = a.at[1] / atTot, o1 = a.openAt[1] / openTot, s0 = a.at[0] / atTot;
    out.push(`Guests lost at the door with one person on: ${pct(s1)} (${a.at[1]} of ${atTot}). Share of its open hours with one person on: ${pct(o1)}.${s0 >= 0.05 ? ` With nobody clocked in: ${pct(s0)}.` : ''}`);
  }
  if (st.busy != null && st.target != null) {
    out.push(`Busy ${pct(st.busy)} (serviced hours ÷ clocked hours), target ${pct(st.target)}. Staff hours ${st.hoursPerWeek.toFixed(0)} a week, ${st.soloPerWeek.toFixed(1)} with one person alone${st.zeroPerWeek >= 0.5 ? `, ${st.zeroPerWeek.toFixed(1)} with nobody on` : ''}.`);
  }
  if (lostHigh) out.push(`Losing ${a.per100.all.toFixed(1)} guests per 100 cuts vs ${companyRate.toFixed(1)} company: hold hours, no cuts.`);
  const held = WEEK_ORDER.filter(i => st.weekdays[i].hold);
  if (held.length) out.push(`Weekdays held (losing more per cut than the company): ${held.map(i => WEEKDAYS[i]).join(', ')}.`);
  const wd = WEEK_ORDER.map(i => ({ i, lost: a.daysByWd[i] ? a.lostByWd[i] / a.daysByWd[i] : null })).filter(x => x.lost != null);
  if (wd.length >= 3) {
    const top = [...wd].sort((x, y) => y.lost - x.lost)[0];
    const avg = wd.reduce((t, x) => t + x.lost, 0) / wd.length;
    const w = st.weekdays[top.i];
    if (top.lost >= avg * 1.3 && top.lost >= 0.5) out.push(`Most lost on ${WEEKDAYS_LONG[top.i]}s: ${top.lost.toFixed(1)} a day vs ${avg.toFixed(1)} average${w.n ? `; ${pct(w.busy)} busy, ${w.soloHours.toFixed(1)} hrs alone` : ''}.`);
  }
  if (a.wait) out.push(`Reason "long wait": ${a.wait}.`);
  if (st.upcoming.length) {
    const thru = shortDate(st.upcoming[st.upcoming.length - 1].date);
    const parts = [];
    if (st.upcomingShort >= 2) parts.push(`${hrs(st.upcomingShort)} short of usual need on some days`);
    if (st.upcomingCut >= 0.5) parts.push(`${hrs(st.upcomingCut)} over on days that aren't losing guests`);
    if (parts.length) out.push(`Posted schedule through ${thru}: ${parts.join('; ')}.`);
  }
  return out;
}

const PlainList = ({ items }) => (items && items.length ? <ul className="report-list">{items.map((t, i) => <li key={i}>{typeof t === 'string' ? t : t.text}</li>)}</ul> : null);

function StaffingReport({ result, appt, storeName, dlFor, onClose }) {
  const top = reportStores(result, appt);
  const c = appt.company;
  const today = new Date();
  const list = Object.values(result.stores);
  const allA = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.actual, 0), 0);
  const allS = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.serviced, 0), 0);
  const heldDays = list.reduce((t, s) => t + s.weekdays.filter(w => w.hold).length, 0);
  return (
    <div className="report-overlay">
      <div className="report-bar no-print">
        <button className="btn-primary" onClick={() => window.print()}>Save as PDF</button>
        <button className="link-btn" onClick={onClose}>Close</button>
        <span className="section-hint">In the print window, pick "Save as PDF" as the printer.</span>
      </div>
      <div className="report">
        <section className="report-page">
          <h1>Lost bookings &amp; staffing</h1>
          <p className="report-sub">Appointments {fmtLong(appt.from)} – {fmtLong(appt.to)} · clock-ins {fmtLong(result.start)} – {fmtLong(result.end)} · made {today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
          <div className="report-cards">
            <div><span>Lost guests</span><strong>{c.lost.toLocaleString()}</strong><em>{c.per100.all.toFixed(1)} per 100 cuts</em></div>
            <div><span>At the door</span><strong>{c.door.toLocaleString()}</strong><em>{c.per100.door.toFixed(1)} per 100 cuts</em></div>
            <div><span>Cancelled ahead</span><strong>{c.ahead.toLocaleString()}</strong><em>{c.per100.ahead.toFixed(1)} per 100 cuts</em></div>
            <div><span>Serviced anyway</span><strong>{c.S.toLocaleString()}</strong><em>not counted</em></div>
            <div><span>Busy %</span><strong>{pct(allA ? allS / allA : null)}</strong><em>serviced ÷ clocked hours</em></div>
            <div><span>Store-weekdays held</span><strong>{heldDays}</strong><em>losing more than average, no cuts</em></div>
          </div>
          <h2>Findings</h2>
          <PlainList items={appt.findings.map(f => f.text.replace(/\{(\d+)\}/g, (_, x) => storeName(x)))} />
          <h2>The 5 stores losing the most bookings</h2>
          <table className="report-table">
            <thead><tr><th>#</th><th>Store</th>{dlFor && <th>DL</th>}<th>Lost / 100 cuts</th><th>Lost</th><th>At the door</th><th>Ahead</th><th>Cuts</th><th>Busy %</th><th>Staff hrs/wk</th><th>Alone hrs/wk</th></tr></thead>
            <tbody>
              {top.map((a, i) => {
                const st = result.stores[a.code];
                return (
                  <tr key={a.code}><td>{i + 1}</td><td>{storeName(a.code)}</td>{dlFor && <td>{dlFor(a.code) || '—'}</td>}<td><b>{a.per100.all.toFixed(1)}</b></td><td>{a.lost}</td><td>{a.door}</td><td>{a.ahead}</td><td>{a.cuts.toLocaleString()}</td><td>{pct(st.busy)}</td><td>{st.hoursPerWeek.toFixed(0)}</td><td>{st.soloPerWeek.toFixed(1)}</td></tr>
                );
              })}
            </tbody>
          </table>
          <p className="report-note">Ranked by lost guests per 100 cuts, stores with {REPORT_MIN_CUTS}+ cuts. Lost = marked cancelled, no-show or deleted with no sale for that guest at that store that day, excluding incorrect/duplicate/test. At the door = checked in, or cancelled/marked within {DOOR_MINUTES} minutes of the appointment time or after it. Ahead = cancelled earlier.</p>
        </section>

        {top.map((a, i) => {
          const st = result.stores[a.code];
          return (
            <section className="report-page" key={a.code}>
              <h2>{i + 1}. {storeName(a.code)}{dlFor && dlFor(a.code) ? <span className="report-dl"> · {dlFor(a.code)}</span> : null}</h2>
              <div className="report-cards">
                <div><span>Lost / 100 cuts</span><strong>{a.per100.all.toFixed(1)}</strong><em>company {c.per100.all.toFixed(1)}</em></div>
                <div><span>At the door</span><strong>{a.door}</strong><em>{a.per100.door.toFixed(1)} / 100 cuts</em></div>
                <div><span>Cancelled ahead</span><strong>{a.ahead}</strong><em>{a.per100.ahead.toFixed(1)} / 100 cuts</em></div>
                <div><span>Busy %</span><strong>{pct(st.busy)}</strong><em>target {pct(st.target)}</em></div>
                <div><span>Staff hrs / week</span><strong>{st.hoursPerWeek.toFixed(0)}</strong><em>{st.soloPerWeek.toFixed(1)} alone</em></div>
                <div><span>Cuts</span><strong>{a.cuts.toLocaleString()}</strong><em>{a.S} serviced anyway, not counted</em></div>
              </div>
              <h3>Hours and staffing</h3>
              <PlainList items={staffingRead(st, a, c.per100.all)} />
              <p className="report-note">As entered by staff: {a.C} cancelled, {a.N} no-show, {a.W} walked out. {a.X} marked incorrect/duplicate/test (not counted).{a.F ? ` ${a.F} started then deleted with no sale (Loss Prevention).` : ''}</p>
              <h3>By day of the week</h3>
              <table className="report-table">
                <thead><tr><th>Day</th><th>Usual hours</th><th>Staff hrs</th><th>Busy %</th><th>Alone hrs</th><th>Lost / day</th><th>Lost / 100 cuts</th><th>Notes</th></tr></thead>
                <tbody>
                  {WEEK_ORDER.map(wdI => st.weekdays[wdI]).filter(w => w.n).map(w => (
                    <tr key={w.wd} className={w.hold ? 'report-hold' : ''}>
                      <td>{WEEKDAYS[w.wd]}</td>
                      <td className="report-nowrap">{w.open != null ? `${slotLabel(w.open).replace(':00', '')}–${slotLabel(w.close).replace(':00', '')}` : '—'}</td>
                      <td>{w.actual.toFixed(1)}</td>
                      <td>{pct(w.busy)}</td>
                      <td>{w.soloHours.toFixed(1)}</td>
                      <td>{a.daysByWd[w.wd] ? (a.lostByWd[w.wd] / a.daysByWd[w.wd]).toFixed(1) : '—'}</td>
                      <td>{w.lostRate != null ? w.lostRate.toFixed(1) : '—'}</td>
                      <td className="report-wrap">{w.hold ? 'Hold hours. ' : ''}{w.advice.filter(x => x.kind !== 'payroll' && !/^Hold hours/.test(x.text)).slice(0, 2).map(x => x.text).join(' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Staff on and lost guests, by hour</h3>
              <HourHeat st={st} appt={a} mode="both" />
            </section>
          );
        })}
        <section className="report-foot">
          <p className="report-note">Method. Lost guests: Appointments report rows marked cancelled, no-show or deleted, checked against Sales-Accrual (same guest, same store, same day = serviced, not lost; Sales-Accrual has no time of sale). Labels are entered by staff and overlap, so the report splits by timing instead. Busy % = serviced hours ÷ clocked hours (Attendance report). Each lost guest counts as {Math.round(GUEST_HOURS * 60)} minutes of needed stylist time. A store-weekday losing more guests per 100 cuts than the company is held: no cut suggestions. Elsewhere, suggested cuts only trim shift edges where 3+ are on, never leave one person alone and never shorten a shift under {MIN_SHIFT_HOURS} hours.</p>
        </section>
      </div>
    </div>
  );
}
export { StaffingReport };

export function SchedulingTab({ shiftHistory, loadedMonths, onNeedMonths, salesFor, cutsFor = null, hoursFor = null, apptHistory = null, storeName, dlFor, loading }) {
  const today = localISO(new Date());
  const presets = useMemo(() => rangePresets(today), [today]);
  const [range, setRange] = useState({ id: 'next2', start: presets[0].start, end: presets[0].end });
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState('');
  const [report, setReport] = useState(false);
  const [target, setTarget] = useState(() => { try { return Number(localStorage.getItem(TARGET_KEY)) || null; } catch { return null; } });
  const latest = useMemo(() => lastWorkedDate(shiftHistory), [shiftHistory]);
  const hasAhead = useMemo(() => upcomingDates(shiftHistory, latest).length > 0, [shiftHistory, latest]);
  const { start, end } = range;
  const pickPreset = id => { const p = presets.find(x => x.id === id); if (p) setRange({ id, start: p.start, end: p.end }); };
  const setDate = (k, v) => { if (!v) return; setRange(r => { const n = { ...r, id: 'custom', [k]: v }; if (n.start > n.end) { if (k === 'start') n.end = v; else n.start = v; } return n; }); };

  // Months to load: the usual-week history before the latest day worked,
  // through the end of the range.
  useEffect(() => {
    if (!onNeedMonths) return;
    const from = [start, addDays(latest || today, -BASE_WEEKS * 7)].sort()[0];
    const missing = monthsBetween(from, end).filter(m => !loadedMonths.has(m));
    if (missing.length) onNeedMonths(missing);
  }, [start, end, latest, today, loadedMonths, onNeedMonths]);

  const lostFor = useMemo(() => {
    const cache = {};
    return (s, e) => {
      if (!apptHistory) return null;
      const k = `${s}|${e}`;
      if (!(k in cache)) cache[k] = lostForSchedules(analyzeAppointments({ apptHistory, start: s, end: e, cutsFor }));
      return cache[k];
    };
  }, [apptHistory, cutsFor]);
  const plan = useMemo(() => (latest ? planSchedules({ shiftHistory, rangeStart: start, rangeEnd: end, salesFor, cutsFor, hoursFor, targetBusy: target ? target / 100 : null, lostFor, today }) : null),
    [shiftHistory, start, end, salesFor, cutsFor, hoursFor, target, lostFor, today, latest]);
  const result = plan ? plan.view : null;
  const appt = useMemo(() => (apptHistory && plan ? analyzeAppointments({ apptHistory, start: plan.viewStart, end: plan.viewEnd, cutsFor, sched: result, shiftHistory }) : null), [apptHistory, plan, result, cutsFor, shiftHistory]);
  const saveTarget = v => { setTarget(v); try { if (v) localStorage.setItem(TARGET_KEY, String(v)); else localStorage.removeItem(TARGET_KEY); } catch { /* per-viewer only */ } };

  if (!latest) {
    if (loading) return <div className="tab-content"><p>Loading shift times…</p></div>;
    return (
      <div className="tab-content">
        <h2 className="chart-title">Scheduling</h2>
        <p>{hasAhead ? 'A schedule ahead is on file, but no worked days yet, so there is no usual week to plan from.' : 'No shift times yet.'} Shift times come from the Attendance report: upload Attendance files in Setup → Historical Import and the shift times are saved along with the hours. Files uploaded before 2026-11-10 need uploading again.</p>
      </div>
    );
  }
  if (report && appt) return <StaffingReport result={result} appt={appt} storeName={storeName} dlFor={dlFor} onClose={() => setReport(false)} />;

  const viewNote = plan.view === plan.range
    ? `Heat maps and busy %: clock-ins ${fmtLong(plan.viewStart)} – ${fmtLong(plan.viewEnd)}.`
    : `Heat maps and busy %: a usual week, from clock-ins ${fmtLong(plan.viewStart)} – ${fmtLong(plan.viewEnd)} (holiday weeks left out).`;
  const controls = (
    <div className="sched-controls">
      <select value={range.id} onChange={e => pickPreset(e.target.value)} aria-label="Date range">
        {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        {range.id === 'custom' && <option value="custom">Custom dates</option>}
      </select>
      <label>From <input type="date" value={start} onChange={e => setDate('start', e.target.value)} /></label>
      <label>To <input type="date" value={end} onChange={e => setDate('end', e.target.value)} /></label>
      <label title={'"Busy %" = serviced hours ÷ clocked hours'}>Busy target <input type="number" min="20" max="95" placeholder={plan.base.groupTarget ? String(Math.round(plan.base.groupTarget * 100)) : 'auto'} value={target || ''} onChange={e => saveTarget(e.target.value ? Math.max(20, Math.min(95, Number(e.target.value))) : null)} />%</label>
    </div>
  );

  if (open && result.stores[open]) {
    return (
      <div className="tab-content">
        {controls}
        <StoreDetail st={result.stores[open]} p={plan.stores[open]} storeName={storeName} onBack={() => setOpen(null)} target={plan.target}
          appt={appt?.stores[open] || null} apptCompany={appt?.company || null} viewNote={viewNote}
          ahead={bookedVsStaff({ code: open, shiftHistory, apptHistory, start, end, today })} />
      </div>
    );
  }

  const list = Object.values(result.stores).filter(st => !search || storeName(st.code).toLowerCase().includes(search.toLowerCase()) || st.code.includes(search));
  const sorted = [...list].sort((a, b) => ((plan.stores[b.code]?.save.total || 0) - (plan.stores[a.code]?.save.total || 0)) || ((plan.stores[b.code]?.grow.total || 0) - (plan.stores[a.code]?.grow.total || 0)));
  const tot = k => list.reduce((t, s) => t + (s[k] || 0), 0);
  const allA = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.actual, 0), 0);
  const allS = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.serviced, 0), 0);
  const saveTot = list.reduce((t, s) => t + (plan.stores[s.code]?.save.total || 0), 0);
  const growTot = list.reduce((t, s) => t + (plan.stores[s.code]?.grow.total || 0), 0);
  const showLost = !!appt;

  return (
    <div className="tab-content">
      <h2 className="chart-title">Scheduling</h2>
      <p className="sched-sec-sub">Where to cut hours to protect TSTH, and where to add hours to grow sales.</p>
      {controls}
      <div className="sched-controls">
        <input type="search" placeholder="Search stores" value={search} onChange={e => setSearch(e.target.value)} />
        {showLost && <button className="btn-secondary sched-report-btn" onClick={() => setReport(true)}>📄 PDF report</button>}
      </div>
      <p className="section-hint" title={plan.future.length ? "Days after the latest clock-ins are planned from each store's usual week and last year's cuts on the same day. Cuts never leave anyone working alone." : 'Cuts never leave anyone working alone.'}>{fmtLong(start)} – {fmtLong(end)} · clock-ins through {fmtLong(latest)}</p>

      <div className="sched-cards">
        <div className="sched-card"><span>Busy %</span><strong>{pct(allA ? allS / allA : null)}</strong><em>time spent on guests · target {target ? `${target}%` : pct(plan.target)}</em></div>
        <div className="sched-card"><span>Staff hrs / week</span><strong>{Math.round(tot('hoursPerWeek')).toLocaleString()}</strong><em>{list.length} stores</em></div>
        <div className="sched-card"><span>Hours to cut</span><strong>{saveTot.toFixed(0)}</strong><em>nobody left alone</em></div>
        <div className="sched-card"><span>Hours to add</span><strong>{growTot.toFixed(0)}</strong><em>on busy days</em></div>
        {showLost && appt.company.per100 && <div className="sched-card"><span>Lost guests</span><strong>{appt.company.per100.all.toFixed(1)}</strong><em>per 100 cuts</em></div>}
      </div>

      <div className="sched-table-wrap">
        <table className="ledger-table">
          <thead><tr><th className="ledger-name-col">Store</th>{dlFor && <th className="sched-col-opt">DL</th>}<th>Busy %</th><th className="sched-col-opt">Hrs / wk</th>{showLost && <th>Lost / 100 cuts</th>}<th className="sched-tip-cell">✂️ Cut hours</th><th className="sched-tip-cell">📈 Add hours</th></tr></thead>
          <tbody>
            {sorted.map(st => {
              const a = appt?.stores[st.code];
              const p = plan.stores[st.code];
              return (
                <tr key={st.code} className="sched-click" onClick={() => setOpen(st.code)}>
                  <td className="ledger-name-col"><span className="sched-storelink">{storeName(st.code)}</span></td>
                  {dlFor && <td className="sched-col-opt">{dlFor(st.code) || '—'}</td>}
                  <td className={st.busy == null ? '' : st.busy < st.target - 0.05 ? 'sched-cool' : st.busy > st.target + BUSY_GAP_PTS ? 'sched-hot' : ''}>{pct(st.busy)}</td>
                  <td className="sched-col-opt">{st.hoursPerWeek.toFixed(0)}</td>
                  {showLost && <td className={a?.per100 && appt.company.per100 && a.per100.all >= appt.company.per100.all * 1.25 ? 'sched-warn' : ''}>{a?.per100 ? a.per100.all.toFixed(1) : '—'}</td>}
                  {p ? <TipCell t={p.save} /> : <td className="sched-tip-cell">—</td>}
                  {p ? <TipCell t={p.grow} /> : <td className="sched-tip-cell">—</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="section-hint">Tap a store for its heat maps and day-by-day plan. Busy %: blue = under target, orange = well over.</p>
    </div>
  );
}
