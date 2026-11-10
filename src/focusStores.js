import React, { useMemo, useState } from 'react';
import { shiftMonthKey, openDaysInRange } from './metrics';

// ─── Focus Stores (leadership only) ─────────────────────────────────────────
// The user's 90-day Focus Store Plan (Nov 2026): leadership picks a few
// low-performing stores, works a checklist of responsibilities at each, and
// tracks whether the store hits its monthly Sales goal 3 months in a row.
//
// Stored in the `focus_stores` weekly_report row, owner-only on both read and
// write (src/scopeFilter.js, api/scoped-data.js):
//   { [storeCode]: {
//       startMonth: '2026-11', addedBy, addedAt,
//       'task:<taskId>': { by, at },              // a checked box (unchecked = key removed)
//       'custom:<id>': { owner, label, by, at },  // a task added for this store only
//   } }
// Flat keys because the server's patch merge is one level deep per store.

// The responsibilities, as written in the plan.
export const FOCUS_TEAM = [
  {
    id: 'karen', name: 'Karen', role: 'Guests, loyalty & local marketing',
    tasks: [
      { id: 'k-reviews', label: 'Review Google feedback; answer negative reviews within 48 hours' },
      { id: 'k-gbp', label: 'Keep the Google Business Profile current' },
      { id: 'k-loyalty', label: 'Grow loyalty sign-ups with the Zenoti 50-bonus-point offer' },
      { id: 'k-winback', label: 'Win-back campaign for unhappy and lapsed (60–90 day) guests' },
      { id: 'k-signs', label: 'Walk-Ins Welcome A-frames, flags and lawn signs out front' },
      { id: 'k-partners', label: '$3 OFF partnerships with nearby businesses' },
    ],
  },
  {
    id: 'kendra', name: 'Kendra', role: 'Technical skills & education',
    tasks: [
      { id: 'n-observe', label: 'Observe real services with the Technical Guest Experience Assessment' },
      { id: 'n-assess', label: 'Assess consultations, service times, haircut technique and guest education' },
      { id: 'n-priorities', label: 'Set one or two coaching priorities' },
      { id: 'n-checkback', label: 'Check back in about 30 days' },
      { id: 'n-recert', label: 'Get stylists recertified; teach product and Signature Services' },
    ],
  },
  {
    id: 'evan', name: 'Evan', role: 'Atmosphere & new guests',
    tasks: [
      { id: 'e-chairs', label: 'Check whether the store needs new waiting and styling chairs' },
      { id: 'e-repairs', label: 'Fix ceilings, paint, floors and cleanliness' },
      { id: 'e-landing', label: 'Build a landing page booking site for Meta offer ads' },
      { id: 'e-meta', label: 'Run targeted Meta offers to drive new guest traffic' },
    ],
  },
];
export const FOCUS_MONTHS = 3;
// The plan's "goal +$1k each month": used only for a month whose Sales goal
// hasn't been set on the Goals tab yet, and always labeled as planned.
export const PLANNED_GOAL_STEP = 1000;

const pad2 = n => String(n).padStart(2, '0');
const monthEndISO = mk => { const [y, m] = mk.split('-').map(Number); return `${mk}-${pad2(new Date(y, m, 0).getDate())}`; };
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtMonthShort = mk => `${MONTHS_SHORT[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`;
const fmtMoney = n => (n == null || isNaN(n) ? '—' : `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);
const fmtSigned = n => (n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : '−'}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);
// A bare "YYYY-MM-DD" is read as a local date (new Date() would read it as
// UTC and show the day before in the evening); full timestamps as-is.
const fmtDay = iso => {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return isNaN(d) ? '' : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
};

export function focusStoreList(focusStores) {
  return Object.entries(focusStores || {})
    .filter(([code, rec]) => rec && typeof rec === 'object' && rec.startMonth && !code.startsWith('_'))
    .map(([code, rec]) => ({ code, ...rec }));
}

// Each person's tasks for one store, with what's been checked.
export function focusTasksFor(rec) {
  const custom = Object.entries(rec || {}).filter(([k, v]) => k.startsWith('custom:') && v && v.label)
    .map(([k, v]) => ({ id: k.slice(7), label: v.label, owner: v.owner, custom: true, at: v.at }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return FOCUS_TEAM.map(p => {
    const tasks = [...p.tasks, ...custom.filter(c => c.owner === p.id)]
      .map(t => ({ ...t, done: rec?.[`task:${t.id}`] || null }));
    return { ...p, tasks, doneCount: tasks.filter(t => t.done).length };
  });
}
export function focusTaskCounts(rec) {
  const people = focusTasksFor(rec);
  const total = people.reduce((s, p) => s + p.tasks.length, 0);
  const done = people.reduce((s, p) => s + p.doneCount, 0);
  return { total, done };
}

// The sales tracker for one store.
//   salesFor(mk) → this store's Sales (service + retail) for month mk, through
//   `throughISO` (the last day with uploaded data), or null if none.
// Each month: the Goals tab's Sales goal if set, else last month's goal +
// PLANNED_GOAL_STEP (planned: true). Pace projects the current month to its
// end by open days (holidays out, like the rest of the site).
// Pre-plan pace ("if nothing changes", same method as the plan's PDF): last
// year's same month × how the month before the start ran against last year.
export function focusTracker(rec, code, goals, salesFor, throughISO) {
  const start = rec.startMonth;
  const g = goals?.[code] || {};
  const before = salesFor(shiftMonthKey(start, -1));
  const beforeLy = salesFor(shiftMonthKey(start, -13));
  const trend = before > 0 && beforeLy > 0 ? before / beforeLy : null;
  const months = [];
  let prevGoal = null;
  for (let i = 0; i < FOCUS_MONTHS; i++) {
    const mk = shiftMonthKey(start, i);
    const set = g[`salesGoal:${mk}`];
    let goal = set != null && set !== '' && !isNaN(Number(set)) ? Number(set) : null;
    let planned = false;
    if (goal == null && prevGoal != null) { goal = prevGoal + PLANNED_GOAL_STEP; planned = true; }
    prevGoal = goal;
    const end = monthEndISO(mk);
    const ly = salesFor(shiftMonthKey(mk, -12));
    const baseline = trend != null && ly > 0 ? ly * trend : null;
    const m = { mk, goal, planned, baseline, sales: null, projected: null, status: 'upcoming', needPerDay: null, daysLeft: null };
    if (throughISO && `${mk}-01` <= throughISO) {
      const sales = salesFor(mk) || 0;
      m.sales = sales;
      if (throughISO >= end) {
        m.projected = sales;
        m.status = goal == null ? 'no-goal' : sales >= goal ? 'hit' : 'missed';
      } else {
        const elapsed = openDaysInRange(`${mk}-01`, throughISO);
        const total = openDaysInRange(`${mk}-01`, end);
        m.daysLeft = total - elapsed;
        m.projected = sales > 0 && elapsed > 0 ? (sales / elapsed) * total : null;
        if (goal != null && m.daysLeft > 0) m.needPerDay = Math.max(0, goal - sales) / m.daysLeft;
        m.status = goal == null ? 'no-goal' : sales >= goal ? 'hit' : m.projected == null ? 'no-data' : m.projected >= goal ? 'on-pace' : 'behind';
        m.current = true;
      }
    }
    months.push(m);
  }
  const hit = months.filter(m => m.status === 'hit' && !m.current).length;
  const missed = months.filter(m => m.status === 'missed');
  const sum = arr => (arr.some(v => v == null) ? null : arr.reduce((a, b) => a + b, 0));
  const goalTotal = sum(months.map(m => m.goal));
  const baselineTotal = sum(months.map(m => m.baseline));
  // Months started so far: what's been sold (or is on pace to be) vs. pre-plan pace.
  const started = months.filter(m => m.sales != null);
  const soFar = started.length ? {
    months: started.length,
    sales: started.reduce((s, m) => s + (m.sales || 0), 0),
    projected: started.some(m => m.projected == null) ? null : started.reduce((s, m) => s + m.projected, 0),
    baseline: sum(started.map(m => m.baseline)),
  } : null;
  const startISO = `${start}-01`;
  const day = throughISO && throughISO >= startISO ? Math.min(90, Math.round((new Date(`${throughISO}T00:00:00`) - new Date(`${startISO}T00:00:00`)) / 86400000) + 1) : 0;
  return {
    months, trend, hit, missed, day,
    graduated: hit === FOCUS_MONTHS,
    goalTotal, baselineTotal,
    extraAtGoal: goalTotal != null && baselineTotal != null ? goalTotal - baselineTotal : null,
    soFar,
  };
}

// Tilly's FOCUS STORES block (owner only).
export function focusStoresContext(focusStores, goals, salesForStore, throughISO, storeName) {
  const list = focusStoreList(focusStores);
  if (!list.length) return '';
  const lines = ['', `FOCUS STORES (leadership's 90-day plan: hit the monthly Sales goal 3 months in a row; Karen = guests, loyalty & local marketing, Kendra = technical skills & education, Evan = atmosphere & new guests; data through ${throughISO || 'n/a'}):`];
  list.forEach(rec => {
    const t = focusTracker(rec, rec.code, goals, mk => salesForStore(rec.code, mk), throughISO);
    const months = t.months.map(m => `${fmtMonthShort(m.mk)} goal ${fmtMoney(m.goal)}${m.planned ? ' (planned, not set on Goals tab)' : ''}, sales ${fmtMoney(m.sales)}${m.current ? `, projected ${fmtMoney(m.projected)}` : ''}, ${m.status}`).join('; ');
    const counts = focusTaskCounts(rec);
    const open = focusTasksFor(rec).map(p => `${p.name}: ${p.tasks.filter(x => !x.done).map(x => x.label).join(' / ') || 'all done'}`).join(' | ');
    lines.push(`${storeName(rec.code)} (started ${fmtMonthShort(rec.startMonth)}, day ${t.day} of 90, ${t.hit} of 3 months hit${t.graduated ? ', GRADUATED' : ''}): ${months}. Pre-plan pace for the 3 months ${fmtMoney(t.baselineTotal)}, at goal ${fmtMoney(t.goalTotal)} (${fmtSigned(t.extraAtGoal)}). Tasks ${counts.done} of ${counts.total} done; still open — ${open}`);
  });
  return lines.join('\n');
}

const STATUS_LABEL = {
  hit: ['Hit', 'fs-chip--hit'], missed: ['Missed', 'fs-chip--miss'], 'on-pace': ['On pace', 'fs-chip--hit'],
  behind: ['Behind', 'fs-chip--miss'], upcoming: ['Upcoming', ''], 'no-goal': ['No goal set', ''], 'no-data': ['No sales yet', ''],
};

function StoreTracker({ t }) {
  return (
    <div className="fs-table-wrap">
      <table className="fs-table">
        <thead>
          <tr><th>Month</th><th>Sales goal</th><th>Sales</th><th>Projected</th><th>vs goal</th><th>Pre-plan pace</th><th>Status</th></tr>
        </thead>
        <tbody>
          {t.months.map(m => {
            const vs = m.goal != null && m.projected != null ? m.projected - m.goal : null;
            const [label, cls] = STATUS_LABEL[m.status] || [m.status, ''];
            return (
              <tr key={m.mk} className={m.current ? 'fs-row-current' : ''}>
                <td>{fmtMonthShort(m.mk)}</td>
                <td>{fmtMoney(m.goal)}{m.planned && <span className="fs-planned" title="Not set on the Goals tab yet. The plan's last month + $1,000.">planned</span>}</td>
                <td>{m.sales == null ? '—' : fmtMoney(m.sales)}</td>
                <td>{m.current ? fmtMoney(m.projected) : m.sales == null ? '—' : fmtMoney(m.sales)}</td>
                <td className={vs == null ? '' : vs >= 0 ? 'fs-up' : 'fs-down'}>{fmtSigned(vs)}</td>
                <td>{fmtMoney(m.baseline)}</td>
                <td>
                  <span className={`fs-chip ${cls}`}>{label}</span>
                  {m.current && m.needPerDay != null && m.status !== 'hit' && <div className="fs-need">{fmtMoney(m.needPerDay)}/day for {m.daysLeft} open day{m.daysLeft === 1 ? '' : 's'}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskList({ rec, readOnly, onToggle, onAddTask, onRemoveTask, showName }) {
  const [adding, setAdding] = useState(null); // person id
  const [draft, setDraft] = useState('');
  const submit = owner => {
    const label = draft.trim();
    if (label) onAddTask(owner, label.slice(0, 200));
    setDraft(''); setAdding(null);
  };
  return (
    <div className="fs-people">
      {focusTasksFor(rec).map(p => (
        <div key={p.id} className="fs-person">
          <div className="fs-person-head">
            <strong>{showName(p.name)}</strong>
            <span className="fs-person-count">{p.doneCount}/{p.tasks.length}</span>
          </div>
          <div className="fs-person-role">{p.role}</div>
          <ul className="fs-tasks">
            {p.tasks.map(task => (
              <li key={task.id} className={task.done ? 'fs-task-done' : ''}>
                <label>
                  <input type="checkbox" checked={!!task.done} disabled={readOnly} onChange={() => onToggle(task.id, !task.done)} />
                  <span>{task.label}</span>
                </label>
                {task.done && <div className="fs-task-by">✓ {showName(task.done.by || '')}{task.done.at ? ` · ${fmtDay(task.done.at)}` : ''}</div>}
                {task.custom && !readOnly && <button type="button" className="fs-link fs-task-remove" onClick={() => onRemoveTask(task.id)} title="Remove this task">Remove</button>}
              </li>
            ))}
          </ul>
          {!readOnly && (adding === p.id ? (
            <div className="fs-add-task">
              <input autoFocus value={draft} maxLength={200} placeholder="New task for this store" onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(p.id); if (e.key === 'Escape') { setAdding(null); setDraft(''); } }} />
              <button type="button" className="fs-btn" onClick={() => submit(p.id)}>Add</button>
              <button type="button" className="fs-link" onClick={() => { setAdding(null); setDraft(''); }}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="fs-link" onClick={() => { setAdding(p.id); setDraft(''); }}>+ Add task</button>
          ))}
        </div>
      ))}
    </div>
  );
}

// monthSales(mk) → { [code]: { sales } } for month mk (through the last data day).
export function FocusStoresTab({ focusStores, goals, monthSales, throughISO, storeNames, dlFor, userName, readOnly, showName = n => n, onPatch }) {
  const [addCode, setAddCode] = useState('');
  const currentMk = (throughISO || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const [addStart, setAddStart] = useState(currentMk);
  const [openCode, setOpenCode] = useState(null);

  // One month's store totals per month key, computed once per render pass.
  const salesFor = useMemo(() => {
    const cache = new Map();
    return (code, mk) => {
      if (!cache.has(mk)) cache.set(mk, monthSales(mk) || {});
      const v = cache.get(mk)[code]?.sales;
      return v > 0 ? v : null;
    };
  }, [monthSales]);

  const list = focusStoreList(focusStores)
    .map(rec => ({ ...rec, name: storeNames[rec.code] || `Store ${rec.code}`, t: focusTracker(rec, rec.code, goals, mk => salesFor(rec.code, mk), throughISO), counts: focusTaskCounts(rec) }))
    .sort((a, b) => a.startMonth.localeCompare(b.startMonth) || a.name.localeCompare(b.name));
  const focusCodes = new Set(list.map(r => r.code));

  // Suggestions: the last full month vs the same month last year, worst first.
  const lastFull = shiftMonthKey(currentMk, -1);
  const suggestions = Object.keys(storeNames)
    .filter(code => !focusCodes.has(code))
    .map(code => {
      const s = salesFor(code, lastFull), ly = salesFor(code, shiftMonthKey(lastFull, -12));
      return s && ly ? { code, name: storeNames[code], yoy: s / ly - 1 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.yoy - b.yoy)
    .slice(0, 8);
  const addable = Object.entries(storeNames).filter(([code]) => !focusCodes.has(code) && salesFor(code, lastFull)).sort((a, b) => a[1].localeCompare(b[1]));

  const addStore = (code, startMonth = addStart) => {
    if (!code || focusCodes.has(code)) return;
    onPatch({ [code]: { startMonth, addedBy: userName, addedAt: new Date().toISOString() } });
    setAddCode('');
    setOpenCode(code);
  };
  const removeStore = rec => {
    if (!window.confirm(`Take ${rec.name} off the focus list? Its checklist will be cleared.`)) return;
    onPatch({ [rec.code]: null });
  };
  const restart = rec => {
    if (!window.confirm(`Restart ${rec.name}'s 90 days from ${fmtMonthShort(currentMk)}? Checked tasks stay checked.`)) return;
    onPatch({ [rec.code]: { startMonth: currentMk } });
  };
  const toggleTask = (code, taskId, done) => onPatch({ [code]: { [`task:${taskId}`]: done ? { by: userName, at: new Date().toISOString() } : null } });
  const addTask = (code, owner, label) => onPatch({ [code]: { [`custom:${Date.now().toString(36)}`]: { owner, label, by: userName, at: new Date().toISOString() } } });
  const removeTask = (code, id) => onPatch({ [code]: { [`custom:${id}`]: null, [`task:${id}`]: null } });

  // Company roll-up across the focus stores.
  const roll = list.reduce((acc, r) => {
    acc.goal = acc.goal == null || r.t.goalTotal == null ? null : acc.goal + r.t.goalTotal;
    acc.baseline = acc.baseline == null || r.t.baselineTotal == null ? null : acc.baseline + r.t.baselineTotal;
    acc.done += r.counts.done; acc.total += r.counts.total;
    if (r.t.soFar) {
      acc.sold += r.t.soFar.sales;
      if (acc.soFarLift != null) acc.soFarLift = r.t.soFar.projected == null || r.t.soFar.baseline == null ? null : acc.soFarLift + (r.t.soFar.projected - r.t.soFar.baseline);
    }
    if (r.t.graduated) acc.graduated++;
    return acc;
  }, { goal: 0, baseline: 0, done: 0, total: 0, sold: 0, soFarLift: 0, graduated: 0 });

  return (
    <div className="tab-content fs-tab">
      <p className="section-hint">
        Leadership only. <strong>The goal: hit the monthly Sales goal 3 months in a row.</strong> Assess &amp; launch (days 1–30) → Coach &amp; fix (31–60) → Measure (61–90).
        A store that hits it graduates and the next store takes its place. Sales are service + retail through {throughISO ? fmtDay(throughISO) : 'the last upload'}.
      </p>

      {list.length > 0 && (
        <div className="fs-summary">
          <div><div className="fs-big">{list.length}</div><div className="fs-cap">focus store{list.length === 1 ? '' : 's'}{roll.graduated ? ` · ${roll.graduated} graduated` : ''}</div></div>
          <div><div className="fs-big fs-up">{fmtSigned(roll.goal != null && roll.baseline != null ? roll.goal - roll.baseline : null)}</div><div className="fs-cap">more over 90 days at goal than pre-plan pace ({fmtMoney(roll.goal)} vs {fmtMoney(roll.baseline)})</div></div>
          <div><div className={`fs-big ${roll.soFarLift == null ? '' : roll.soFarLift >= 0 ? 'fs-up' : 'fs-down'}`}>{fmtSigned(roll.soFarLift)}</div><div className="fs-cap">vs pre-plan pace so far, with this month projected ({fmtMoney(roll.sold)} sold)</div></div>
          <div><div className="fs-big">{roll.done}/{roll.total}</div><div className="fs-cap">responsibilities done</div></div>
        </div>
      )}

      {!readOnly && (
        <div className="fs-add">
          <p className="section-label">Add a focus store</p>
          <div className="fs-add-row">
            <select value={addCode} onChange={e => setAddCode(e.target.value)}>
              <option value="">Pick a store…</option>
              {addable.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <select value={addStart} onChange={e => setAddStart(e.target.value)} title="First of the 3 months">
              {[0, 1].map(n => { const mk = shiftMonthKey(currentMk, n); return <option key={mk} value={mk}>Starts {fmtMonthShort(mk)}</option>; })}
            </select>
            <button type="button" className="fs-btn" disabled={!addCode} onClick={() => addStore(addCode)}>Add</button>
          </div>
          {suggestions.length > 0 && (
            <div className="fs-suggest">
              <span className="fs-cap">Furthest below last year in {fmtMonthShort(lastFull)}:</span>
              {suggestions.map(s => (
                <button key={s.code} type="button" className="fs-suggest-chip" onClick={() => addStore(s.code)} title={`Add ${s.name} starting ${fmtMonthShort(addStart)}`}>
                  {s.name} <span className={s.yoy < 0 ? 'fs-down' : 'fs-up'}>{s.yoy >= 0 ? '+' : '−'}{Math.abs(s.yoy * 100).toFixed(1)}%</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!list.length && <p className="empty-note">No focus stores yet. Pick one above to start its 90 days.</p>}

      {list.map(rec => {
        const { t } = rec;
        const open = openCode === rec.code || list.length === 1;
        const cur = t.months.find(m => m.current);
        const dl = dlFor(rec.code);
        return (
          <div key={rec.code} className={`fs-card${t.graduated ? ' fs-card--grad' : ''}`}>
            <button type="button" className="fs-card-head" onClick={() => setOpenCode(open && list.length > 1 ? null : rec.code)} aria-expanded={open}>
              <div className="fs-card-title">
                <span className="fs-store">{rec.name}</span>
                <span className="fs-meta">{dl ? `${showName(dl)} · ` : ''}started {fmtMonthShort(rec.startMonth)} · day {t.day} of 90</span>
              </div>
              <div className="fs-months">
                {t.months.map(m => {
                  const s = m.status === 'hit' && !m.current ? 'hit' : m.status === 'missed' ? 'miss' : m.current ? (m.status === 'behind' ? 'behind' : 'live') : 'todo';
                  return <span key={m.mk} className={`fs-dot fs-dot--${s}`} title={`${fmtMonthShort(m.mk)}: ${(STATUS_LABEL[m.status] || [m.status])[0]}`}>{MONTHS_SHORT[Number(m.mk.slice(5, 7)) - 1]}</span>;
                })}
              </div>
              <div className="fs-card-stats">
                {t.graduated ? <span className="fs-chip fs-chip--hit">🎓 Graduated</span> : cur ? (
                  <span>{fmtMoney(cur.sales)} of {fmtMoney(cur.goal)} · <span className={STATUS_LABEL[cur.status]?.[1] === 'fs-chip--hit' ? 'fs-up' : cur.status === 'behind' ? 'fs-down' : ''}>{STATUS_LABEL[cur.status]?.[0]}</span></span>
                ) : <span>{t.hit} of 3 hit</span>}
                <span className="fs-cap">{rec.counts.done}/{rec.counts.total} tasks</span>
              </div>
              <span className="fs-caret">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div className="fs-card-body">
                <div className="fs-progress"><div style={{ width: `${rec.counts.total ? (rec.counts.done / rec.counts.total) * 100 : 0}%` }} /></div>
                <StoreTracker t={t} />
                <p className="fs-worth">
                  {t.extraAtGoal != null
                    ? <>At goal, the 3 months bring in <strong>{fmtMoney(t.goalTotal)}</strong> vs <strong>{fmtMoney(t.baselineTotal)}</strong> at pre-plan pace: <strong className="fs-up">{fmtSigned(t.extraAtGoal)}</strong> ({fmtSigned(t.extraAtGoal / 3)} a month).</>
                    : <>Set a Sales goal for {fmtMonthShort(rec.startMonth)} on the Goals tab to see what hitting it is worth.</>}
                  {t.soFar && t.soFar.projected != null && t.soFar.baseline != null && <> So far{cur ? ' (this month projected)' : ''}: <strong className={t.soFar.projected - t.soFar.baseline >= 0 ? 'fs-up' : 'fs-down'}>{fmtSigned(t.soFar.projected - t.soFar.baseline)}</strong> vs pre-plan pace.</>}
                  <span className="fs-cap"> Pre-plan pace = last year's month × how {fmtMonthShort(shiftMonthKey(rec.startMonth, -1))} ran vs last year{t.trend != null ? ` (${t.trend >= 1 ? '+' : '−'}${Math.abs((t.trend - 1) * 100).toFixed(1)}%)` : ''}.</span>
                </p>
                {t.missed.length > 0 && !t.graduated && (
                  <p className="fs-missed">Missed {t.missed.map(m => fmtMonthShort(m.mk)).join(', ')}.{!readOnly && rec.startMonth !== currentMk && <> <button type="button" className="fs-link" onClick={() => restart(rec)}>Restart the 90 days from {fmtMonthShort(currentMk)}</button></>}</p>
                )}
                <TaskList rec={rec} readOnly={readOnly} showName={showName}
                  onToggle={(id, done) => toggleTask(rec.code, id, done)}
                  onAddTask={(owner, label) => addTask(rec.code, owner, label)}
                  onRemoveTask={id => removeTask(rec.code, id)} />
                {!readOnly && <div className="fs-card-foot"><button type="button" className="fs-link fs-remove" onClick={() => removeStore(rec)}>{t.graduated ? 'Graduate and take off the list' : 'Take off the focus list'}</button></div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
