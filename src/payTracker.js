// Pay-period earnings tracker (Homepage, next to "Welcome back").
//
// The user's pay rules (2026-11-03), not invented here:
//   TSTH        = (net service + retail, incl. color) ÷ hours worked, the
//                 same `tsth` the rest of the app uses (employee `sales`
//                 already includes retail).
//   TSTH Goal   = 2 × the haircut price. Haircut price is set by state:
//                 PA $28, NJ and DE $30.
//   Bonus / hr  = (TSTH − Goal) × 25% for stylists, 30% for management,
//                 only when TSTH is above the goal, paid on every hour.
//   No other commission.
//   Pay periods = the 1st–15th and the 16th–end of each month.
//   Made so far = hours × hourly rate + hours × bonus/hr + tips.
//
// Hourly rates come from the Employee Pay Rate Report (locked pay_rates
// table, owner only). Base pay is null for anyone whose name doesn't match a
// rate, and "made so far" says so.

import { getRangeTotals } from './metrics.js';
import { normalizeName } from './parser.js';
import { STORE_CODE_TO_NAME } from './storeDirectory.js';

// Store states, worked out 2026-11-03 from where each salon's staff live
// (Master Salon List 2026(6)); matches the user's own grouping. Every store
// not listed here is in PA. Bear's staff mostly live in MD, but the store is
// in DE (it sits near the state line).
const NJ_STORES = ['8919', '80147', '80354', '80358', '80661', '80719', '81729']; // Pennington, East Windsor, Mullica Hill, Plainsboro, Bordentown, South Brunswick, East Brunswick
const DE_STORES = ['82223', '82262', '82264', '82265', '82267', '81416']; // Bear, Naamans, Middletown, Pike Creek, Graylyn, Fairfax
export const HAIRCUT_PRICE_BY_STATE = { PA: 28, NJ: 30, DE: 30 };
export const BONUS_RATE = { stylist: 0.25, management: 0.30 };
// Hours needed before someone can be picked as "top TSTH": a stylist with a
// one-hour shift and one big ticket would otherwise win every time.
export const MIN_HOURS_FOR_TOP = 8;

export function storeState(code) {
  const c = String(code);
  if (NJ_STORES.includes(c)) return 'NJ';
  if (DE_STORES.includes(c)) return 'DE';
  return 'PA';
}
export const haircutPriceFor = code => HAIRCUT_PRICE_BY_STATE[storeState(code)];

const lastDayOfMonth = (y, m) => new Date(y, m, 0).getDate();
// The pay period that contains `todayISO`: { start, end } (end is the
// period's last day, not today).
export function payPeriodFor(todayISO) {
  const [y, m, d] = todayISO.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  return d <= 15
    ? { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` }
    : { start: `${y}-${mm}-16`, end: `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}` };
}

// Tips history record: { code, date, tips, employees: { [name]: { tips, job } } }
export function tipsByName(tipsHistory, start, end) {
  const out = {};
  Object.values(tipsHistory || {}).forEach(r => {
    if (r.date < start || r.date > end) return;
    Object.entries(r.employees || {}).forEach(([name, v]) => {
      const k = normalizeName(name);
      if (!out[k]) out[k] = { tips: 0, manager: false };
      out[k].tips += v.tips || 0;
      if (/manager/i.test(v.job || '')) out[k].manager = true;
    });
  });
  return out;
}

// Matches a name from sales (the POS spelling) to an hourly rate from the
// Employee Pay Rate Report. In order: a POS spelling leadership linked to
// that Emp ID (Setup › Employee Access "Also in sales as"), the full name,
// then first + last name ignoring middle names — only when exactly one
// person on the report fits, so two people sharing a short form never get
// each other's rate. Returns name → { rate, empNumber, rateName } | null.
const rateKey = s => String(s || '').replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export function buildRateLookup(rateRows = [], aliases = {}) {
  const byEmp = {};
  const exact = {};
  const short = {};
  rateRows.forEach(r => {
    const emp = String(r.emp_number ?? r.empNumber ?? '');
    const entry = { rate: r.rate == null ? null : Number(r.rate), empNumber: emp, rateName: r.name };
    byEmp[emp] = entry;
    const parts = rateKey(r.name).split(' ').filter(Boolean);
    if (!parts.length) return;
    (exact[parts.join(' ')] ||= []).push(entry);
    if (parts.length > 2) (short[`${parts[0]} ${parts[parts.length - 1]}`] ||= []).push(entry);
  });
  const aliasMap = {};
  Object.entries(aliases || {}).forEach(([emp, names]) => (names || []).forEach(n => { if (byEmp[emp]) aliasMap[rateKey(n)] = byEmp[emp]; }));
  return name => {
    const k = rateKey(name);
    if (aliasMap[k]) return aliasMap[k];
    if (exact[k]?.length === 1) return exact[k][0];
    const parts = k.split(' ').filter(Boolean);
    const sk = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]}` : k;
    const hits = [...(exact[sk] || []), ...(short[sk] || [])];
    const unique = [...new Set(hits)];
    return unique.length === 1 ? unique[0] : null;
  };
}

// One row per employee for [start, end], summed across every store they
// worked. The haircut price (and so the goal) comes from the store where
// they worked the most hours. `rateFor` (from buildRateLookup) gives base
// pay; without it, or with no match, base pay is null.
export function buildPayRows({ history, weeklyHistory, tipsHistory, start, end, rateFor = null }) {
  const totals = getRangeTotals(history, weeklyHistory, start, end);
  const tips = tipsByName(tipsHistory, start, end);
  const people = {};
  Object.entries(totals).forEach(([code, t]) => {
    (t.employees || []).forEach(e => {
      const k = normalizeName(e.name);
      if (!people[k]) people[k] = { name: e.name, sales: 0, hours: 0, hoursByStore: {} };
      const p = people[k];
      p.sales += e.sales || 0;
      p.hours += e.totalHours || 0;
      p.hoursByStore[code] = (p.hoursByStore[code] || 0) + (e.totalHours || 0);
    });
  });
  return Object.entries(people).filter(([, p]) => p.hours > 0).map(([k, p]) => {
    const homeCode = Object.entries(p.hoursByStore).sort((a, b) => b[1] - a[1])[0][0];
    const price = haircutPriceFor(homeCode);
    const goal = price * 2;
    const tsth = p.sales / p.hours;
    const manager = !!tips[k]?.manager;
    const rate = manager ? BONUS_RATE.management : BONUS_RATE.stylist;
    const bonusPerHour = tsth > goal ? (tsth - goal) * rate : 0;
    const bonus = bonusPerHour * p.hours;
    const tipTotal = tips[k]?.tips || 0;
    const match = rateFor ? rateFor(p.name) : null;
    const hourly = match?.rate ?? null;
    const basePay = hourly != null ? hourly * p.hours : null;
    return {
      name: p.name, code: homeCode, store: STORE_CODE_TO_NAME[homeCode] || `Store ${homeCode}`, state: storeState(homeCode),
      hours: p.hours, sales: p.sales, tsth, price, goal, manager, rate, bonusPerHour, bonus,
      tips: tipTotal, hourly, basePay, empNumber: match?.empNumber || null, rateMatched: !!match,
      madeSoFar: (basePay || 0) + bonus + tipTotal,
    };
  });
}

// The highest-TSTH employee with at least MIN_HOURS_FOR_TOP hours, or null.
export function topTsthRow(rows) {
  return rows.filter(r => r.hours >= MIN_HOURS_FOR_TOP).sort((a, b) => b.tsth - a.tsth)[0] || null;
}
