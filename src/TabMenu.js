import React, { useEffect, useState } from 'react';

// Site navigation: one button showing the current tab. Clicking it opens every
// tab at once, sorted under these headers. `tabs` is what this login may see,
// so a role's empty groups simply don't show. A new tab that isn't listed here
// still appears, under "More", so it can't go missing from the menu.
export const TAB_GROUPS = [
  { title: 'Home', tabs: ['Homepage', 'My Numbers', 'News', 'HSA'] },
  { title: 'Performance', tabs: ['Overview', 'DL', 'Employees', 'Weekly', 'Reviews'] },
  { title: 'Sales', tabs: ['Retail', 'Color Sales', 'Signature Service', 'Gift Cards'] },
  { title: 'Coaching', tabs: ['Focus Stylist', 'Shear Check', 'Goals', "Tillie's Nest"] },
  { title: 'Admin', tabs: ['Budgets', 'Leases', 'Loss Prevention', 'Setup'] },
];

export function groupTabs(tabs) {
  const listed = new Set(TAB_GROUPS.flatMap(g => g.tabs));
  const groups = TAB_GROUPS.map(g => ({ ...g, tabs: g.tabs.filter(t => tabs.includes(t)) }));
  groups.push({ title: 'More', tabs: tabs.filter(t => !listed.has(t)) });
  return groups.filter(g => g.tabs.length);
}

export function TabMenu({ tabs, tab, onPick }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const pick = t => {
    setOpen(false);
    onPick(t);
    // The menu stays on screen while scrolling, so a pick can come from far
    // down a page. Start the new tab at its top.
    window.scrollTo(0, 0);
  };

  return (
    <nav className={`tab-nav ${open ? 'tab-nav--open' : ''}`}>
      <button type="button" className="tab-menu-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)}>
        <span className="tab-menu-icon" aria-hidden="true">☰</span>
        <span className="tab-menu-current">{tab}</span>
        <span className="tab-menu-hint">All tabs</span>
      </button>
      {open && (
        <>
          <button type="button" className="tab-menu-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="tab-menu-panel" role="dialog" aria-label="All tabs">
            <div className="tab-menu-top">
              <span>All tabs</span>
              <button type="button" className="tab-menu-close" aria-label="Close menu" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="tab-menu-groups">
              {groupTabs(tabs).map(g => (
                <section key={g.title} className="tab-menu-group">
                  <h2 className="tab-menu-heading">{g.title}</h2>
                  <div className="tab-menu-items">
                    {g.tabs.map(t => (
                      <button key={t} type="button" className={`tab-btn ${tab === t ? 'active' : ''}`} aria-current={tab === t ? 'page' : undefined} onClick={() => pick(t)}>{t}</button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </>
      )}
    </nav>
  );
}
