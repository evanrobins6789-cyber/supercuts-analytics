// Presenter mode — an owner-only, this-browser-only switch that swaps every
// number and person's name on screen for made-up ones, so the app can be
// demoed without showing real data. Nothing here ever touches stored data:
//   - The fake data is derived on the fly from the real in-memory data
//     (App.js passes `presenterView(...)` to the tabs instead of the real
//     state) — the real state itself is never modified.
//   - While presenter mode is on, every write path (db.js saveData/clear*,
//     auth.js's write wrappers) refuses before hitting Supabase OR the
//     localStorage mirror — see isWriteBlocked(). Anything typed/imported
//     while presenting only ever lives in this page's memory, and turning
//     presenter mode off reloads the page so that's discarded too.
//   - The flag lives only in this browser (localStorage, keyed per user id),
//     so nobody else's session is affected, and a non-owner never gets it.
// Fakes are deterministic (hash-seeded), so the same store/person always
// gets the same fake numbers/name — consistent across tabs and reloads.

import { finalizeEmployee, rollupRows } from './metrics';

// ─── Flag ────────────────────────────────────────────────────────────────
let presenting = false;
const flagKey = userId => `supercuts_presenter_mode_${userId}`;

export function isPresenting() { return presenting; }
export function isWriteBlocked() { return presenting; }
export const PRESENTER_BLOCKED_ERROR = 'Presenter mode is on — nothing is saved while presenting.';

// Reads the stored flag for this user and arms the module-level switch.
// Only ever honored for an owner session.
export function initPresenterMode(user) {
  let on = false;
  if (user && user.role === 'owner') {
    try { on = localStorage.getItem(flagKey(user.id || user.name)) === '1'; } catch { on = false; }
  }
  presenting = on;
  return on;
}

export function setPresenterMode(user, on) {
  const allowed = !!(user && user.role === 'owner' && on);
  presenting = allowed;
  if (user) {
    try {
      if (allowed) localStorage.setItem(flagKey(user.id || user.name), '1');
      else localStorage.removeItem(flagKey(user.id || user.name));
    } catch { /* storage unavailable — mode still applies for this page load */ }
  }
  return allowed;
}

// ─── Deterministic randomness ─────────────────────────────────────────────
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296; // [0, 1)
}
const between = (seed, lo, hi) => lo + hash(seed) * (hi - lo);

// ─── Fake names ─────────────────────────────────────────────────────────────
const FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Quinn', 'Harper', 'Rowan', 'Skyler', 'Reese', 'Emerson', 'Dakota', 'Hayden', 'Parker', 'Sawyer', 'Finley', 'Blake', 'Cameron', 'Drew', 'Elliot', 'Jamie', 'Kendall', 'Logan', 'Marley', 'Noel', 'Peyton', 'Remy', 'Sage', 'Tatum', 'Arden', 'Bailey', 'Carmen', 'Delaney', 'Eden', 'Frankie', 'Greer', 'Hollis', 'Indie', 'Jesse', 'Kai', 'Lane', 'Monroe', 'Nico', 'Oakley', 'Presley', 'Rory', 'Shay', 'Toby', 'Val', 'Wren', 'Aspen', 'Brooke', 'Callie', 'Dana', 'Ellis', 'Gemma', 'Hadley', 'Ivy', 'Juno'];
const LAST = ['Adler', 'Barnes', 'Carver', 'Dalton', 'Ellison', 'Fischer', 'Garland', 'Hale', 'Ingram', 'Jensen', 'Keller', 'Lowell', 'Mercer', 'Nolan', 'Oakes', 'Pryor', 'Quincy', 'Radley', 'Sutter', 'Tanner', 'Upton', 'Vance', 'Whitaker', 'Yates', 'Zeller', 'Abbott', 'Brennan', 'Calloway', 'Dorsey', 'Everett', 'Fairbanks', 'Gentry', 'Holloway', 'Irving', 'Jarrett', 'Kingsley', 'Langford', 'Maddox', 'Norwood', 'Prescott'];
const COMPANIES = ['Brookfield Realty Partners', 'Crestline Properties LLC', 'Harbor Point Holdings', 'Maple Ridge Associates', 'Northgate Commercial', 'Riverside Retail Group', 'Summit Plaza Management', 'Willow Creek Realty'];

const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const nameMap = new Map(); // normalized real name -> fake full name
const usedFakes = new Set();

// Same real person -> same fake name everywhere (history rows, rosters,
// reviews, HSA sign-ups, DL lists), so cross-tab lookups still line up.
export function fakePersonName(real) {
  if (real == null || real === '') return real;
  const key = normName(real);
  if (nameMap.has(key)) return nameMap.get(key);
  const total = FIRST.length * LAST.length;
  let idx = Math.floor(hash(`name|${key}`) * total);
  let fake;
  for (let tries = 0; tries < total; tries++) {
    fake = `${FIRST[idx % FIRST.length]} ${LAST[Math.floor(idx / FIRST.length) % LAST.length]}`;
    if (!usedFakes.has(fake)) break;
    idx = (idx + 1) % total;
  }
  usedFakes.add(fake);
  nameMap.set(key, fake);
  return fake;
}
const fakeFirstName = real => fakePersonName(real).split(' ')[0];
const fakePhone = real => {
  if (!real) return real;
  const n = Math.floor(hash(`phone|${real}`) * 10000).toString().padStart(4, '0');
  return `(555) 01${n.slice(0, 1)}-${n}`;
};

// ─── Number scaling ─────────────────────────────────────────────────────────
// Every store gets one "size" factor plus a smaller per-metric-group jitter
// (and a per-year jitter, so year-over-year comparisons don't just mirror
// the real growth). Every row for a store uses the same factors, so sums,
// store totals, and derived ratios (TSTH, CPC, CPD...) all stay internally
// consistent — they're just not the real figures.
const FIELD_GROUP = {
  sales: 'service', service: 'service', serviceSales: 'service',
  retail: 'retail', giftCards: 'retail',
  color: 'color', colorSales: 'color',
  otherServices: 'other',
  signatureS: 'sigAmt', signatureSCount: 'sigCount',
  haircuts: 'cuts', bottles: 'bottles',
  hours: 'hours', totalHours: 'hours',
  colorTicketCount: 'colorTix', colorTicketsWithRetail: 'colorTix',
  signatureTicketCount: 'sigTix', signatureTicketsWithRetail: 'sigTix',
};
const COUNT_FIELDS = new Set(['haircuts', 'bottles', 'signatureSCount', 'colorTicketCount', 'colorTicketsWithRetail', 'signatureTicketCount', 'signatureTicketsWithRetail']);

function factor(code, group, year) {
  const c = String(code ?? 'all');
  return between(`size|${c}`, 0.65, 1.45) * between(`jit|${c}|${group}`, 0.82, 1.18) * (year ? between(`yr|${c}|${group}|${year}`, 0.92, 1.08) : 1);
}
function scaleVal(v, field, code, year) {
  if (typeof v !== 'number' || !isFinite(v)) return v;
  const group = FIELD_GROUP[field];
  if (!group) return v;
  const out = v * factor(code, group, year);
  return COUNT_FIELDS.has(field) ? Math.round(out) : Math.round(out * 100) / 100;
}
function scaleFields(obj, code, year) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  Object.keys(FIELD_GROUP).forEach(f => { if (f in out) out[f] = scaleVal(out[f], f, code, year); });
  if (out.products && typeof out.products === 'object') {
    const p = {};
    Object.entries(out.products).forEach(([name, v]) => {
      p[name] = { ...v, qty: Math.round((v.qty || 0) * factor(code, 'bottles', year)), amount: Math.round((v.amount || 0) * factor(code, 'retail', year) * 100) / 100 };
    });
    out.products = p;
  }
  return out;
}
const yearOf = iso => (iso ? String(iso).slice(0, 4) : null);

// ─── Dataset fakers ─────────────────────────────────────────────────────────
function fakeHistory(history) {
  const out = {};
  Object.entries(history || {}).forEach(([k, r]) => {
    const year = yearOf(r.date);
    const rec = scaleFields(r, r.code, year);
    if (r.employees && typeof r.employees === 'object') {
      const emps = {};
      Object.entries(r.employees).forEach(([name, v]) => { emps[fakePersonName(name)] = scaleFields(v, r.code, year); });
      rec.employees = emps;
    }
    out[k] = rec;
  });
  return out;
}

function fakeWeeklyHistory(weekly) {
  const out = {};
  Object.entries(weekly || {}).forEach(([k, w]) => {
    const year = yearOf(w.startDate);
    const stores = {};
    Object.entries(w.stores || {}).forEach(([code, s]) => {
      const rec = scaleFields(s, code, year);
      if (Array.isArray(s.employees)) rec.employees = s.employees.map(e => ({ ...scaleFields(e, code, year), name: fakePersonName(e.name) }));
      stores[code] = rec;
    });
    out[k] = { ...w, stores };
  });
  return out;
}

function fakeReport(report) {
  if (!report) return report;
  const year = yearOf(report.endDateISO);
  const stores = (report.stores || []).map(s => {
    const employees = (s.employees || []).map(e => finalizeEmployee({ ...scaleFields(e, s.code, year), name: fakePersonName(e.name) }));
    return { ...s, employees, totals: { ...s.totals, ...rollupRows(employees) } };
  });
  const allEmployees = [];
  stores.forEach(s => s.employees.forEach(e => allEmployees.push({ ...e, store: s.name })));
  return { ...report, stores, allEmployees, companyTotals: { ...report.companyTotals, ...rollupRows(stores.map(s => s.totals)) } };
}

// Goals: dollar/count targets scale with the store's size (so "vs Goal"
// still looks plausible); percentage-style fields just get a small jitter.
function fakeGoalsLike(goals) {
  const out = {};
  Object.entries(goals || {}).forEach(([code, g]) => {
    if (!g || typeof g !== 'object') { out[code] = g; return; }
    const ng = {};
    Object.entries(g).forEach(([field, v]) => {
      if (typeof v !== 'number' || !isFinite(v)) { ng[field] = v; return; }
      const isPct = /pct|percent|attach|toColor|toSS/i.test(field);
      const f = isPct ? between(`gp|${code}|${field}`, 0.85, 1.15) : factor(code, 'service') * between(`gj|${code}|${field}`, 0.9, 1.1);
      ng[field] = isPct ? Math.round(v * f * 1000) / 1000 : Math.round(v * f);
    });
    out[code] = ng;
  });
  return out;
}

function fakeManagers(managers) {
  const out = {};
  Object.entries(managers || {}).forEach(([code, v]) => {
    out[code] = typeof v === 'string' ? fakePersonName(v) : (v && typeof v === 'object' && v.name ? { ...v, name: fakePersonName(v.name) } : v);
  });
  return out;
}

function fakeRoster(roster) {
  if (!roster || !Array.isArray(roster.employees)) return roster;
  return { ...roster, employees: roster.employees.map(e => ({ ...e, name: fakePersonName(e.name) })) };
}

const POSITIVE_REVIEWS = [
  'Quick, friendly, and my cut came out exactly how I asked.',
  'Great experience as always — clean salon and a really welcoming team.',
  'Walked in without an appointment and was out in 25 minutes looking sharp.',
  'Best haircut I have had in a long time. Will definitely be back.',
  'Super easy check-in online and the stylist really listened.',
  'Friendly staff, fair price, and a great fade. Highly recommend.',
  'Brought both my kids in and everyone was patient and fun with them.',
  'Consistently good cuts every visit. Love this location.',
];
const POSITIVE_WITH_NAME = [
  '{name} did an amazing job — exactly the cut I wanted!',
  'Ask for {name}! Always takes the time to get it right.',
  '{name} was so friendly and my color turned out beautiful.',
  'Shoutout to {name} for fitting me in last minute. Great cut.',
];
const NEGATIVE_REVIEWS = [
  'Waited longer than the app said I would.',
  'Cut was fine but felt a little rushed.',
  'Not quite what I asked for, had to come back for a fix.',
  'Salon was busier than expected and check-in was confusing.',
];
const NEGATIVE_WITH_NAME = [
  '{name} was nice but the cut felt rushed.',
  'Had to ask {name} to redo the sides — fixed it, but took a while.',
];
const pick = (list, seed) => list[Math.floor(hash(seed) * list.length)];

// realEmployeesByStore lets a review that mentioned a real stylist mention
// that stylist's fake name instead, so shoutouts/mention-matching still work.
function fakeReviewsData(reviews, realEmployeesByStore) {
  if (!reviews || !Array.isArray(reviews.reviews)) return { reviews, keyMap: {} };
  const keyMap = {};
  const list = reviews.reviews.map((r, i) => {
    const seed = `rev|${r.code}|${r.postedAt}|${r.userName}|${i}`;
    const text = String(r.message || '').toLowerCase();
    let mentioned = null;
    for (const emp of (realEmployeesByStore?.[r.code] || [])) {
      const first = String(emp.name || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');
      if (first.length >= 3 && new RegExp(`\\b${first.toLowerCase()}\\b`).test(text)) { mentioned = emp.name; break; }
    }
    const positive = (r.rating || 0) >= 4;
    let message = '';
    if (r.message) {
      message = mentioned
        ? pick(positive ? POSITIVE_WITH_NAME : NEGATIVE_WITH_NAME, seed).replace('{name}', fakeFirstName(mentioned))
        : pick(positive ? POSITIVE_REVIEWS : NEGATIVE_REVIEWS, seed);
    }
    const fake = { ...r, userName: r.userName ? fakePersonName(r.userName) : r.userName, message, reply: r.reply ? 'Thank you so much for the feedback — we appreciate you!' : r.reply, url: '' };
    keyMap[`${r.code}|${r.postedAt}|${r.userName}|${r.rating}`] = `${fake.code}|${fake.postedAt}|${fake.userName}|${fake.rating}`;
    return fake;
  });
  return { reviews: { ...reviews, reviews: list }, keyMap };
}

function remapKeys(obj, keyMap, mapValue = v => v) {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => { out[keyMap[k] || k] = mapValue(v); });
  return out;
}

function fakeLeases(leases) {
  const out = {};
  Object.entries(leases || {}).forEach(([code, rec]) => {
    if (!rec || typeof rec !== 'object') { out[code] = rec; return; }
    const rent = Number(rec.baseRent);
    out[code] = {
      ...rec,
      landlordName: rec.landlordName ? pick(COMPANIES, `ll|${code}`) : rec.landlordName,
      landlordContact: rec.landlordContact ? `${fakePersonName(`contact ${code}`)} · (555) 010-${String(Math.floor(hash(`llp|${code}`) * 10000)).padStart(4, '0')}` : rec.landlordContact,
      baseRent: rec.baseRent !== '' && rec.baseRent != null && isFinite(rent) ? Math.round(rent * between(`rent|${code}`, 0.7, 1.3)) : rec.baseRent,
      rentEscalation: rec.rentEscalation ? `${Math.round(between(`esc|${code}`, 2, 4))}% annually` : rec.rentEscalation,
      notes: rec.notes ? 'Sample lease notes.' : rec.notes,
      renewalOptions: (rec.renewalOptions || []).map(ro => ({ ...ro, notes: ro.notes ? 'Sample note.' : ro.notes })),
      criticalDates: (rec.criticalDates || []).map(cd => ({ ...cd, notes: cd.notes ? 'Sample note.' : cd.notes })),
      files: (rec.files || []).map((f, i) => ({ ...f, name: `Sample Lease Document ${i + 1}.pdf` })),
    };
  });
  return out;
}

function fakeHsaSignups(list) {
  return (list || []).map(s => ({ ...s, name: fakePersonName(s.name), phone: fakePhone(s.phone), dl: s.dl ? fakePersonName(s.dl) : s.dl, enteredBy: s.enteredBy ? fakePersonName(s.enteredBy) : s.enteredBy }));
}

function fakePoints(summary) {
  if (!summary) return summary;
  const out = { ...summary, selfBalance: Math.round((summary.selfBalance || 0) * between('pts|self', 0.6, 1.4)) };
  if (summary.companyWide) {
    out.companyWide = {
      ...summary.companyWide,
      totalOutstanding: Math.round((summary.companyWide.totalOutstanding || 0) * between('pts|total', 0.6, 1.4)),
      topBalances: (summary.companyWide.topBalances || []).map(b => ({ ...b, employeeName: fakePersonName(b.employeeName), balance: Math.round(b.balance * between(`pts|${b.employeeName}`, 0.6, 1.4)) })),
    };
  }
  return out;
}

// One call from App.js — returns the fake counterpart of every dataset the
// tabs render. `realEmployeesByStore` is the REAL fallback roster (used only
// to spot which review mentioned which real stylist).
export function presenterView(real, realEmployeesByStore) {
  const { reviews, keyMap } = fakeReviewsData(real.reviews, realEmployeesByStore);
  return {
    report: fakeReport(real.report),
    history: fakeHistory(real.history),
    weeklyHistory: fakeWeeklyHistory(real.weeklyHistory),
    goals: fakeGoalsLike(real.goals),
    milestoneGoals: fakeGoalsLike(real.milestoneGoals),
    managers: fakeManagers(real.managers),
    employeeRoster: fakeRoster(real.employeeRoster),
    reviews,
    reviewNotes: remapKeys(real.reviewNotes, keyMap, notes => (Array.isArray(notes) ? notes.map(n => ({ ...n, text: 'Sample follow-up note.', author: n.author ? fakePersonName(n.author) : n.author })) : notes)),
    goldCombs: remapKeys(real.goldCombs, keyMap),
    leases: fakeLeases(real.leases),
    hsaSignups: fakeHsaSignups(real.hsaSignups),
    newsReads: (real.newsReads || []).map(r => ({ ...r, userName: fakePersonName(r.userName) })),
    pointsSummary: fakePoints(real.pointsSummary),
  };
}

// District Leader / Area Supervisor names come from the hardcoded roster
// file, not loaded data — faked here with the same name map.
export function fakeLeaderSections(sections) {
  return sections.map(sec => ({ ...sec, leaders: sec.leaders.map(l => ({ ...l, name: fakePersonName(l.name) })) }));
}

// Server responses read directly by Setup > Employee Access, Setup >
// Rewards, and Tillie's Nest (they fetch for themselves rather than taking
// props) — faked on the way back from auth.js's read wrappers.
export function fakeServerResponse(kind, res) {
  if (!res || !res.ok) return res;
  const txn = t => ({ ...t, employeeName: fakePersonName(t.employeeName), awardedBy: t.awardedBy ? fakePersonName(t.awardedBy) : t.awardedBy });
  switch (kind) {
    case 'rosterList':
      return { ...res, employees: (res.employees || []).map(e => ({ ...e, name: fakePersonName(e.name), phone: fakePhone(e.phone), employeeCode: e.employeeCode ? String(Math.floor(hash(`ec|${e.employeeCode}`) * 900000) + 100000) : e.employeeCode })) };
    case 'loginCounts':
      return { ...res, counts: (res.counts || []).map(c => ({ ...c, employeeName: fakePersonName(c.employeeName) })) };
    case 'pointsBalance':
      return { ...res, balance: Math.round((res.balance || 0) * between('pts|self', 0.6, 1.4)), transactions: res.transactions ? res.transactions.map(txn) : res.transactions };
    case 'pointsAllBalances':
      return { ...res, balances: (res.balances || []).map(b => ({ ...b, employeeName: fakePersonName(b.employeeName), balance: Math.round(b.balance * between(`pts|${b.employeeName}`, 0.6, 1.4)) })) };
    case 'pointsTransactions':
      return { ...res, transactions: (res.transactions || []).map(txn) };
    default:
      return res;
  }
}
