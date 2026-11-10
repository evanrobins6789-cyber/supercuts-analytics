// Presenter mode — an owner-only, this-browser-only switch that swaps every
// number and person's name on screen for made-up ones, so every tab can be
// demoed without showing real data. Anything a tab shows has to come through
// presenterView below: a new dataset or field isn't safe until it's faked here.
// Real by choice: store names, dates, headcounts, review text structure, and
// company rules like the bonus formula. News keeps its text but loses its PDFs.
// Nothing here ever touches stored data:
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
import { buildRateLookup } from './payTracker';
import { scoreSalonCheck, visitChecklist } from './salonCheck';

// ─── Flag ────────────────────────────────────────────────────────────────
let presenting = false;
const flagKey = userId => `supercuts_presenter_mode_${userId}`;

export function isPresenting() { return presenting; }
// "View as DL" (owner only, this browser only): the app shows the owner what
// one District Leader's login sees, using the same filter the server applies
// (src/scopeFilter.js). Read-only, same as presenter mode, so nothing done
// while looking around as a DL can be saved under the owner's login.
let viewAsDl = null; // { name, employeeCode, storeCodes }
const viewAsKey = userId => `supercuts_view_as_dl_${userId}`;
export function getViewAsDl() { return viewAsDl; }
export function initViewAsDl(user) {
  let v = null;
  if (user && user.role === 'owner') {
    try {
      const raw = JSON.parse(localStorage.getItem(viewAsKey(user.id || user.name)) || 'null');
      if (raw && raw.name && Array.isArray(raw.storeCodes)) v = { name: raw.name, employeeCode: raw.employeeCode || null, storeCodes: raw.storeCodes.map(String) };
    } catch { v = null; }
  }
  viewAsDl = v;
  return v;
}
export function setViewAsDl(user, dl) {
  const v = user && user.role === 'owner' && dl ? { name: dl.name, employeeCode: dl.employeeCode || null, storeCodes: (dl.storeCodes || []).map(String) } : null;
  viewAsDl = v;
  if (user) {
    try {
      if (v) localStorage.setItem(viewAsKey(user.id || user.name), JSON.stringify(v));
      else localStorage.removeItem(viewAsKey(user.id || user.name));
    } catch { /* storage unavailable — applies for this page load only */ }
  }
  return v;
}
export function isWriteBlocked() { return presenting || !!viewAsDl; }
export const PRESENTER_BLOCKED_ERROR = 'Presenter mode or DL view is on — nothing is saved.';

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
// A multiplier close to 1 would leave a number almost real, so keep at least
// 8% away from it.
const notOne = f => (Math.abs(f - 1) >= 0.08 ? f : (f < 1 ? 0.92 : 1.08));
// Plain rounding gives small counts straight back (1 × 1.1 rounds to 1), so
// totals built from many small days would stay real. This rounds up or down
// by the fraction instead, so the totals carry the multiplier. Same seed and
// a smaller number never rounds higher, so "x of y" counts stay in order.
function fairRound(x, seed) {
  const low = Math.floor(x);
  return low + (hash(seed) < x - low ? 1 : 0);
}
const cents = n => Math.round(n * 100) / 100;

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
//
// Ratios are the trap: two fields with the same multiplier give the real
// ratio. So groups step away from each other on purpose (cuts from hours,
// service from cuts, and so on), and the "with retail" ticket counts get their
// own group, so TSTH, CPH, CPC, RPC and attach % can't land on the real value.
// Store-level shifts average out across 59 stores, so company-wide ratios
// would still come out nearly real: COMPANY_TILT moves every store the same
// way. Each store's step then pushes the same direction as the tilt, because
// a step against it would cancel out and leave that store's ratio real.
const FIELD_GROUP = {
  sales: 'service', service: 'service', serviceSales: 'service',
  retail: 'retail', giftCards: 'retail', giftCardCount: 'giftCount',
  color: 'color', colorSales: 'color',
  otherServices: 'other', otherNet: 'other',
  tips: 'tips', tipCount: 'tipCount',
  daysWorked: 'days', prodHours: 'hours', nonProdHours: 'hours',
  signatureS: 'sigAmt', signatureSCount: 'sigCount',
  haircuts: 'cuts', bottles: 'bottles',
  hours: 'hours', totalHours: 'hours',
  colorTicketCount: 'colorTix', colorTicketsWithRetail: 'colorAttach',
  signatureTicketCount: 'sigTix', signatureTicketsWithRetail: 'sigAttach',
};
const ATTACH_PAIRS = [['colorTicketsWithRetail', 'colorTicketCount'], ['signatureTicketsWithRetail', 'signatureTicketCount']];
const COUNT_FIELDS = new Set(['tipCount', 'daysWorked', 'giftCardCount', 'haircuts', 'bottles', 'signatureSCount', 'colorTicketCount', 'colorTicketsWithRetail', 'signatureTicketCount', 'signatureTicketsWithRetail']);

const COMPANY_TILT = {
  hours: 1.1, cuts: 0.8, service: 0.84, retail: 0.7, color: 0.9, other: 1, bottles: 0.7,
  sigAmt: 1.05, sigCount: 0.72, colorAttach: 1.12, sigAttach: 0.86, giftCount: 0.85, tips: 1.1,
};
const tiltOf = group => COMPANY_TILT[group] || 1;
const sideOf = seed => (hash(seed) < 0.5 ? -1 : 1);
const step = (seed, side = sideOf(`side|${seed}`)) => 1 + side * between(`step|${seed}`, 0.07, 0.14);
function jitter(c, group) {
  const hours = step(`${c}|hours`);
  if (group === 'hours') return hours;
  const cuts = hours * step(`${c}|cuts`, -1); // down, like its tilt against hours
  if (group === 'cuts') return cuts;
  if (group === 'colorAttach') return jitter(c, 'colorTix') * step(`${c}|colorAttach`, 1);
  if (group === 'sigAttach') return jitter(c, 'sigTix') * step(`${c}|sigAttach`, -1);
  return cuts * step(`${c}|${group}`, tiltOf(group) >= tiltOf('cuts') ? 1 : -1);
}
function factor(code, group, year) {
  const c = String(code ?? 'all');
  if (group === 'days') return notOne(between(`days|${c}`, 0.86, 1.14));
  const byYear = year ? between(`yr|${c}|${year}`, 0.92, 1.08) * between(`yr|${c}|${group}|${year}`, 0.98, 1.02) : 1;
  return notOne(between(`size|${c}`, 0.75, 1.3) * jitter(c, group) * byYear * tiltOf(group));
}
function scaleVal(v, field, code, year, seed) {
  if (typeof v !== 'number' || !isFinite(v)) return v;
  const group = FIELD_GROUP[field];
  if (!group) return v;
  const out = v * factor(code, group, year);
  return COUNT_FIELDS.has(field) ? fairRound(out, `${seed}|${group}`) : cents(out);
}
// Product and extra-service lines: { [name]: { qty, amount } }.
function scaleLines(lines, code, year, seed, qtyGroup, amountGroup) {
  const out = {};
  Object.entries(lines).forEach(([name, v]) => {
    out[name] = { ...v, qty: fairRound((v.qty || 0) * factor(code, qtyGroup, year), `${seed}|${name}`), amount: cents((v.amount || 0) * factor(code, amountGroup, year)) };
  });
  return out;
}
function scaleFields(obj, code, year, seed) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  Object.keys(FIELD_GROUP).forEach(f => { if (f in out) out[f] = scaleVal(out[f], f, code, year, seed); });
  if (out.products && typeof out.products === 'object') out.products = scaleLines(out.products, code, year, seed, 'bottles', 'retail');
  if (out.extras && typeof out.extras === 'object') out.extras = scaleLines(out.extras, code, year, seed, 'extraQty', 'other');
  ATTACH_PAIRS.forEach(([part, whole]) => { if (typeof out[part] === 'number' && typeof out[whole] === 'number') out[part] = Math.min(out[part], out[whole]); });
  return out;
}
const yearOf = iso => (iso ? String(iso).slice(0, 4) : null);

// ─── Dataset fakers ─────────────────────────────────────────────────────────
function fakeHistory(history) {
  const out = {};
  Object.entries(history || {}).forEach(([k, r]) => {
    const year = yearOf(r.date);
    const rec = scaleFields(r, r.code, year, k);
    if (r.employees && typeof r.employees === 'object') {
      const emps = {};
      Object.entries(r.employees).forEach(([name, v]) => { emps[fakePersonName(name)] = scaleFields(v, r.code, year, `${k}|${normName(name)}`); });
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
      const rec = scaleFields(s, code, year, `${k}|${code}`);
      if (Array.isArray(s.employees)) rec.employees = s.employees.map(e => ({ ...scaleFields(e, code, year, `${k}|${code}|${normName(e.name)}`), name: fakePersonName(e.name) }));
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
    const employees = (s.employees || []).map(e => finalizeEmployee({ ...scaleFields(e, s.code, year, `${s.code}|${normName(e.name)}`), name: fakePersonName(e.name) }));
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
      const f = notOne(isPct ? between(`gp|${code}|${field}`, 0.85, 1.15) : factor(code, 'service') * between(`gj|${code}|${field}`, 0.9, 1.1));
      ng[field] = isPct ? Math.round(v * f * 1000) / 1000 : fairRound(v * f, `g|${code}|${field}`);
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

// Focus Stylist list: same shared name map as the faked employee rows, so
// each focus entry still lines up with its (faked) stylist's numbers. The
// per-store key is `${month}:` + the lowercased name (focusEntryKey in
// App.js), so it's rebuilt from the faked name, keeping any month prefix.
// Shear Check visits: some answers change and the score is worked out again
// from them; every name and free-text note is swapped out.
function fakeVisitAnswers(v, id) {
  const answers = {};
  Object.entries(v.answers || {}).forEach(([item, a]) => {
    const u = hash(`sc|${id}|${item}`);
    answers[item] = u < 0.06 ? 'no' : u < 0.1 ? 'na' : u < 0.2 ? 'yes' : a;
  });
  const sections = visitChecklist(v);
  let sc = scoreSalonCheck(answers, sections);
  if (sc.score === v.score) {
    const flip = Object.keys(answers).find(item => answers[item] === (sc.no ? 'no' : 'yes'));
    if (flip) { answers[flip] = sc.no ? 'yes' : 'no'; sc = scoreSalonCheck(answers, sections); }
  }
  return { answers, yes: sc.yes, no: sc.no, na: sc.na, score: sc.score };
}
function fakeSalonChecks(checks) {
  const names = t => (t ? t.split(',').map(n => n.trim()).filter(Boolean).map(fakePersonName).join(', ') : t);
  const out = {};
  Object.entries(checks || {}).forEach(([code, visits]) => {
    out[code] = {};
    Object.entries(visits || {}).forEach(([id, v]) => {
      if (!v) return;
      out[code][id] = {
        ...v,
        ...fakeVisitAnswers(v, id),
        manager: names(v.manager), team: names(v.team), by: v.by ? fakePersonName(v.by) : v.by,
        emailedTo: v.emailedTo ? fakePersonName(v.emailedTo) : v.emailedTo,
        notes: Object.fromEntries(Object.keys(v.notes || {}).map(k => [k, 'Sample note.'])),
        followUp: v.followUp ? 'Sample follow-up for next visit.' : v.followUp,
        photos: undefined, // real photos can't be faked, so they're left out
      };
    });
  });
  return out;
}

function fakeFocusStylists(focus) {
  const out = {};
  Object.entries(focus || {}).forEach(([code, entries]) => {
    out[code] = {};
    Object.entries(entries || {}).forEach(([key, e]) => {
      if (!e) return;
      const name = fakePersonName(e.name);
      const prefix = key.includes(':') ? key.slice(0, key.indexOf(':') + 1) : '';
      const goal = (field, step) => (typeof e[field] === 'number' ? { [field]: Math.round(e[field] * notOne(between(`fg|${key}|${field}`, 0.85, 1.15)) / step) * step } : {});
      out[code][prefix + name.trim().toLowerCase().replace(/\s+/g, ' ')] = { ...e, ...goal('tsthGoal', 1), ...goal('cphGoal', 0.1), name, addedBy: e.addedBy ? fakePersonName(e.addedBy) : e.addedBy };
    });
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
  const list = reviews.reviews.flatMap((r, i) => {
    const seed = `rev|${r.code}|${r.postedAt}|${r.userName}|${i}`;
    // Leave some out and nudge some stars, so review counts and star averages
    // aren't the real ones.
    if (hash(`${seed}|keep`) > between(`revkeep|${r.code}`, 0.7, 0.92)) return [];
    const nudge = hash(`${seed}|star`);
    const down = between(`revdown|${r.code}`, 0.1, 0.35);
    const rating = typeof r.rating === 'number' ? Math.min(5, Math.max(1, r.rating + (nudge < down ? -1 : nudge < down + 0.1 ? 1 : 0))) : r.rating;
    const text = String(r.message || '').toLowerCase();
    let mentioned = null;
    for (const emp of (realEmployeesByStore?.[r.code] || [])) {
      const first = String(emp.name || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z]/g, '');
      if (first.length >= 3 && new RegExp(`\\b${first.toLowerCase()}\\b`).test(text)) { mentioned = emp.name; break; }
    }
    const positive = (rating || 0) >= 4;
    let message = '';
    if (r.message) {
      message = mentioned
        ? pick(positive ? POSITIVE_WITH_NAME : NEGATIVE_WITH_NAME, seed).replace('{name}', fakeFirstName(mentioned))
        : pick(positive ? POSITIVE_REVIEWS : NEGATIVE_REVIEWS, seed);
    }
    const fake = { ...r, rating, userName: r.userName ? fakePersonName(r.userName) : r.userName, message, reply: r.reply ? 'Thank you so much for the feedback — we appreciate you!' : r.reply, url: '' };
    keyMap[`${r.code}|${r.postedAt}|${r.userName}|${r.rating}`] = `${fake.code}|${fake.postedAt}|${fake.userName}|${fake.rating}`;
    return [fake];
  });
  return { reviews: { ...reviews, reviews: list }, keyMap };
}

function remapKeys(obj, keyMap, mapValue = v => v) {
  const out = {};
  // A key with no match belongs to a review left out above, so it goes too.
  Object.entries(obj || {}).forEach(([k, v]) => { if (keyMap[k]) out[keyMap[k]] = mapValue(v); });
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
      baseRent: rec.baseRent !== '' && rec.baseRent != null && isFinite(rent) ? Math.round(rent * notOne(between(`rent|${code}`, 0.7, 1.3))) : rec.baseRent,
      rentEscalation: rec.rentEscalation ? `${Math.round(between(`esc|${code}`, 2, 4))}% annually` : rec.rentEscalation,
      notes: rec.notes ? 'Sample lease notes.' : rec.notes,
      renewalOptions: (rec.renewalOptions || []).map(ro => ({ ...ro, notes: ro.notes ? 'Sample note.' : ro.notes })),
      criticalDates: (rec.criticalDates || []).map(cd => ({ ...cd, notes: cd.notes ? 'Sample note.' : cd.notes })),
      files: (rec.files || []).map((f, i) => ({ ...f, name: `Sample Lease Document ${i + 1}.pdf`, size: typeof f.size === 'number' ? Math.round(f.size * notOne(between(`fs|${code}|${i}`, 0.7, 1.3))) : f.size })),
    };
  });
  return out;
}

function fakeHsaSignups(list) {
  return (list || []).map(s => ({ ...s, name: fakePersonName(s.name), phone: fakePhone(s.phone), dl: s.dl ? fakePersonName(s.dl) : s.dl, enteredBy: s.enteredBy ? fakePersonName(s.enteredBy) : s.enteredBy }));
}

function fakePoints(summary) {
  if (!summary) return summary;
  const out = { ...summary, selfName: fakePersonName(summary.selfName), selfBalance: Math.round((summary.selfBalance || 0) * between('pts|self', 0.6, 1.4)) };
  if (summary.companyWide) {
    out.companyWide = {
      ...summary.companyWide,
      totalOutstanding: Math.round((summary.companyWide.totalOutstanding || 0) * between('pts|total', 0.6, 1.4)),
      topBalances: (summary.companyWide.topBalances || []).map(b => ({ ...b, employeeName: fakePersonName(b.employeeName), balance: Math.round(b.balance * between(`pts|${b.employeeName}`, 0.6, 1.4)) })),
    };
  }
  return out;
}

// Loss Prevention ({ sales, att, reg } day maps, shapes in lossPrevention.js).
// Names go through the shared name map so staff/guest matching still lines
// up; dollars, ticket counts, hours and missed punches are all scaled, so the
// flags that trip are similar to the real ones but not the same. Invoice
// numbers are swapped. Free-text reasons are replaced, except the "vague"
// ones (".", "idk"...) the checks look for.
const LP_VAGUE = /^(|\.+|\?+|idk|i dont know|na|n\/a|none|no|-+|x+|ok|even)$/i;
const fakeLpReason = r => (!r || LP_VAGUE.test(r.trim()) ? r : 'Sample reason.');
function fakeLpData(lp) {
  if (!lp) return lp;
  const money = (code, v) => cents(v * notOne(between(`lp|${code}`, 0.7, 1.3)));
  const mapDays = (days, fn) => Object.fromEntries(Object.entries(days || {}).map(([d, v]) => [d, fn(v, d)]));
  // The second number is part of the first (cash tickets of all tickets), so
  // it gets its own multiplier or the real share would show through.
  const counts = (code, seed, [first, part]) => {
    const fakeFirst = fairRound(first * notOne(between(`lpn|${code}`, 0.75, 1.25)), seed);
    return [fakeFirst, Math.min(fakeFirst, fairRound(part * notOne(between(`lpp|${code}`, 0.7, 1.3)), `${seed}|part`))];
  };
  const fakeInv = inv => (inv ? String(Math.floor(hash(`inv|${inv}`) * 9000000) + 1000000) : inv);
  const countKeys = (obj, code, seed) => Object.fromEntries(Object.entries(obj || {}).map(([n, v]) => [fakePersonName(n), counts(code, `${seed}|${normName(n)}`, v)]));
  const mapStores = (stores, fn) => Object.fromEntries(Object.entries(stores || {}).map(([code, v]) => [code, fn(v, code)]));
  return {
    sales: mapDays(lp.sales, (stores, date) => mapStores(stores, (ds, code) => ({
      s: countKeys(ds.s, code, `s|${date}`),
      c: countKeys(ds.c, code, `c|${date}`),
      ev: (ds.ev || []).map(e => ({
        ...e,
        inv: fakeInv(e.inv),
        n: e.n ? fakePersonName(e.n) : e.n,
        ...(e.g ? { g: fakePersonName(e.g) } : {}),
        ...(e.a != null ? { a: money(code, e.a) } : {}),
        ...(e.l != null ? { l: money(code, e.l) } : {}),
        ...(e.why ? { why: fakeLpReason(e.why) } : {}),
      })),
    }))),
    att: mapDays(lp.att, (stores, date) => mapStores(stores, (people, code) => Object.fromEntries(Object.entries(people || {}).map(([n, [hrs, svcH, mIn, mOut, isStylist]]) => {
      const f = notOne(between(`lph|${code}`, 0.85, 1.15));
      const missed = v => fairRound(v * notOne(between(`lpm|${code}`, 0.7, 1.3)), `m|${date}|${normName(n)}`);
      const [fakeIn, fakeOut] = [missed(mIn), missed(mOut)];
      return [fakePersonName(n), [cents(hrs * f), cents(svcH * f), fakeIn, fakeOut, isStylist]];
    })))),
    reg: mapDays(lp.reg, rows => rows.map(([code, adj, reason, by, paid]) => [code, money(code, adj), fakeLpReason(reason), by ? fakePersonName(by) : by, money(code, paid)])),
  };
}

// Pay rates: one row per fake name, made from whoever the real rate lookup
// matches (it also handles aliases and middle names, which faking the names
// separately would break). Rates are nudged and employee numbers swapped.
function fakePayRates(rows, aliases, history, weekly) {
  if (!rows?.length) return [];
  const rateFor = buildRateLookup(rows, aliases);
  const names = new Set();
  Object.values(history || {}).forEach(r => Object.keys(r.employees || {}).forEach(n => names.add(n)));
  Object.values(weekly || {}).forEach(w => Object.values(w.stores || {}).forEach(s => (s.employees || []).forEach(e => names.add(e.name))));
  const out = new Map();
  names.forEach(real => {
    const hit = rateFor(real);
    const name = fakePersonName(real);
    if (!hit || out.has(name)) return;
    const rate = hit.rate == null ? null : cents(hit.rate * notOne(between(`rate|${hit.empNumber}`, 0.85, 1.15)));
    out.set(name, { emp_number: String(Math.floor(hash(`emp|${hit.empNumber}`) * 900000) + 100000), name, raw_name: name, rate });
  });
  return [...out.values()];
}

// PDFs are real documents (contest standings, memos) that can't be faked, so
// News shows its posts without them.
const fakeNews = news => (news || []).map(({ pdf, pdfs, ...post }) => ({ ...post, pdfs: [] }));

// One call from App.js — returns the fake counterpart of every dataset the
// tabs render. `realEmployeesByStore` is the REAL fallback roster (used only
// to spot which review mentioned which real stylist).
export function presenterView(real, realEmployeesByStore) {
  const { reviews, keyMap } = fakeReviewsData(real.reviews, realEmployeesByStore);
  return {
    report: fakeReport(real.report),
    history: fakeHistory(real.history),
    giftCardHistory: fakeHistory(real.giftCardHistory),
    tipsHistory: fakeHistory(real.tipsHistory),
    payRates: fakePayRates(real.payRates, real.nameAliases, real.history, real.weeklyHistory),
    nameAliases: {},
    news: fakeNews(real.news),
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
    lpData: fakeLpData(real.lpData),
    focusStylists: fakeFocusStylists(real.focusStylists),
    salonChecks: fakeSalonChecks(real.salonChecks),
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
