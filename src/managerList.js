// "Make managers from a list" (Setup → Employee Access, 2026-11-16).
// The owner uploads a Manager | Store | Phone sheet (e.g.
// Manager_Contact_List.xlsx). Each row is matched to an existing login in
// Employee Access, and a preview shows what would change before anything is
// saved. The user's rule: anyone already a District Leader (or the owner) is
// NEVER switched to Manager, even if they're on the list. They're skipped.
//
// Matching: full name first (dots, extra spaces, and "(Nickname)" ignored),
// then first + last name, then phone. A name that fits more than one login is
// settled by phone if possible, otherwise left for the owner to fix by hand.
// Someone listed at two stores (one manager over two salons) gets both codes.

import { getCodeForStoreName } from './storeDirectory';

const KEEP_ROLES = new Set(['owner', 'district_leader']);

const cleanName = raw => String(raw || '')
  .replace(/\([^)]*\)/g, ' ') // "Thimothea Reimel (Thea)" → "Thimothea Reimel"
  .replace(/[.,]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const firstLast = raw => {
  const parts = cleanName(raw).split(' ').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : parts.join(' ');
};
const digits = raw => String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// Grid (array of rows) → [{ name, phone, stores: [{ name, code }] }].
// Header row is found by a "Manager"/"Name" column and a "Store" column.
export function parseManagerListGrid(grid) {
  const errors = [];
  const headerIdx = grid.findIndex(r => (r || []).some(c => /^(manager|name|manager name|employee name)$/i.test(String(c || '').trim())) && (r || []).some(c => /^store/i.test(String(c || '').trim())));
  if (headerIdx < 0) throw new Error('Couldn\'t find the header row. The sheet needs a "Manager" (or "Name") column and a "Store" column.');
  const header = grid[headerIdx].map(c => String(c || '').trim().toLowerCase());
  const nameCol = header.findIndex(h => /^(manager|name|manager name|employee name)$/.test(h));
  const storeCol = header.findIndex(h => /^store/.test(h));
  const phoneCol = header.findIndex(h => /phone/.test(h));
  const byPerson = new Map();
  grid.slice(headerIdx + 1).forEach((r, i) => {
    const name = String((r || [])[nameCol] || '').replace(/\s+/g, ' ').trim();
    const storeName = String((r || [])[storeCol] || '').trim();
    if (!name && !storeName) return;
    const line = headerIdx + i + 2;
    if (!name) { errors.push(`Row ${line}: no name (store ${storeName}).`); return; }
    const code = getCodeForStoreName(storeName);
    if (!code) { errors.push(`Row ${line}: ${name} — store "${storeName}" isn't a known store.`); return; }
    const phone = phoneCol >= 0 ? digits((r || [])[phoneCol]) : '';
    const key = `${cleanName(name)}|${phone}`;
    const entry = byPerson.get(key) || { name, phone, stores: [] };
    if (!entry.stores.some(s => s.code === code)) entry.stores.push({ name: storeName, code });
    byPerson.set(key, entry);
  });
  return { people: Array.from(byPerson.values()), errors };
}

// people (from parseManagerListGrid) + employees (rosterList) →
// [{ person, status, employee?, note }]. status:
//   'promote'  → becomes Manager with these stores
//   'update'   → already a Manager, store codes change
//   'same'     → already a Manager at exactly these stores
//   'keep'     → DL or owner: left alone on purpose
//   'inactive' → matched, but has no access (not changed)
//   'unclear'  → more than one possible login
//   'missing'  → no login found
export function planManagerPromotions(people, employees) {
  const list = employees || [];
  const byFull = new Map(); const byFL = new Map(); const byPhone = new Map();
  const add = (m, k, e) => { if (!k) return; const a = m.get(k) || []; if (!a.includes(e)) a.push(e); m.set(k, a); };
  list.forEach(e => { add(byFull, cleanName(e.name), e); add(byFL, firstLast(e.name), e); add(byPhone, digits(e.phone), e); });

  return people.map(person => {
    const codes = person.stores.map(s => s.code);
    let found = byFull.get(cleanName(person.name)) || byFL.get(firstLast(person.name)) || [];
    let how = 'name';
    if (found.length > 1 && person.phone) {
      const byP = found.filter(e => digits(e.phone) === person.phone);
      if (byP.length >= 1) found = byP;
    }
    // Prefer active logins when a name has an old inactive duplicate.
    if (found.length > 1) { const act = found.filter(e => e.active !== false); if (act.length) found = act; }
    if (!found.length && person.phone) { found = byPhone.get(person.phone) || []; how = 'phone'; }
    // A DL anywhere among the candidates wins: never risk changing a DL.
    const dl = found.find(e => KEEP_ROLES.has(e.role));
    if (dl) return { person, codes, employee: dl, status: 'keep', how, note: `Already ${dl.role === 'owner' ? 'the owner' : 'a District Leader'}, left as is.` };
    if (!found.length) return { person, codes, status: 'missing', note: 'No login in Employee Access with this name or phone.' };
    if (found.length > 1) return { person, codes, status: 'unclear', candidates: found, note: `${found.length} logins could be this person: ${found.map(e => `${e.name} (${e.employeeCode})`).join(', ')}. Set it by hand below.` };
    const employee = found[0];
    const matchNote = how === 'phone' ? ` Matched by phone to "${employee.name}", check it's the same person.` : '';
    if (employee.active === false) return { person, codes, employee, status: 'inactive', how, note: `Matched ${employee.name}, but they have no access right now (not changed).${matchNote}` };
    const current = (employee.storeCodes || []).map(String).sort().join(',');
    const target = [...codes].sort().join(',');
    if (employee.role === 'manager') {
      if (current === target) return { person, codes, employee, status: 'same', how, note: `Already Manager here.${matchNote}` };
      return { person, codes, employee, status: 'update', how, note: `Already Manager; stores change from ${(employee.storeCodes || []).join(', ') || 'none'}.${matchNote}` };
    }
    return { person, codes, employee, status: 'promote', how, note: `${employee.role === 'employee' ? 'Employee' : employee.role} → Manager.${matchNote}` };
  });
}

export const PLAN_STATUS_LABELS = {
  promote: 'Will become Manager',
  update: 'Store change',
  same: 'Already set',
  keep: 'Kept as DL',
  inactive: 'No access, skipped',
  unclear: 'More than one match',
  missing: 'Not found',
};
