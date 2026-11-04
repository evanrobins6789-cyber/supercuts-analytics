import React from 'react';

// Leadership's "all stores" heat bars at the top of the Retail, Color Sales,
// Signature Service and Gift Cards tabs: every store's actuals against every
// store's goal, added together. Owner login only, because a DL's data is
// scoped to their own stores and couldn't show the collective number.

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

function CollectiveBar({ label, actual, goal, stores, fmt, pace }) {
  const pct = (actual / goal) * 100;
  const heat = goalHeat(actual, goal, pace);
  return (
    <div className="collective-bar">
      <div className="collective-bar-head">
        <span className="collective-bar-label">{label}</span>
        <span className="collective-bar-pct">{Math.round(pct)}%</span>
      </div>
      <div
        className={`thermo-bar collective-bar-track thermo-bar--${heat.status}`}
        role="img"
        aria-label={`${label}: ${fmt(actual)} of ${fmt(goal)}, ${Math.round(pct)} percent${heat.text ? `, ${heat.text}` : ''}`}
      >
        <div className="thermo-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        {pace != null && pace < 1 && <div className="thermo-goal-tick" style={{ left: `${pace * 100}%` }} title={`Pace: ${Math.round(pace * 100)}%`} />}
      </div>
      <div className="collective-bar-foot">
        <span><strong>{fmt(actual)}</strong> of {fmt(goal)}</span>
        <span>{actual < goal ? `${fmt(goal - actual)} to go` : `${fmt(actual - goal)} over`}</span>
      </div>
      <p className="collective-bar-note">
        {heat.text && <strong className={`collective-heat collective-heat--${heat.status}`}>{heat.text}</strong>}
        {heat.text && ' · '}
        {pace != null && pace < 1 && `pace mark ${Math.round(pace * 100)}% · `}
        {stores} store{stores !== 1 ? 's' : ''} with a goal
      </p>
    </div>
  );
}

// bars: [{ label, actual, goal, stores, fmt }]. Bars with no goal are left out.
export function CollectiveGoalBars({ bars, start, end }) {
  const shown = bars.filter(b => b.goal > 0);
  if (!shown.length) return null;
  const pace = goalPace(start, end);
  return (
    <section className="collective-goal" aria-label="All stores progress toward the collective goal">
      <p className="collective-goal-title">🔥 All stores: collective goal</p>
      <div className="collective-goal-grid">
        {shown.map(b => <CollectiveBar key={b.label} {...b} pace={pace} />)}
      </div>
    </section>
  );
}
