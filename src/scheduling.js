import React, { useEffect, useMemo, useState } from 'react';
import { readWorkbookGrid } from './parser';

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
export function safeTrimPlan(recs, targetHours) {
  // Only people who actually worked that day: a call-out's scheduled shift
  // isn't real coverage, so counting it could leave someone alone.
  const worked = recs.filter(r => r[5] > 0 || (r[4] && r[4].length));
  const people = worked.map(r => ({ name: r[0], iv: schedInterval(r) })).filter(p => p.iv && p.iv[1] > p.iv[0]);
  const counts = countsFrom(people.map(p => [p.iv]));
  const minSlots = (MIN_SHIFT_HOURS * 60) / SLOT;
  const cuts = people.map(p => ({ name: p.name, from: [...p.iv], start: 0, end: 0 }));
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
  const before = countsFrom(worked.map(schedInterval).filter(Boolean).map(iv => [iv]));
  const ok = counts.every((c, s) => before[s] < MIN_ON_AFTER_CUT || c >= MIN_ON_AFTER_CUT);
  const list = cuts.map((c, i) => ({ ...c, to: people[i].iv })).filter(c => c.start || c.end).map(c => ({
    name: c.name, hours: ((c.start + c.end) * SLOT) / 60,
    was: `${slotLabel(c.from[0])}–${slotLabel(c.from[1])}`, now: `${slotLabel(c.to[0])}–${slotLabel(c.to[1])}`,
  }));
  return { cuts: ok ? list : [], hours: ok ? (trimmed * SLOT) / 60 : 0, ok };
}

// ─── Analysis ───────────────────────────────────────────────────────────────
// shiftHistory: { date: { code: recs } }; salesFor(code, date) → $ (service + retail).
// Returns per-store results for dates in [start, end].
export function analyzeSchedules({ shiftHistory, start, end, salesFor, codes = null, targetBusy = null }) {
  const byStore = {};
  Object.entries(shiftHistory || {}).forEach(([date, stores]) => {
    if (date < start || date > end) return;
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
      let solo = 0, zero = 0, peak3 = 0;
      const zeroDays = [];
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
      // Extra hours: clocked beyond what the busy target needs, capped at what
      // can be cut without leaving anyone alone (from each day's schedule).
      let extra = 0, trimmable = 0;
      ds.forEach(d => {
        const over = st.target ? Math.max(0, d.actual - d.serviced / st.target) : 0;
        extra += over;
        if (over >= 0.25) trimmable += safeTrimPlan(d.recs, over).hours;
      });
      const latest = ds[ds.length - 1];
      const latestOver = st.target ? Math.max(0, latest.actual - latest.serviced / st.target) : 0;
      return {
        wd, n, open, close, avg,
        actual: actual / n, serviced: serviced / n, sales: sales / n,
        busy, salesPerHour: actual > 0 && sales > 0 ? sales / actual : null,
        soloHours: (solo * SLOT) / 60 / n, zeroHours: (zero * SLOT) / 60 / n, peakHours: (peak3 * SLOT) / 60 / n,
        zeroDays, extra: extra / n, trimmable: trimmable / n,
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
  });
  return { stores, groupTarget, start, end };
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

// ─── Tilly ──────────────────────────────────────────────────────────────────
export function schedulingContext(result, storeName) {
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
      line += ` By day: ${wd}. Tips: ${st.tips.slice(0, 3).map(t => t.text).join(' ') || 'none'}`;
    }
    lines.push(line);
  });
  return lines.join('\n');
}

// ─── UI ─────────────────────────────────────────────────────────────────────
const RANGE_PRESETS = [{ weeks: 2, label: '2 weeks' }, { weeks: 4, label: '4 weeks' }, { weeks: 8, label: '8 weeks' }, { weeks: 13, label: '13 weeks' }];
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const monthsBetween = (a, b) => { const out = []; for (let m = a.slice(0, 7); m <= b.slice(0, 7);) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } return out; };
const TARGET_KEY = 'supercuts_sched_target';
const TIP_ICON = { grow: '📈', move: '↔️', trim: '✂️', gap: '⚠️', payroll: '💵' };

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
        <span className="section-hint">Average people clocked in, by 15 minutes. Blank = outside usual hours.</span>
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
      <p className="section-hint">Light bar = scheduled, dark bar = clocked in. Orange = one person alone, red = nobody on, during the day's scheduled hours.</p>
    </div>
  );
}

function StoreDetail({ st, storeName, onBack }) {
  const [dayIdx, setDayIdx] = useState(st.days.length - 1);
  const day = st.days[Math.min(dayIdx, st.days.length - 1)];
  const plans = st.weekdays.filter(w => w.n && w.plan && w.plan.cuts.length);
  return (
    <div>
      <button className="link-btn" onClick={onBack}>← All stores</button>
      <h3 className="chart-title">{storeName(st.code)}</h3>
      <div className="sched-cards">
        <div className="sched-card"><span>Hours / week</span><strong>{st.hoursPerWeek.toFixed(0)}</strong></div>
        <div className="sched-card"><span>Busy %</span><strong>{pct(st.busy)}</strong><em>target {pct(st.target)}</em></div>
        <div className="sched-card"><span>Sales / labor hr</span><strong>{money(st.salesPerHour)}</strong></div>
        <div className="sched-card"><span>Alone / week</span><strong>{st.soloPerWeek.toFixed(1)}</strong><em>hrs, one person on</em></div>
        <div className="sched-card"><span>Could cut / week</span><strong>{st.trimPerWeek.toFixed(1)}</strong><em>hrs, nobody left alone</em></div>
        <div className="sched-card"><span>Over schedule</span><strong>{st.overSched.toFixed(1)}</strong><em>hrs in range</em></div>
      </div>

      {st.tips.length > 0 && (
        <div className="sched-tips">
          <p className="chart-title">Tips</p>
          <ul>{st.tips.map((t, i) => <li key={i}><span>{TIP_ICON[t.kind]}</span>{t.text}</li>)}</ul>
        </div>
      )}

      <p className="chart-title">When people are on</p>
      <CoverageHeatmap weekdays={st.weekdays} />

      <p className="chart-title">By day of the week</p>
      <div className="sched-table-wrap">
        <table className="ledger-table">
          <thead><tr><th className="ledger-name-col">Day</th><th>Days</th><th>Usual hours</th><th>Hrs / day</th><th>Busy %</th><th>Sales / day</th><th>Sales / hr</th><th>Alone</th><th>Nobody on</th><th>Could cut</th></tr></thead>
          <tbody>
            {st.weekdays.filter(w => w.n).map(w => (
              <tr key={w.wd}>
                <td className="ledger-name-col">{WEEKDAYS_LONG[w.wd]}</td>
                <td>{w.n}</td>
                <td>{w.open != null ? `${slotLabel(w.open)}–${slotLabel(w.close)}` : '—'}</td>
                <td>{w.actual.toFixed(1)}</td>
                <td className={w.busy == null ? '' : w.busy >= st.target + BUSY_GAP_PTS ? 'sched-hot' : w.busy < st.target ? 'sched-cool' : ''}>{pct(w.busy)}</td>
                <td>{money(w.sales)}</td>
                <td>{money(w.salesPerHour)}</td>
                <td>{w.soloHours.toFixed(1)}</td>
                <td>{w.zeroHours.toFixed(1)}</td>
                <td><b>{w.trimmable.toFixed(1)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="section-hint">Hours are per day, averaged over the days in range. "Could cut" is the clocked time beyond the busy target that can come off shift edges while at least {MIN_ON_AFTER_CUT} people stay on.</p>

      {plans.length > 0 && (
        <>
          <p className="chart-title">Suggested cuts (nobody left alone)</p>
          <p className="section-hint">Built from the most recent of each day's schedule. A cut only trims the start or end of a shift during times 3+ people were scheduled, so at least {MIN_ON_AFTER_CUT} stay on the whole time, and no shift goes under {MIN_SHIFT_HOURS} hours. Times already at 1 or 2 people are never touched.</p>
          {plans.map(w => (
            <div key={w.wd} className="sched-plan">
              <p><b>{WEEKDAYS_LONG[w.wd]}</b> (from {w.plan.date}): {hrs(w.plan.hours)} off</p>
              <ul>{w.plan.cuts.map((c, i) => <li key={i}>{c.name}: {c.was} → <b>{c.now}</b> (−{hrs(c.hours)})</li>)}</ul>
            </div>
          ))}
        </>
      )}

      <p className="chart-title">One day up close</p>
      <div className="sched-day-pick">
        <button className="link-btn" disabled={dayIdx <= 0} onClick={() => setDayIdx(i => Math.max(0, i - 1))}>‹</button>
        <select value={dayIdx} onChange={e => setDayIdx(Number(e.target.value))}>
          {st.days.map((dd, i) => <option key={dd.date} value={i}>{WEEKDAYS[dd.wd]} {dd.date}</option>)}
        </select>
        <button className="link-btn" disabled={dayIdx >= st.days.length - 1} onClick={() => setDayIdx(i => Math.min(st.days.length - 1, i + 1))}>›</button>
        <span className="section-hint">{day.actual.toFixed(1)} hrs clocked, {day.serviced.toFixed(1)} serviced, {money(day.sales)} sales</span>
      </div>
      <DayTimeline day={day} />
    </div>
  );
}

export function SchedulingTab({ shiftHistory, loadedMonths, onNeedMonths, salesFor, storeName, dlFor, loading }) {
  const latest = useMemo(() => Object.keys(shiftHistory || {}).sort().pop() || null, [shiftHistory]);
  const [weeks, setWeeks] = useState(4);
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState(() => { try { return Number(localStorage.getItem(TARGET_KEY)) || null; } catch { return null; } });
  const end = latest;
  const start = end ? addDays(end, -(weeks * 7) + 1) : null;

  useEffect(() => {
    if (!start || !end || !onNeedMonths) return;
    const missing = monthsBetween(start, end).filter(m => !loadedMonths.has(m));
    if (missing.length) onNeedMonths(missing);
  }, [start, end, loadedMonths, onNeedMonths]);

  const result = useMemo(() => (start ? analyzeSchedules({ shiftHistory, start, end, salesFor, targetBusy: target ? target / 100 : null }) : null), [shiftHistory, start, end, salesFor, target]);
  const saveTarget = v => { setTarget(v); try { if (v) localStorage.setItem(TARGET_KEY, String(v)); else localStorage.removeItem(TARGET_KEY); } catch { /* per-viewer only */ } };

  if (!latest) {
    if (loading) return <div className="tab-content"><p>Loading shift times…</p></div>;
    return (
      <div className="tab-content">
        <h2 className="chart-title">Scheduling</h2>
        <p>No shift times yet. They come from the Attendance report: upload Attendance files in Setup → Historical Import and the shift times are saved along with the hours. Files uploaded before 2026-11-10 need uploading again.</p>
      </div>
    );
  }

  const list = Object.values(result.stores).filter(st => !search || storeName(st.code).toLowerCase().includes(search.toLowerCase()) || st.code.includes(search));
  if (open && result.stores[open]) {
    return <div className="tab-content"><StoreDetail st={result.stores[open]} storeName={storeName} onBack={() => setOpen(null)} /></div>;
  }
  const sorted = [...list].sort((a, b) => b.trimPerWeek - a.trimPerWeek);
  const tot = k => list.reduce((t, s) => t + (s[k] || 0), 0);
  const allA = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.actual, 0), 0);
  const allS = list.reduce((t, s) => t + s.days.reduce((x, d) => x + d.serviced, 0), 0);
  const allSales = tot('sales');

  return (
    <div className="tab-content">
      <h2 className="chart-title">Scheduling</h2>
      <p className="section-hint">Hours, coverage gaps and payroll from the Attendance report's shift times, {start} to {end} (the latest day uploaded). Suggested cuts never leave anyone working alone.</p>
      <div className="sched-controls">
        <div className="view-toggle" role="group" aria-label="Range">{RANGE_PRESETS.map(p => <button key={p.weeks} className={`view-toggle-btn ${weeks === p.weeks ? "active" : ""}`} onClick={() => setWeeks(p.weeks)}>{p.label}</button>)}</div>
        <label>Busy target <input type="number" min="20" max="95" placeholder={result.groupTarget ? String(Math.round(result.groupTarget * 100)) : 'auto'} value={target || ''} onChange={e => saveTarget(e.target.value ? Math.max(20, Math.min(95, Number(e.target.value))) : null)} />%</label>
        <input type="search" placeholder="Search stores" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <p className="section-hint">"Busy %" = serviced hours ÷ clocked hours. Target {target ? `${target}% (yours, this browser)` : result.groupTarget ? `${pct(result.groupTarget)}, the middle store of the ones shown` : "each store's own average"}. Type a number to change it.</p>

      <div className="sched-cards">
        <div className="sched-card"><span>Stores</span><strong>{list.length}</strong></div>
        <div className="sched-card"><span>Hours / week</span><strong>{Math.round(tot('hoursPerWeek')).toLocaleString()}</strong></div>
        <div className="sched-card"><span>Busy %</span><strong>{pct(allA ? allS / allA : null)}</strong></div>
        <div className="sched-card"><span>Sales / labor hr</span><strong>{money(allA && allSales ? allSales / allA : null)}</strong></div>
        <div className="sched-card"><span>Alone / week</span><strong>{tot('soloPerWeek').toFixed(0)}</strong><em>hrs, one person on</em></div>
        <div className="sched-card"><span>Could cut / week</span><strong>{tot('trimPerWeek').toFixed(0)}</strong><em>hrs, nobody left alone</em></div>
      </div>

      <div className="sched-table-wrap">
        <table className="ledger-table">
          <thead><tr><th className="ledger-name-col">Store</th>{dlFor && <th>DL</th>}<th>Hrs / wk</th><th>Busy %</th><th>Sales / hr</th><th>Alone hrs / wk</th><th>Nobody on</th><th>Could cut / wk</th><th>Over sched.</th><th>Call-outs</th><th>Top tip</th></tr></thead>
          <tbody>
            {sorted.map(st => (
              <tr key={st.code} className="sched-click" onClick={() => setOpen(st.code)}>
                <td className="ledger-name-col"><button className="link-btn">{storeName(st.code)}</button></td>
                {dlFor && <td>{dlFor(st.code) || '—'}</td>}
                <td>{st.hoursPerWeek.toFixed(0)}</td>
                <td className={st.busy == null ? '' : st.busy < st.target - 0.05 ? 'sched-cool' : st.busy > st.target + BUSY_GAP_PTS ? 'sched-hot' : ''}>{pct(st.busy)}</td>
                <td>{money(st.salesPerHour)}</td>
                <td>{st.soloPerWeek.toFixed(1)}</td>
                <td className={st.zeroPerWeek >= 0.5 ? 'sched-warn' : ''}>{st.zeroPerWeek.toFixed(1)}</td>
                <td><b>{st.trimPerWeek.toFixed(1)}</b></td>
                <td>{st.overSched.toFixed(1)}</td>
                <td>{st.callOuts}</td>
                <td className="sched-tip-cell">{st.tips[0] ? `${TIP_ICON[st.tips[0].kind]} ${st.tips[0].text.split('. ')[0]}.` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="section-hint">Sorted by hours that could come off each week without anyone working alone. Blue busy % = under target, orange = well over (likely short-staffed). Tap a store for its hour-by-hour coverage, tips, a cut plan and a day-by-day view.</p>
    </div>
  );
}
