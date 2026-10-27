// Loss Prevention (owner-only). Parses the detail-level columns of three
// POS exports into compact per-day data, and turns a date range of that data
// into "items to review" — never conclusions. Storage is the separate
// `loss_prevention` Supabase table behind api/loss-prevention.js (not
// weekly_report, which the public anon key can read).
//
//   Sales-Accrual — needs Payment Type, Sale Type, Price, Discount Name,
//                   Guest Name and Closed By (the newer export layout).
//   Attendance    — needs Serviced Hours and Missed Check-Ins/Checkouts.
//   Register Closure — its own upload, on the Loss Prevention tab.
//
// Each parse returns { rangeStart, rangeEnd, days }. A re-upload replaces
// every day in the file's From/To range (all stores), same as gift cards.
import { readWorkbookGrid } from './parser';

// Flag thresholds. Defaults picked to surface outliers, not set by
// leadership; change them here.
export const LP_RULES = {
  zeroMin: 3,              // $0 services in range
  priceBelowAmt: 20,       // $ rung under list price with no discount to explain it
  loyaltyRateX: 2.5,       // loyalty-redemption share of closed tickets, × company rate
  loyaltyMinClosed: 100,   // ...only for people who closed at least this many
  empDiscNonStaffMin: 2,   // employee discount used on a guest who isn't a staff name
  refundMin: 2,            // refunds processed (any cash refund also flags)
  cashShareX: 1.5,         // cash-only share of tickets, × own store's share
  cashMinTickets: 100,     // ...only for stylists with at least this many tickets
  regShortMin: 3,          // register closures that came in short...
  regShortAmt: 5,          // ...by at least this much (pennies off isn't a shortage)
  regVagueMin: 3,          // register adjustments with no real reason ("idk", ".", "?")
  regBigAdj: 20,           // a single adjustment this big ($, either way) is listed
  idleHours: 4,            // clocked this long with 0 tickets and 0 serviced hours...
  idleDaysMin: 2,          // ...on at least this many days
  missedPunchMin: 3,       // missed check-ins + checkouts
};

const cellText = c => String(c?.w ?? c?.v ?? '').trim();
const numOf = c => {
  const v = c?.v;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
};
const r2 = n => Math.round(n * 100) / 100;
export const lpNorm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim();
const extractCode = t => { const m = String(t).match(/^\s*(\d+)/); return m ? String(parseInt(m[1], 10)) : null; };
const toISO = t => {
  const m = String(t).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const headerISO = t => {
  const m = String(t).match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

function readHeader(grid, firstColLabel, required) {
  const hdr = grid.findIndex(row => row.some(c => cellText(c).toLowerCase() === firstColLabel.toLowerCase()));
  if (hdr === -1) throw new Error(`Could not find a "${firstColLabel}" column in this file.`);
  const col = {};
  grid[hdr].forEach((c, i) => { const k = cellText(c).toLowerCase(); if (k && !(k in col)) col[k] = i; });
  const missing = required.filter(k => !(k.toLowerCase() in col));
  let rangeStart = null, rangeEnd = null;
  for (let r = 0; r < hdr; r++) {
    const text = grid[r].map(cellText).join(' ');
    const from = text.match(/From\s*:\s*([^:]+?)\s+To\s*:/i);
    const to = text.match(/To\s*:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
    if (from && to) { rangeStart = headerISO(from[1]); rangeEnd = headerISO(to[1]); break; }
  }
  return { hdr, col: k => col[k.toLowerCase()] ?? -1, missing, rangeStart, rangeEnd };
}

function finishRange(h, days) {
  const dates = Object.keys(days).sort();
  return { rangeStart: h.rangeStart || dates[0] || null, rangeEnd: h.rangeEnd || dates[dates.length - 1] || null, days };
}

// Price is optional: without it, only the price-below-list check is skipped.
const LP_SALES_COLS = ['Center Name', 'Item Type', 'Item Name', 'Qty', 'Sales (Exc. Tax)', 'Sale Date', 'Invoice No', 'Guest Name', 'Stylist', 'Sold By', 'Discount Name', 'Discount', 'Payment Type', 'Sale Type', 'Closed By'];

// days[date][code] = {
//   s:  { stylist: [tickets, cashOnlyTickets] },
//   c:  { closer: [closedTickets, loyaltyTickets] },
//   ev: [ {t:'z'|'p'|'r'|'e', ...} ]   $0 service / price below list / refund / employee discount
// }
export async function parseLpSalesFile(file) {
  const grid = await readWorkbookGrid(file);
  const h = readHeader(grid, 'Center Name', LP_SALES_COLS);
  if (h.missing.length) throw new Error(`missing columns for Loss Prevention: ${h.missing.join(', ')}`);
  const C = Object.fromEntries([...LP_SALES_COLS, 'Price'].map(k => [k, h.col(k)]));
  const invoices = new Map();
  const days = {};
  const dayStore = (date, code) => {
    const d = (days[date] = days[date] || {});
    return (d[code] = d[code] || { s: {}, c: {}, ev: [] });
  };
  for (let r = h.hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const code = extractCode(cellText(row[C['Center Name']]));
    const date = toISO(cellText(row[C['Sale Date']]));
    if (!code || !date) continue;
    const inv = cellText(row[C['Invoice No']]);
    const type = cellText(row[C['Item Type']]);
    const item = cellText(row[C['Item Name']]);
    const qty = numOf(row[C.Qty]);
    const sales = numOf(row[C['Sales (Exc. Tax)']]);
    const price = C.Price === -1 ? 0 : numOf(row[C.Price]);
    const disc = numOf(row[C.Discount]);
    const discName = cleanName(cellText(row[C['Discount Name']]));
    const refund = /refund/i.test(cellText(row[C['Sale Type']]));
    const stylist = cleanName(cellText(row[C.Stylist])) || cleanName(cellText(row[C['Sold By']]));
    const closer = cleanName(cellText(row[C['Closed By']]));
    const pay = cellText(row[C['Payment Type']]);
    const guest = cleanName(cellText(row[C['Guest Name']]));
    const ds = dayStore(date, code);

    if (inv) {
      if (!invoices.has(inv)) invoices.set(inv, { date, code, pay, closer, guest, refund, stylists: new Set(), loyalty: false, empDisc: 0 });
      const o = invoices.get(inv);
      if (stylist) o.stylists.add(stylist);
      if (/loyalty/i.test(discName)) o.loyalty = true;
      if (/employee/i.test(discName)) o.empDisc += disc;
      if (refund) o.refund = true;
    }
    if (refund) {
      ds.ev.push({ t: 'r', inv, n: closer || stylist, i: item, a: r2(sales), pay, why: cleanName(cellText(row[h.col('Refund Reason')])) });
    } else if (type === 'Service' && qty > 0 && sales === 0) {
      ds.ev.push({ t: 'z', inv, n: stylist, i: item, dn: discName });
    } else if (price > 0 && qty > 0 && sales < price * qty - disc - 0.01) {
      ds.ev.push({ t: 'p', inv, n: stylist, i: item, l: r2(price * qty), a: r2(sales), dn: discName });
    }
  }
  invoices.forEach((o, inv) => {
    if (o.refund) return;
    const ds = dayStore(o.date, o.code);
    const cashOnly = o.pay === 'Cash' ? 1 : 0;
    o.stylists.forEach(p => { const a = (ds.s[p] = ds.s[p] || [0, 0]); a[0]++; a[1] += cashOnly; });
    if (o.closer) { const a = (ds.c[o.closer] = ds.c[o.closer] || [0, 0]); a[0]++; a[1] += o.loyalty ? 1 : 0; }
    if (o.empDisc > 0) ds.ev.push({ t: 'e', inv, n: o.closer, g: o.guest, a: r2(o.empDisc) });
  });
  return finishRange(h, days);
}

// days[date][code] = { employee: [actualHours, servicedHours, missedIn, missedOut, isStylist] }
export async function parseLpAttendanceFile(file) {
  const grid = await readWorkbookGrid(file);
  const h = readHeader(grid, 'Employee Name', ['Date', 'Employee Name', 'Job', 'Work Center', 'Actual Hours', 'Serviced Hours', 'Missed Check-Ins', 'Missed Checkouts']);
  if (h.missing.length) throw new Error(`missing columns for Loss Prevention: ${h.missing.join(', ')}`);
  const days = {};
  for (let r = h.hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const date = toISO(cellText(row[h.col('Date')]));
    const code = extractCode(cellText(row[h.col('Work Center')]));
    const name = cleanName(cellText(row[h.col('Employee Name')]));
    if (!date || !code || !name) continue;
    const d = (days[date] = days[date] || {});
    const s = (d[code] = d[code] || {});
    const a = (s[name] = s[name] || [0, 0, 0, 0, 0]);
    a[0] = r2(a[0] + numOf(row[h.col('Actual Hours')]));
    a[1] = r2(a[1] + numOf(row[h.col('Serviced Hours')]));
    a[2] += /^yes$/i.test(cellText(row[h.col('Missed Check-Ins')])) ? 1 : 0;
    a[3] += /^yes$/i.test(cellText(row[h.col('Missed Checkouts')])) ? 1 : 0;
    if (/stylist/i.test(cellText(row[h.col('Job')]))) a[4] = 1;
  }
  return finishRange(h, days);
}

// days[date] = [ [code, cashAdjustment, reason, submittedBy, cashPaid] ]
export async function parseLpRegisterFile(file) {
  const grid = await readWorkbookGrid(file);
  const h = readHeader(grid, 'Register Name', ['Closure Date', 'Cash Adjustments', 'Cash Adjustment Reason', 'Cash Paid', 'Submitted By', 'Center Name']);
  if (h.missing.length) throw new Error(`This doesn't look like the Register Closure report (missing: ${h.missing.join(', ')}).`);
  const days = {};
  let count = 0;
  for (let r = h.hdr + 1; r < grid.length; r++) {
    const row = grid[r];
    const date = toISO(cellText(row[h.col('Closure Date')]));
    const code = extractCode(cellText(row[h.col('Center Name')]));
    if (!date || !code) continue;
    (days[date] = days[date] || []).push([
      code, r2(numOf(row[h.col('Cash Adjustments')])), cleanName(cellText(row[h.col('Cash Adjustment Reason')])),
      cleanName(cellText(row[h.col('Submitted By')])), r2(numOf(row[h.col('Cash Paid')])),
    ]);
    count++;
  }
  if (!count) throw new Error('No register closures found in this file.');
  return finishRange(h, days);
}

// Replace every day in the parsed range, keep everything else. Returns the
// new days map plus the months touched (for saving).
export function mergeLpDays(existing, parsed) {
  const next = {};
  const inRange = d => parsed.rangeStart && parsed.rangeEnd && d >= parsed.rangeStart && d <= parsed.rangeEnd;
  Object.entries(existing || {}).forEach(([d, v]) => { if (!inRange(d)) next[d] = v; });
  Object.entries(parsed.days).forEach(([d, v]) => { next[d] = v; });
  const months = new Set(Object.keys(parsed.days).map(d => d.slice(0, 7)));
  if (parsed.rangeStart && parsed.rangeEnd) {
    for (let m = parsed.rangeStart.slice(0, 7); m <= parsed.rangeEnd.slice(0, 7);) {
      months.add(m);
      const [y, mo] = m.split('-').map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }
  }
  return { days: next, months };
}

export const lpMonthPayload = (days, month) => ({ days: Object.fromEntries(Object.entries(days).filter(([d]) => d.slice(0, 7) === month)) });

const VAGUE_REASON = /^(|\.+|\?+|idk|i dont know|na|n\/a|none|no|-+|x+|ok|even)$/i;

// Everything the tab and Tilly show for a date range. Person key is
// normalized name + store code, so the same person at two stores is two rows.
export function analyzeLp(lp, start, end, todayISO) {
  const inR = d => d >= start && d <= end;
  const people = new Map();
  const P = (name, code) => {
    const key = `${lpNorm(name)}|${code}`;
    if (!people.has(key)) people.set(key, { key, name, code, flags: [] });
    return people.get(key);
  };
  const staff = new Set();
  Object.values(lp.sales || {}).forEach(day => Object.values(day).forEach(s => {
    Object.keys(s.s).forEach(n => staff.add(lpNorm(n)));
    Object.keys(s.c).forEach(n => staff.add(lpNorm(n)));
  }));
  Object.values(lp.att || {}).forEach(day => Object.values(day).forEach(s => Object.keys(s).forEach(n => staff.add(lpNorm(n)))));

  const ev = { z: [], p: [], r: [], e: [] };
  const tickets = {}, closed = {}, storeCash = {};
  let coClosed = 0, coLoyal = 0;
  const salesDates = Object.keys(lp.sales || {}).filter(inR);
  salesDates.forEach(date => Object.entries(lp.sales[date]).forEach(([code, s]) => {
    s.ev.forEach(e => ev[e.t].push({ ...e, date, code }));
    Object.entries(s.s).forEach(([n, [t, c]]) => {
      const k = `${lpNorm(n)}|${code}`;
      const a = (tickets[k] = tickets[k] || { name: n, code, t: 0, c: 0 }); a.t += t; a.c += c;
      const sc = (storeCash[code] = storeCash[code] || { t: 0, c: 0 }); sc.t += t; sc.c += c;
    });
    Object.entries(s.c).forEach(([n, [t, l]]) => {
      const k = `${lpNorm(n)}|${code}`;
      const a = (closed[k] = closed[k] || { name: n, code, t: 0, l: 0 }); a.t += t; a.l += l;
      coClosed += t; coLoyal += l;
    });
  }));

  const byPerson = (list, nameOf = e => e.n) => {
    const m = new Map();
    list.forEach(e => {
      const n = nameOf(e) || '(no name)';
      const k = `${lpNorm(n)}|${e.code}`;
      if (!m.has(k)) m.set(k, { key: k, name: n, code: e.code, items: [] });
      m.get(k).items.push(e);
    });
    return [...m.values()].sort((a, b) => b.items.length - a.items.length);
  };

  // $0 services
  const zero = byPerson(ev.z).map(g => ({ ...g, noReason: g.items.filter(e => !e.dn).length }));
  zero.forEach(g => { if (g.items.length >= LP_RULES.zeroMin) P(g.name, g.code).flags.push(`${g.items.length} $0 services`); });
  // Price below list
  const below = byPerson(ev.p).map(g => ({ ...g, under: r2(g.items.reduce((s, e) => s + e.l - e.a, 0)) })).sort((a, b) => b.under - a.under);
  below.forEach(g => { if (g.under >= LP_RULES.priceBelowAmt) P(g.name, g.code).flags.push(`$${Math.round(g.under)} under list price`); });
  // Refunds
  const refunds = byPerson(ev.r);
  refunds.forEach(g => {
    const cash = g.items.filter(e => /cash/i.test(e.pay)).length;
    if (g.items.length >= LP_RULES.refundMin || cash) P(g.name, g.code).flags.push(`${g.items.length} refund${g.items.length === 1 ? '' : 's'}${cash ? ` (${cash} cash)` : ''}`);
  });
  // Employee discount on a guest who isn't a staff name
  const empNonStaff = ev.e.filter(e => e.g && lpNorm(e.g) !== lpNorm(e.n) && !staff.has(lpNorm(e.g)));
  const empDisc = byPerson(empNonStaff);
  empDisc.forEach(g => { if (g.items.length >= LP_RULES.empDiscNonStaffMin) P(g.name, g.code).flags.push(`employee discount on ${g.items.length} non-staff guests`); });
  // Loyalty redemption rate
  const coLoyalRate = coClosed ? coLoyal / coClosed : 0;
  const loyalty = Object.values(closed).filter(a => a.t >= LP_RULES.loyaltyMinClosed)
    .map(a => ({ ...a, rate: a.l / a.t, flagged: coLoyalRate > 0 && a.l / a.t >= LP_RULES.loyaltyRateX * coLoyalRate }))
    .sort((a, b) => b.rate - a.rate);
  loyalty.forEach(a => { if (a.flagged) P(a.name, a.code).flags.push(`loyalty redemptions on ${Math.round(a.rate * 100)}% of tickets`); });
  // Cash-only share vs own store
  const coCash = Object.values(storeCash).reduce((s, x) => [s[0] + x.c, s[1] + x.t], [0, 0]);
  const cash = Object.values(tickets).filter(a => a.t >= LP_RULES.cashMinTickets)
    .map(a => { const st = storeCash[a.code]; const storeRate = st.t ? st.c / st.t : 0; return { ...a, rate: a.c / a.t, storeRate, flagged: storeRate > 0 && a.c / a.t >= LP_RULES.cashShareX * storeRate }; })
    .sort((a, b) => (b.rate - b.storeRate) - (a.rate - a.storeRate));
  cash.forEach(a => { if (a.flagged) P(a.name, a.code).flags.push(`${Math.round(a.rate * 100)}% cash vs store ${Math.round(a.storeRate * 100)}%`); });

  // Register closures
  const reg = new Map();
  const bigAdj = [];
  let regCount = 0;
  Object.keys(lp.reg || {}).filter(inR).forEach(date => lp.reg[date].forEach(([code, adj, reason, by, paid]) => {
    regCount++;
    const k = `${lpNorm(by)}|${code}`;
    if (!reg.has(k)) reg.set(k, { key: k, name: by || '(no name)', code, closures: 0, short: 0, shortAmt: 0, vague: 0, paid: 0 });
    const a = reg.get(k);
    a.closures++; a.paid += paid;
    if (adj <= -LP_RULES.regShortAmt) { a.short++; a.shortAmt += adj; }
    if (adj && VAGUE_REASON.test(reason.trim())) a.vague++;
    if (Math.abs(adj) >= LP_RULES.regBigAdj) bigAdj.push({ date, code, adj, reason, by });
  }));
  const register = [...reg.values()].sort((a, b) => a.shortAmt - b.shortAmt);
  register.forEach(a => {
    if (a.short >= LP_RULES.regShortMin) P(a.name, a.code).flags.push(`${a.short} short register closures ($${Math.abs(Math.round(a.shortAmt))})`);
    if (a.vague >= LP_RULES.regVagueMin) P(a.name, a.code).flags.push(`${a.vague} register adjustments with no real reason`);
  });
  bigAdj.sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj));

  // Attendance: idle days (today is skipped — its tickets aren't all rung yet)
  const idle = new Map(), missed = new Map();
  Object.keys(lp.att || {}).filter(d => inR(d) && d !== todayISO).forEach(date => Object.entries(lp.att[date]).forEach(([code, emps]) => {
    Object.entries(emps).forEach(([n, [hrs, svcH, mIn, mOut, isStylist]]) => {
      const k = `${lpNorm(n)}|${code}`;
      if (mIn + mOut) {
        if (!missed.has(k)) missed.set(k, { key: k, name: n, code, count: 0 });
        missed.get(k).count += mIn + mOut;
      }
      if (!isStylist || hrs < LP_RULES.idleHours || svcH > 0) return;
      const t = lp.sales?.[date]?.[code]?.s;
      const hadTickets = t && Object.keys(t).some(x => lpNorm(x) === lpNorm(n));
      if (!lp.sales?.[date] || hadTickets) return; // no sales data that day = can't tell
      if (!idle.has(k)) idle.set(k, { key: k, name: n, code, days: [] });
      idle.get(k).days.push({ date, hrs });
    });
  }));
  const idleList = [...idle.values()].sort((a, b) => b.days.length - a.days.length);
  idleList.forEach(a => { if (a.days.length >= LP_RULES.idleDaysMin) P(a.name, a.code).flags.push(`${a.days.length} days clocked ${LP_RULES.idleHours}+ hrs with no tickets`); });
  const missedList = [...missed.values()].sort((a, b) => b.count - a.count);
  missedList.forEach(a => { if (a.count >= LP_RULES.missedPunchMin) P(a.name, a.code).flags.push(`${a.count} missed punches`); });

  const review = [...people.values()].filter(p => p.flags.length).sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name));
  return {
    review, zero, below, refunds, empDisc, loyalty, coLoyalRate, cash, coCashRate: coCash[1] ? coCash[0] / coCash[1] : 0,
    register, bigAdj, regCount, idle: idleList, missed: missedList,
    coverage: {
      salesDays: salesDates.length,
      attDays: Object.keys(lp.att || {}).filter(inR).length,
      regDays: Object.keys(lp.reg || {}).filter(inR).length,
    },
  };
}

// Latest month with any Loss Prevention sales/register data, as a range
// (month-to-date if it's the current month).
export function lpDefaultRange(lp, todayISO) {
  const dates = [...Object.keys(lp.sales || {}), ...Object.keys(lp.reg || {}), ...Object.keys(lp.att || {})].sort();
  if (!dates.length) return null;
  const last = dates[dates.length - 1];
  const month = last.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const monthEnd = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return { start: `${month}-01`, end: monthEnd < todayISO ? monthEnd : todayISO };
}
