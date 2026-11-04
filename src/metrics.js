// Store/date-range aggregation logic shared between the client (App.js) and
// serverless endpoints that need the exact same numbers outside a browser
// (e.g. api/leaderboard-email.js) — pulled out specifically so a future fix
// to the weekly-vs-daily dedup rule (this app has had real bugs here before,
// see HANDOFF.md's "stale-report"/"Signature S" sections) can't silently
// drift between what the app shows and what an automated email says, the
// way two independent copies of this logic eventually would.

// Same "don't double-count" rule as the Weekly tab: a week only counts from
// an uploaded weekly report if its whole range sits inside the query range;
// any day already covered by SOME weekly report is skipped from the daily
// (Sales-Accrual/Attendance) bucket either way, so nothing is ever counted twice.
export const EMPTY_RANGE_TOTALS = { service: 0, retail: 0, color: 0, hours: 0, giftCards: 0, haircuts: 0, signatureS: 0, signatureSCount: 0, bottles: 0, otherServices: 0, colorTicketCount: 0, colorTicketsWithRetail: 0, signatureTicketCount: 0, signatureTicketsWithRetail: 0 };

// `products` is deliberately NOT part of the EMPTY_RANGE_TOTALS constant
// above — that object gets shallow-copied (`{ ...EMPTY_RANGE_TOTALS }`) once
// per store, and a nested object baked into a shared constant would hand
// every store the SAME `products` reference, so one store's product totals
// would silently bleed into every other store's. getRangeTotals below always
// attaches a fresh `products: {}` per store instead.
export function addRangeInto(target, src) {
  target.service += src.service || 0;
  target.retail += src.retail || 0;
  target.color += src.color || 0;
  target.hours += src.hours || 0;
  target.giftCards += src.giftCards || 0;
  target.haircuts += src.haircuts || 0;
  target.signatureS += src.signatureS || 0;
  target.signatureSCount += src.signatureSCount || 0;
  target.bottles += src.bottles || 0;
  target.otherServices += src.otherServices || 0;
  target.colorTicketCount += src.colorTicketCount || 0;
  target.colorTicketsWithRetail += src.colorTicketsWithRetail || 0;
  target.signatureTicketCount += src.signatureTicketCount || 0;
  target.signatureTicketsWithRetail += src.signatureTicketsWithRetail || 0;
  if (src.products) {
    Object.entries(src.products).forEach(([name, v]) => {
      if (!target.products[name]) target.products[name] = { qty: 0, amount: 0 };
      target.products[name].qty += v.qty || 0;
      target.products[name].amount += v.amount || 0;
    });
  }
  // Extra services by name (Sales-Accrual uploads from 2026-11-03 on), same
  // shape and same fresh-object-per-store rule as products.
  if (src.extras) {
    if (!target.extras) target.extras = {};
    Object.entries(src.extras).forEach(([name, v]) => {
      if (!target.extras[name]) target.extras[name] = { qty: 0, amount: 0 };
      target.extras[name].qty += v.qty || 0;
      target.extras[name].amount += v.amount || 0;
    });
  }
}

export function expandDateRangeDays(start, end) {
  const dates = [];
  const d = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  let guard = 0;
  while (d <= endD && guard < 1200) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return dates;
}

// Employee-level detail comes from weekly Stylist Report uploads AND from
// the Sales-Accrual/Attendance historical backfill (both attribute rows to
// a Stylist/Employee Name, so both can populate per-employee totals).
// Merges by name across every week in range, summing raw totals and
// recomputing tsth/cpc/rpc from those sums — never averaging ratios.
export function mergeEmployeesInto(targetMap, employees) {
  employees.forEach(e => {
    if (!targetMap[e.name]) targetMap[e.name] = { name: e.name, sales: 0, colorSales: 0, retail: 0, haircuts: 0, totalHours: 0, signatureS: 0, signatureSCount: 0, otherServices: 0 };
    const t = targetMap[e.name];
    t.sales += e.sales || 0;
    t.colorSales += e.colorSales || 0;
    t.retail += e.retail || 0;
    t.haircuts += e.haircuts || 0;
    t.totalHours += e.totalHours || 0;
    t.signatureS += e.signatureS || 0;
    t.signatureSCount += e.signatureSCount || 0;
    t.otherServices += e.otherServices || 0;
  });
}

export function finalizeEmployee(e) {
  return {
    ...e,
    tsth: e.totalHours > 0 ? e.sales / e.totalHours : null,
    cpc: e.haircuts > 0 ? e.colorSales / e.haircuts : null,
    rpc: e.haircuts > 0 ? e.retail / e.haircuts : null,
    opc: e.haircuts > 0 ? e.otherServices / e.haircuts : null,
    avgTicket: e.haircuts > 0 ? e.sales / e.haircuts : null,
    cph: e.totalHours > 0 ? e.haircuts / e.totalHours : null,
  };
}

export function getRangeTotals(history, weeklyHistory, startISO, endISO) {
  const weeklyEntries = Object.values(weeklyHistory || {});
  const covered = new Set();
  weeklyEntries.forEach(w => expandDateRangeDays(w.startDate, w.endDate).forEach(d => covered.add(d)));

  const byStore = {};
  const employeesByStore = {};
  const addTo = (code, src) => {
    if (!byStore[code]) byStore[code] = { ...EMPTY_RANGE_TOTALS, products: {}, extras: {} };
    addRangeInto(byStore[code], src);
  };
  weeklyEntries.forEach(w => {
    if (w.startDate >= startISO && w.endDate <= endISO) {
      Object.entries(w.stores).forEach(([code, v]) => {
        addTo(code, v);
        if (v.employees && v.employees.length) {
          if (!employeesByStore[code]) employeesByStore[code] = {};
          mergeEmployeesInto(employeesByStore[code], v.employees);
        }
      });
    }
  });
  Object.values(history || {}).forEach(r => {
    if (r.date < startISO || r.date > endISO) return;
    if (covered.has(r.date)) {
      // A weekly Stylist Report upload covers this day for every OTHER
      // field (it's the more authoritative source, hence `covered`
      // skipping the daily record entirely below) — but the Stylist Report
      // has no item-level detail, so it never carries Signature S, bottle
      // counts, or a product breakdown at all. Pulling those straight from
      // the daily Sales-Accrual record here can't double-count anything,
      // since the weekly source's contribution to them is always zero.
      if (r.signatureS || r.signatureSCount || r.bottles || r.colorTicketCount || r.signatureTicketCount) {
        addTo(r.code, { signatureS: r.signatureS, signatureSCount: r.signatureSCount, bottles: r.bottles, colorTicketCount: r.colorTicketCount, colorTicketsWithRetail: r.colorTicketsWithRetail, signatureTicketCount: r.signatureTicketCount, signatureTicketsWithRetail: r.signatureTicketsWithRetail });
      }
      if (r.products && Object.keys(r.products).length) {
        addTo(r.code, { products: r.products });
      }
      if (r.extras && Object.keys(r.extras).length) {
        addTo(r.code, { extras: r.extras });
      }
      if (r.employees && Object.keys(r.employees).length) {
        const sigOnly = Object.entries(r.employees)
          .filter(([, v]) => v.signatureS || v.signatureSCount)
          .map(([name, v]) => ({ name, signatureS: v.signatureS, signatureSCount: v.signatureSCount }));
        if (sigOnly.length) {
          if (!employeesByStore[r.code]) employeesByStore[r.code] = {};
          mergeEmployeesInto(employeesByStore[r.code], sigOnly);
        }
      }
      return;
    }
    addTo(r.code, r);
    if (r.employees && Object.keys(r.employees).length) {
      if (!employeesByStore[r.code]) employeesByStore[r.code] = {};
      const asArray = Object.entries(r.employees).map(([name, v]) => ({ name, ...v }));
      mergeEmployeesInto(employeesByStore[r.code], asArray);
    }
  });
  Object.keys(byStore).forEach(code => {
    byStore[code].employees = employeesByStore[code]
      ? Object.values(employeesByStore[code]).map(finalizeEmployee)
      : [];
  });
  return byStore;
}

// Adapts history's {service,retail,color,hours,giftCards,haircuts,employees}
// shape into the same shape a live Stylist Report uses, so the exact same
// tables/columns can render either one. haircuts/employees come through
// whenever the Sales-Accrual/Attendance backfill (or a weekly Stylist Report)
// covered that period; otherwise they come back null/empty rather than a
// made-up number.
export function historyTotalsToReportShape(t) {
  const hours = t?.hours || 0;
  const service = t?.service || 0;
  const retail = t?.retail || 0;
  const haircuts = t?.haircuts || 0;
  // "Sales" = total revenue (service + retail combined) — matches the same
  // combining rollup() (parser.js) does for live-report data, so historical
  // and live-report-sourced "Sales" always mean the same thing.
  const sales = service + retail;
  return {
    sales,
    totalHours: hours,
    colorSales: t?.color || 0,
    retail,
    giftCards: t?.giftCards || 0,
    signatureS: t?.signatureS || 0,
    signatureSCount: t?.signatureSCount || 0,
    bottles: t?.bottles || 0,
    otherServices: t?.otherServices || 0,
    haircuts: haircuts || null,
    tsth: hours > 0 ? sales / hours : null,
    cpc: haircuts > 0 ? (t.color || 0) / haircuts : null,
    rpc: haircuts > 0 ? retail / haircuts : null,
    opc: haircuts > 0 ? (t.otherServices || 0) / haircuts : null,
    avgTicket: haircuts > 0 ? sales / haircuts : null,
    cph: hours > 0 ? haircuts / hours : null,
    // Retail Attach % — color tickets that also carry a retail item, from
    // real per-invoice linkage (see parseSalesAccrualFile's Invoice No
    // handling in parser.js). Only ever real here when Sales-Accrual data
    // for this range came from an export new enough to carry Invoice No —
    // null (not 0) when colorTicketCount is 0, same "don't show a fake
    // number" rule haircuts/cpc/etc. already follow above.
    colorTicketCount: t?.colorTicketCount || 0,
    colorTicketsWithRetail: t?.colorTicketsWithRetail || 0,
    retailAttachPct: (t?.colorTicketCount || 0) > 0 ? (t.colorTicketsWithRetail || 0) / t.colorTicketCount : null,
    // Same idea, for Signature Service tickets (Conditioning Treatment
    // Services) instead of Color ones — a Signature Service ticket that
    // also carries a retail item on the same invoice.
    signatureTicketCount: t?.signatureTicketCount || 0,
    signatureTicketsWithRetail: t?.signatureTicketsWithRetail || 0,
    signatureAttachPct: (t?.signatureTicketCount || 0) > 0 ? (t.signatureTicketsWithRetail || 0) / t.signatureTicketCount : null,
    employees: t?.employees || [],
    products: t?.products || {},
  };
}

// Re-aggregate a set of already-rolled-up rows (stores, or store totals) one
// level higher (e.g. up to a District Leader). Sums the additive fields and
// recomputes the ratio fields from those sums — never averages ratios directly.
export function rollupRows(rows) {
  const sum = key => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const totalSales = sum('sales');
  const totalHours = sum('totalHours');
  const totalColor = sum('colorSales');
  const totalRetail = sum('retail');
  const totalHaircuts = sum('haircuts');
  const totalSignatureS = sum('signatureS');
  const totalSignatureSCount = sum('signatureSCount');
  const totalBottles = sum('bottles');
  const totalOther = sum('otherServices');
  const totalColorTickets = sum('colorTicketCount');
  const totalColorTicketsWithRetail = sum('colorTicketsWithRetail');
  const totalSignatureTickets = sum('signatureTicketCount');
  const totalSignatureTicketsWithRetail = sum('signatureTicketsWithRetail');
  return {
    sales: totalSales,
    totalHours,
    colorSales: totalColor,
    retail: totalRetail,
    haircuts: totalHaircuts,
    signatureS: totalSignatureS,
    signatureSCount: totalSignatureSCount,
    bottles: totalBottles,
    otherServices: totalOther,
    tsth: totalHours > 0 ? totalSales / totalHours : null,
    cpc: totalHaircuts > 0 ? totalColor / totalHaircuts : null,
    rpc: totalHaircuts > 0 ? totalRetail / totalHaircuts : null,
    opc: totalHaircuts > 0 ? totalOther / totalHaircuts : null,
    avgTicket: totalHaircuts > 0 ? totalSales / totalHaircuts : null,
    cph: totalHours > 0 ? totalHaircuts / totalHours : null,
    colorTicketCount: totalColorTickets,
    colorTicketsWithRetail: totalColorTicketsWithRetail,
    retailAttachPct: totalColorTickets > 0 ? totalColorTicketsWithRetail / totalColorTickets : null,
    signatureTicketCount: totalSignatureTickets,
    signatureTicketsWithRetail: totalSignatureTicketsWithRetail,
    signatureAttachPct: totalSignatureTickets > 0 ? totalSignatureTicketsWithRetail / totalSignatureTickets : null,
  };
}

// The same weekday a year back: exactly 52 weeks, so a Monday-to-Sunday week
// compares with a Monday-to-Sunday week (Mon Nov 2 2026 -> Mon Nov 3 2025).
export const sameWeekdayLastYear = iso => addDaysISO(iso, -364);

export function addDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isoWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// The most recently *completed* Monday–Sunday week — used by the Homepage
// Top 10 leaderboard's "Past 7 Days" toggle and the weekly leaderboard email
// (api/leaderboard-email.js), independent of the month-to-date default every
// other tab falls back to.
export function getLastFullWeekRange() {
  const thisWeekStart = isoWeekStart(new Date().toISOString().slice(0, 10));
  const end = addDaysISO(thisWeekStart, -1);
  const start = addDaysISO(end, -6);
  return { start, end };
}

export function sortByMetric(rows, key, order = 'desc') {
  const arr = [...rows];
  if (key === 'name' || key === 'store') {
    arr.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (order === 'desc' ? -1 : 1));
  } else {
    arr.sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * (order === 'desc' ? -1 : 1));
  }
  return arr;
}

// "2026-09-01" -> "2025-09-01". Feb 29 falls back to Feb 28 in a non-leap
// year, so a last-year range is always a real date range.
export function shiftYearISO(iso, years) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const ny = y + years;
  const lastDay = new Date(ny, m, 0).getDate();
  return `${ny}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

// Cuts Per Day inputs per store for a date range: total haircuts (same
// getRangeTotals figure the Cuts tile uses) and the number of days that
// store actually did cuts. Counting only days with cuts > 0 means holiday/
// snow-day closures (company-wide zero days, see HANDOFF.md) don't drag the
// average down. A weekly Stylist Report week only contributes its days for a
// store that has no daily Sales-Accrual rows in that week (weekly data has
// no per-day detail, so all its days count).
export function getStoreCutsPerDay(history, weeklyHistory, start, end) {
  const totals = getRangeTotals(history, weeklyHistory, start, end);
  const days = {};
  const addDay = (code, d) => { if (!days[code]) days[code] = new Set(); days[code].add(d); };
  Object.values(history || {}).forEach(r => {
    if (r.date >= start && r.date <= end && (r.haircuts || 0) > 0) addDay(r.code, r.date);
  });
  Object.values(weeklyHistory || {}).forEach(w => {
    if (w.startDate < start || w.endDate > end) return;
    const weekDays = expandDateRangeDays(w.startDate, w.endDate);
    Object.entries(w.stores || {}).forEach(([code, v]) => {
      if ((v.haircuts || 0) <= 0) return;
      if (weekDays.some(d => days[code]?.has(d))) return;
      weekDays.forEach(d => addDay(code, d));
    });
  });
  const out = {};
  Object.entries(totals).forEach(([code, t]) => { out[code] = { cuts: t.haircuts || 0, days: days[code]?.size || 0 }; });
  return out;
}
export const cpdOf = entry => (entry && entry.days > 0 ? entry.cuts / entry.days : null);

// ─── Monthly goals (Goals tab + api/_finalize-goals.js) ──────────────────────
// Shared so the site and the DL goals email show identical numbers.

// "2026-11", +1 → "2026-12"; -12 → "2025-11".
export function shiftMonthKey(mk, n) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Whole month, or through `todayISO` if the month isn't over yet.
export function monthKeyRange(mk, todayISO) {
  const [y, m] = mk.split('-').map(Number);
  const last = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return { start: `${mk}-01`, end: todayISO && last > todayISO ? todayISO : last };
}

// { [storeCode]: { cuts, cpd, sales, daily, weekly } } for one month.
// Daily avg = sales ÷ days the store had cuts (same days CPD uses); weekly
// avg = sales ÷ (open days in the range ÷ 7), the same 7-open-day week the
// weekly Sales goal uses (salesGoalBreakdown), so a holiday doesn't water
// down the average.
export function monthlyReference(history, weeklyHistory, mk, todayISO) {
  const { start, end } = monthKeyRange(mk, todayISO);
  if (start > end) return {};
  const openDays = openDaysInRange(start, end);
  const weeks = openDays / 7;
  const totals = getRangeTotals(history, weeklyHistory, start, end);
  const cpd = getStoreCutsPerDay(history, weeklyHistory, start, end);
  const out = {};
  Object.entries(totals).forEach(([code, t]) => {
    const sales = historyTotalsToReportShape(t).sales || 0;
    const days = cpd[code]?.days || 0;
    out[code] = { cuts: t.haircuts || 0, cpd: cpdOf(cpd[code]), sales, daily: days > 0 ? sales / days : null, weekly: weeks > 0 ? sales / weeks : null };
  });
  return out;
}

// ─── Company-wide closed days ───────────────────────────────────────────────
// Every store is closed on these four holidays (confirmed against sales
// history: zero sales company-wide on each one in 2025 and 2026). Snow days
// and other one-off closures can't be known ahead, so they aren't here.
// To add a holiday, add it to closedHolidays().

// Easter Sunday (Anonymous Gregorian algorithm). 2026 → "2026-04-05".
function easterSundayISO(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// Thanksgiving: 4th Thursday of November.
function thanksgivingISO(y) {
  const firstDow = new Date(y, 10, 1).getDay(); // 0 = Sun … 4 = Thu
  const firstThu = 1 + ((4 - firstDow + 7) % 7);
  return `${y}-11-${String(firstThu + 21).padStart(2, '0')}`;
}
export function closedHolidays(y) {
  return [
    { date: `${y}-01-01`, name: "New Year's Day" },
    { date: easterSundayISO(y), name: 'Easter' },
    { date: thanksgivingISO(y), name: 'Thanksgiving' },
    { date: `${y}-12-25`, name: 'Christmas' },
  ];
}
// The holidays that fall inside one month ("2026-11" → [{ date, name }]).
export function closedDaysInMonth(mk) {
  return closedHolidays(Number(mk.slice(0, 4))).filter(h => h.date.startsWith(`${mk}-`));
}
// Days in [start, end] the stores are open (calendar days minus holidays).
export function openDaysInRange(start, end) {
  if (!start || !end || start > end) return 0;
  const calendar = Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000) + 1;
  let closed = 0;
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    closedHolidays(y).forEach(h => { if (h.date >= start && h.date <= end) closed++; });
  }
  return calendar - closed;
}

// A monthly Sales goal per day and per week. Daily = goal ÷ days the stores
// are open that month (November 2026: 30 days − Thanksgiving = 29). Weekly =
// daily × 7 (the user's rule, 2026-11-03; it was goal ÷ 4 for a few hours
// the same day). So 4 weeks don't add up to the monthly goal in a month
// with more than 28 open days; that's expected. The daily is rounded to
// whole dollars first (that's how it's shown), and weekly is that shown
// daily × 7, so anyone multiplying the two numbers gets an exact match.
export function salesGoalBreakdown(goal, mk) {
  if (goal == null || goal === '' || isNaN(Number(goal))) return null;
  const [y, m] = mk.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const openDays = openDaysInRange(`${mk}-01`, `${mk}-${String(days).padStart(2, '0')}`);
  const daily = Math.round(Number(goal) / openDays);
  return { daily, weekly: daily * 7, openDays, days };
}
