// Collective goal math, shared by the heat bars on the site
// (src/CollectiveGoalBars.js) and the Monday Goal Progress email
// (api/_goal-progress-email.js). No React here, so the server can import it.

// Adds up stores with a goal. A store with a goal and no sales yet still counts
// toward the goal, and sales at a store with no goal don't count (they'd
// inflate progress against a goal that doesn't include them).
export function collectiveGoal(codes, goalOf, actualOf) {
  let goal = 0;
  let actual = 0;
  let stores = 0;
  [...new Set(codes)].forEach(code => {
    const g = goalOf(code);
    if (!(g > 0)) return;
    goal += g;
    actual += actualOf(code) || 0;
    stores += 1;
  });
  return { goal, actual, stores };
}

const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const addMonth = mk => {
  const [y, m] = mk.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

// How far through the goal period we are, 0 to 1. Goals are FULL monthly goals
// (goalForRange), so a fair "should be here by now" is days done ÷ days in the
// month(s). Today isn't counted, since its sales aren't in yet. Null when the
// dates don't start on the 1st: those sales are only part of what counts
// toward the month, so a pace would be meaningless.
export function goalPace(start, end, today = new Date().toISOString().slice(0, 10)) {
  if (!start || !end || start > end || start.slice(8) !== '01') return null;
  let totalDays = 0;
  for (let mk = start.slice(0, 7); mk <= end.slice(0, 7); mk = addMonth(mk)) {
    const [y, m] = mk.split('-').map(Number);
    totalDays += new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  const daysDone = end < today ? dayDiff(start, end) + 1 : dayDiff(start, today);
  if (daysDone <= 0) return null;
  return Math.min(1, daysDone / totalDays);
}

// Gift card goals that run longer than a month (the user, 2026-11-04: the
// holiday goal runs through the end of December). It's saved once, under
// `goalMonth` on the Goals tab. For any dates touching the period, that one
// goal applies, and progress counts every sale since the period started.
export const GIFT_CARD_GOAL_PERIODS = [
  { goalMonth: '2026-11', start: '2026-11-01', end: '2026-12-31', label: 'Nov 1 – Dec 31' },
];
export const giftCardPeriodFor = (start, end) => GIFT_CARD_GOAL_PERIODS.find(p => start <= p.end && end >= p.start) || null;
export function giftCardPeriodGoal(goals, code, period) {
  const v = goals?.[code]?.[`giftCardGoal:${period.goalMonth}`];
  return v == null || v === '' ? null : Number(v);
}
// Last day of the period that sales can count through so far.
export const periodThrough = (period, today = new Date().toISOString().slice(0, 10)) => (today < period.end ? today : period.end);
// Like goalPace, but across the whole period, so November isn't judged as if
// the goal were due on Nov 30.
export function periodPace(period, through, today = new Date().toISOString().slice(0, 10)) {
  const totalDays = dayDiff(period.start, period.end) + 1;
  const daysDone = through < today ? dayDiff(period.start, through) + 1 : dayDiff(period.start, today);
  if (daysDone <= 0) return null;
  return Math.min(1, daysDone / totalDays);
}

// Heat color + wording. With a pace: green at or ahead of it, gold within 10%
// of it, red further behind. Without one: green at the goal, otherwise gold.
export function goalHeat(actual, goal, pace) {
  if (actual >= goal) return { status: 'hit', text: 'Goal hit' };
  if (pace == null) return { status: 'onpace', text: null };
  const ratio = actual / (goal * pace);
  if (ratio >= 1) return { status: 'hit', text: 'Ahead of pace' };
  if (ratio >= 0.9) return { status: 'onpace', text: 'Close to pace' };
  return { status: 'behind', text: 'Behind pace' };
}
