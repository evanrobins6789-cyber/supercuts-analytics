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
export const EMPTY_RANGE_TOTALS = { service: 0, retail: 0, color: 0, hours: 0, giftCards: 0, haircuts: 0, signatureS: 0, signatureSCount: 0, bottles: 0, otherServices: 0 };

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
  if (src.products) {
    Object.entries(src.products).forEach(([name, v]) => {
      if (!target.products[name]) target.products[name] = { qty: 0, amount: 0 };
      target.products[name].qty += v.qty || 0;
      target.products[name].amount += v.amount || 0;
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
    if (!byStore[code]) byStore[code] = { ...EMPTY_RANGE_TOTALS, products: {} };
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
      if (r.signatureS || r.signatureSCount || r.bottles) {
        addTo(r.code, { signatureS: r.signatureS, signatureSCount: r.signatureSCount, bottles: r.bottles });
      }
      if (r.products && Object.keys(r.products).length) {
        addTo(r.code, { products: r.products });
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
  };
}

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
