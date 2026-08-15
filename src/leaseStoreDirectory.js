// Store directory used only by the Leases tab's bulk-upload matcher and its
// store grid. STORE_CODE_TO_NAME (storeDirectory.js) is the active
// sales/roster list — the Leases tab tracks real estate, which includes
// closed/inactive locations and not-yet-opened ones (e.g. Dilworthtown,
// under a new lease as of 2026) that never show up in sales data at all.
// Extracted from the real LeaseCake folder/file export the owner provided
// (73 store folders) by diffing against STORE_CODE_TO_NAME's ~62 entries.
import { STORE_CODE_TO_NAME } from './storeDirectory';

export const LEASE_EXTRA_STORES = {
  '81716': 'Bel Air',
  '83277': 'Camp Hill',
  '81696': 'Dilworthtown',
  '80720': 'Harleysville',
  '82817': 'Kennett Square',
  '82239': 'Lancaster',
  '80540': 'Lawrenceville',
  '89080': 'Parkesburg',
  '81849': 'Timonium',
  '81205': 'Trooper',
  '80109': 'Whitemarsh',
};

// Closed/never-opened locations — shown de-emphasized in the store grid
// rather than left indistinguishable from an active salon.
export const LEASE_INACTIVE_CODES = new Set(['81716', '83277', '82239', '80540', '81849', '81205', '80109']);

export const LEASE_STORE_CODE_TO_NAME = { ...STORE_CODE_TO_NAME, ...LEASE_EXTRA_STORES };

export function leaseStoreName(code) {
  return LEASE_STORE_CODE_TO_NAME[code] || `Store ${code}`;
}

// Every code's own digit-length, longest first, so a 5-digit code is tried
// before any 4-digit code it might contain a substring of.
const KNOWN_CODES = Object.keys(LEASE_STORE_CODE_TO_NAME).sort((a, b) => b.length - a.length);
const KNOWN_CODE_SET = new Set(KNOWN_CODES);

// Scans a file's name or full relative path for a known store code. Every
// real Leasecake export format embeds the numeric store code somewhere in
// the name — the flat "Leasecake Export -- <Store> -- <file>" pattern, the
// "Lease Abstracts" export's "<slug>-<code>-<start>-<end>.pdf" pattern, and
// a plain per-store folder name like "Avondale - 80793" — so matching on
// "a run of digits that happens to be a known code" covers all of them
// without hardcoding any one format.
export function matchStoreCodeFromPath(path) {
  const digitRuns = String(path).match(/\d{4,6}/g) || [];
  for (const run of digitRuns) {
    if (KNOWN_CODE_SET.has(run)) return run;
    // A run can pick up one extra digit from an adjacent, unrelated number
    // (rare, but cheap to guard) — try trimming a digit off either end.
    if (run.length > 4) {
      if (KNOWN_CODE_SET.has(run.slice(1))) return run.slice(1);
      if (KNOWN_CODE_SET.has(run.slice(0, -1))) return run.slice(0, -1);
    }
  }
  return null;
}

// Pulls a lease term (start, end) out of filenames shaped like Leasecake's
// "Lease Abstracts" export: "<slug>-<code>-<start>-<end>.pdf". Returns null
// unless exactly a start-before-end pair of ISO dates is found — a
// degenerate same-day range (seen in the real export, e.g. an LOI dated
// once on each side) is deliberately not treated as a lease term.
export function extractTermDatesFromFilename(name) {
  const dates = String(name).match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates || dates.length < 2) return null;
  const termStart = dates[0];
  const termEnd = dates[dates.length - 1];
  if (!(termStart < termEnd)) return null;
  return { termStart, termEnd };
}
