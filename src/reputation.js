// "My Reputation" on the My Numbers tab (2026-11-20). User: show the reviews
// a stylist has been mentioned in, and the no-shows, cancels and walkouts
// under their name.
//
// Reviews: same rule as the Reviews tab / Shoutouts (detectEmployeeMention in
// App.js): the review is at a store they work at and its text has their
// first name (3+ letters) as a whole word. Two people at one store with the
// same first name both get the review.
//
// No-shows / cancels / walkouts: from the Appointments report, counted per
// stylist at upload (classifyAppointments in src/appointments.js) and saved
// to lp_apptstaff_YYYY-MM in the owner-only loss_prevention table, since
// weekly_report is readable with the public key:
//   { days: { [isoDate]: { [code]: { [normalizedStylistName]: [C, N, W] } } } }
// Same rules as the Scheduling tab's lost guests: a guest serviced that day
// anyway, or a row marked incorrect/duplicate/test, isn't counted. The
// stylist is whoever the appointment was booked under (the system picks one
// for "any stylist" bookings).
//
// Plain JS, shared by api/_my-numbers.js (an employee's own) and App.js
// (leadership's pick, View as DL).

export const normName = raw => String(raw || '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const MAX_REVIEWS = 50;

// "Mar 3, 2026 10:14 AM" / ISO / "3/3/2026" → sortable ms (0 if unreadable).
const reviewTime = r => { const t = Date.parse(r.postedAt || ''); return Number.isFinite(t) ? t : 0; };

export function firstNamesOf(names) {
  const out = new Set();
  [...names].forEach(n => {
    const first = normName(n).split(' ')[0].replace(/[^a-z]/g, '');
    if (first.length >= 3) out.add(first);
  });
  return out;
}

// names: Set of normalized names (login name + aliases). codes: stores they
// work at. reviews: the reviews row's `reviews` array. staffDays: merged
// lp_apptstaff `days`. start/end: My Numbers' dates (counts for the range and
// for everything on file).
export function buildReputation({ names, codes, reviews = [], staffDays = {}, start, end }) {
  const firsts = firstNamesOf(names);
  const codeSet = new Set([...codes].map(String));
  const res = [...firsts].map(f => new RegExp(`\\b${f}\\b`));
  const mentioned = firsts.size ? reviews.filter(r => codeSet.has(String(r.code)) && r.message && res.some(re => re.test(r.message.toLowerCase()))) : [];
  mentioned.sort((a, b) => reviewTime(b) - reviewTime(a));
  const rated = mentioned.filter(r => r.rating > 0);

  const zero = () => ({ C: 0, N: 0, W: 0 });
  const range = zero(), all = zero();
  const dates = Object.keys(staffDays || {}).sort();
  let first = null, last = null;
  dates.forEach(d => {
    Object.values(staffDays[d] || {}).forEach(byName => {
      Object.entries(byName || {}).forEach(([n, v]) => {
        if (!names.has(n)) return;
        const [c, ns, w] = v || [];
        all.C += c || 0; all.N += ns || 0; all.W += w || 0;
        if (d >= start && d <= end) { range.C += c || 0; range.N += ns || 0; range.W += w || 0; }
      });
    });
  });
  if (dates.length) { first = dates[0]; last = dates[dates.length - 1]; }
  return {
    reviews: mentioned.slice(0, MAX_REVIEWS).map(r => ({ code: r.code, postedAt: r.postedAt, rating: r.rating, message: r.message, userName: r.userName, url: r.url || '' })),
    reviewCount: mentioned.length,
    avgRating: rated.length ? rated.reduce((t, r) => t + r.rating, 0) / rated.length : null,
    lost: { range, all, from: first, to: last },
  };
}

// The per-stylist counts for one classified Appointments file (C/N/W rows
// only), as { [date]: { [code]: { [name]: [C, N, W] } } }.
export function staffDaysFrom(rows) {
  const out = {};
  rows.forEach(({ date, code, stylist, s }) => {
    const n = normName(stylist);
    if (!n || !(s === 'C' || s === 'N' || s === 'W')) return;
    const byCode = (out[date] = out[date] || {});
    const byName = (byCode[code] = byCode[code] || {});
    const v = (byName[n] = byName[n] || [0, 0, 0]);
    v[s === 'C' ? 0 : s === 'N' ? 1 : 2]++;
  });
  return out;
}

// One line for Tilly.
export function reputationContext(rep, who = 'This person') {
  if (!rep) return '';
  const l = rep.lost;
  const lostLine = l.from ? ` Booked under their name (Appointments ${l.from} to ${l.to}): ${l.all.N} no-shows, ${l.all.C} cancels, ${l.all.W} walkouts (${l.range.N}/${l.range.C}/${l.range.W} in the dates shown).` : '';
  return `\nMY REPUTATION: ${who} is named in ${rep.reviewCount} review${rep.reviewCount === 1 ? '' : 's'}${rep.avgRating != null ? `, averaging ${rep.avgRating.toFixed(1)} stars` : ''}.${lostLine}`;
}
