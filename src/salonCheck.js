// Shear Check: the salon visit checklist (from Salon_Checklist_Printable_Final.pdf).
// Shared by the tab (src/App.js), the save check in api/scoped-data.js and
// the DL email (api/_salon-check.js), so the items and the score math can't
// drift apart.
//
// Item ids are stored with every saved visit. Never reuse or renumber an id.
//
// Leadership adds and deletes questions on the tab, stored separately in the
// `salon_check_questions` row as { added: [{ id, sectionId, label }], removed:
// [itemId] }. Don't edit SALON_CHECK_SECTIONS to change the checklist: it's the
// base list, and visits saved before 2026-11-05 have no copy of their own
// questions, so they display from it. Every later visit stores its own
// `checklist` copy, so a saved report never changes (visitChecklist).
//
// Score = Yes ÷ (Yes + No). N/A items are left out. The printed sheet says
// "÷ 21", but it actually has 32 items and an N/A column, so dividing by the
// items that applied is the only way N/A can work.

export const SALON_CHECK_SECTIONS = [
  {
    id: 'outside', title: 'Outside / Front Entrance', items: [
      { id: 'out-windows', label: 'Windows and doors clean' },
      { id: 'out-sidewalk', label: 'Sidewalk and entrance free of trash' },
      { id: 'out-signage', label: 'Signage and business hours visible' },
      { id: 'out-mats', label: 'Entry mats clean and in good condition' },
    ],
  },
  {
    id: 'reception', title: 'Reception / Front Desk', items: [
      { id: 'rec-desk', label: 'Front desk clean and organized' },
      { id: 'rec-retail', label: 'Retail products stocked, priced and dust-free' },
      { id: 'rec-promos', label: 'Promotions and signage current' },
      { id: 'rec-greet', label: 'Guests greeted promptly and professionally' },
    ],
  },
  {
    id: 'floor', title: 'Salon Floor', items: [
      { id: 'floor-stations', label: 'Styling stations clean and organized' },
      { id: 'floor-mirrors', label: 'Mirrors and chairs clean' },
      { id: 'floor-swept', label: 'Floor clean, swept and hair removed from edges' },
      { id: 'floor-tools', label: 'Tools sanitized and properly stored' },
      { id: 'floor-dress', label: 'Stylists following dress and appearance standards' },
    ],
  },
  {
    id: 'shampoo', title: 'Shampoo Area', items: [
      { id: 'sham-bowls', label: 'Bowls and chairs clean' },
      { id: 'sham-towels', label: 'Towels and supplies stocked' },
      { id: 'sham-leaks', label: 'No leaks and hair traps clean' },
      { id: 'sham-trash', label: 'Trash emptied and floor clean' },
      { id: 'sham-products', label: 'Shampoo and products organized' },
    ],
  },
  {
    id: 'back', title: 'Back Room / Break Area', items: [
      { id: 'back-laundry', label: 'Laundry clean and organized' },
      { id: 'back-supplies', label: 'Supplies properly stored' },
      { id: 'back-break', label: 'Break area clean' },
      { id: 'back-goalboard', label: 'Goal Board updated' },
      { id: 'back-trash', label: 'Trash emptied' },
    ],
  },
  {
    id: 'restroom', title: 'Restroom', items: [
      { id: 'rest-clean', label: 'Toilet, sink and mirror clean' },
      { id: 'rest-stocked', label: 'Soap, paper towels and toilet paper stocked' },
      { id: 'rest-trash', label: 'Trash emptied' },
      { id: 'rest-floor', label: 'Floor clean, swept and hair removed from edges' },
    ],
  },
  {
    id: 'ops', title: 'Operations / Team', items: [
      { id: 'ops-schedules', label: 'Schedules and staffing reviewed' },
      { id: 'ops-licenses', label: 'Licenses organized and current' },
      { id: 'ops-sanitation', label: 'Sanitation and safety standards followed' },
      { id: 'ops-goals', label: 'Sales, retail and service goals reviewed' },
      { id: 'ops-coaching', label: 'Team coaching opportunities identified' },
    ],
  },
];

export const SALON_CHECK_ANSWERS = ['yes', 'no', 'na'];

export const checklistItems = sections => sections.flatMap(s => s.items);

// The questions in use today: the base list, plus added ones at the end of
// their section, minus deleted ones. Empty sections stay, so leadership can
// still add to them.
export function activeChecklist(config) {
  const removed = new Set(config?.removed || []);
  const added = config?.added || [];
  return SALON_CHECK_SECTIONS.map(s => ({
    id: s.id,
    title: s.title,
    items: [...s.items, ...added.filter(q => q.sectionId === s.id).map(({ id, label }) => ({ id, label }))].filter(i => !removed.has(i.id)),
  }));
}

// The questions a saved visit was filled out with.
export function visitChecklist(visit) {
  return Array.isArray(visit?.checklist) ? visit.checklist : SALON_CHECK_SECTIONS;
}

// { yes, no, na, answered, total, score } — score is 0–1, or null when
// nothing counted (every item N/A or unanswered).
export function scoreSalonCheck(answers, sections = SALON_CHECK_SECTIONS) {
  const items = checklistItems(sections);
  let yes = 0; let no = 0; let na = 0;
  items.forEach(i => {
    const a = answers?.[i.id];
    if (a === 'yes') yes++;
    else if (a === 'no') no++;
    else if (a === 'na') na++;
  });
  const counted = yes + no;
  return { yes, no, na, answered: yes + no + na, total: items.length, score: counted ? yes / counted : null };
}

// Flattens { [storeCode]: { [visitId]: visit } } into a list, newest first.
export function salonCheckList(salonChecks) {
  return Object.entries(salonChecks || {})
    .flatMap(([code, visits]) => Object.values(visits || {}).filter(Boolean).map(v => ({ ...v, code })))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.savedAt || '').localeCompare(a.savedAt || ''));
}
