import React from 'react';
import { goalHeat, goalPace } from './goalProgress';

// Leadership's "all stores" heat bars at the top of the Retail, Color Sales,
// Signature Service and Gift Cards tabs: every store's actuals (goal or not)
// against every store's goal, added together. Owner login only, because a DL's data is
// scoped to their own stores and couldn't show the collective number.

function CollectiveBar({ label, actual, goal, stores, noGoalActual, noGoalStores, fmt, pace }) {
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
        {noGoalStores > 0 && ` · includes ${fmt(noGoalActual)} from ${noGoalStores} store${noGoalStores !== 1 ? 's' : ''} with no goal`}
      </p>
    </div>
  );
}

// bars: [{ label, actual, goal, stores, fmt, pace? }]. A bar's own pace is for a
// goal with its own dates. Bars with no goal are left out.
export function CollectiveGoalBars({ bars, start, end }) {
  const shown = bars.filter(b => b.goal > 0);
  if (!shown.length) return null;
  const pace = goalPace(start, end);
  return (
    <section className="collective-goal" aria-label="All stores progress toward the collective goal">
      <p className="collective-goal-title">🔥 All stores: collective goal</p>
      <div className="collective-goal-grid">
        {shown.map(b => <CollectiveBar key={b.label} {...b} pace={b.pace !== undefined ? b.pace : pace} />)}
      </div>
    </section>
  );
}
