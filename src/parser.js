import * as XLSX from 'xlsx';
import { getCodeForStoreName, canonicalizeStoreCode } from './storeDirectory';

export function sheetToGrid(ws) {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) { row.push({ v: '', w: '' }); continue; }
      const v = cell.v !== undefined ? cell.v : '';
      const w = cell.w !== undefined ? String(cell.w) : String(v);
      row.push({ v, w });
    }
    grid.push(row);
  }
  return grid;
}

function cellText(cell) { return String(cell?.w ?? '').trim(); }
function rowHasData(row) { return row.some(c => cellText(c) !== ''); }
function numOf(cell) {
  const v = cell?.v;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}
function findCol(headerRow, label) {
  const target = label.trim().toLowerCase();
  for (let c = 0; c < headerRow.length; c++) {
    if (cellText(headerRow[c]).toLowerCase() === target) return c;
  }
  return -1;
}
function cleanStoreName(raw) {
  return String(raw).replace(/^\s*\d+\s*-?\s*/, '').trim() || String(raw).trim();
}
export function normalizeName(raw) {
  return String(raw).replace(/\s+/g, ' ').trim().toLowerCase();
}
function readWorkbookGrid(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const g = sheetToGrid(ws);
        if (!g.length) { reject(new Error('No data found in file.')); return; }
        resolve(g);
      } catch (err) {
        reject(new Error('Could not read this file. Make sure it is a valid Excel export.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

// Reads several specific named sheets out of one workbook in a single pass —
// unlike readWorkbookGrid above, which only ever looks at the first sheet.
// Needed for the Master Salon List import, which combines data spread
// across three different tabs of one big multi-tab company workbook.
function readWorkbookSheetsByName(file, sheetNames) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const grids = {};
        for (const name of sheetNames) {
          const ws = wb.Sheets[name];
          if (!ws) { reject(new Error(`Could not find a sheet named "${name}" in this file.`)); return; }
          grids[name] = sheetToGrid(ws);
        }
        resolve(grids);
      } catch (err) {
        reject(new Error('Could not read this file. Make sure it is a valid Excel export.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

// Weighted (not naively summed) rollup for a group of employee rows. Exported
// so api/scoped-data.js can recompute companyTotals after filtering a
// stylist_report down to one role's allowed stores (same math the original
// company-wide total already used, just over a smaller employee list).
export function rollup(employees) {
  const sum = key => employees.reduce((s, e) => s + (e[key] || 0), 0);
  // "Sales" = total revenue (service + retail combined) — each employee's
  // own `sales` already includes their retail (see parseStylistReportFromGrid
  // below), so summing it here is enough; no separate retail add needed.
  const totalSales = sum('sales');
  const totalHours = sum('totalHours');
  const totalColor = sum('colorSales');
  const totalRetail = sum('retail');
  const totalHaircuts = sum('haircuts');
  // "Other Services" — beard trims, waxes, shampoos, and anything else that
  // isn't Color, isn't Signature Service, and isn't a haircut itself. The
  // live Stylist Report already carries this per-employee as "$Emp Other
  // Net" (see col.otherNet / employee.otherServices below); OPC (Other
  // [services] per Customer) mirrors CPC/RPC exactly, using the same
  // haircuts-as-customer-count convention those already use.
  const totalOther = sum('otherServices');
  return {
    sales: Math.round(totalSales * 100) / 100,
    // Raw service-only total, backed out of the combined `sales` above —
    // buildWeeklyRecord needs this (not the combined figure) so the
    // permanent weekly-history snapshot keeps service/retail as separate
    // raw fields, the same shape Sales-Accrual history already uses.
    // Combining only ever happens once, downstream, in
    // historyTotalsToReportShape — never bake it into stored history, or a
    // week sourced from a live report would double-count its own retail
    // the next time that history is read back.
    serviceSales: Math.round((totalSales - totalRetail) * 100) / 100,
    totalHours: Math.round(totalHours * 100) / 100,
    colorSales: Math.round(totalColor * 100) / 100,
    retail: Math.round(totalRetail * 100) / 100,
    otherServices: Math.round(totalOther * 100) / 100,
    haircuts: totalHaircuts,
    tsth: totalHours > 0 ? totalSales / totalHours : null,
    cpc: totalHaircuts > 0 ? totalColor / totalHaircuts : null,
    rpc: totalHaircuts > 0 ? totalRetail / totalHaircuts : null,
    opc: totalHaircuts > 0 ? totalOther / totalHaircuts : null,
    // "Average Ticket" — the average amount a customer spends per visit.
    // Same customer-count convention as CPC/RPC/OPC (haircuts stands in for
    // a visit/ticket — there's no separate per-transaction ID in either
    // source export to count real tickets against).
    avgTicket: totalHaircuts > 0 ? totalSales / totalHaircuts : null,
    cph: totalHours > 0 ? totalHaircuts / totalHours : null,
  };
}

// ─── Stylist report ─────────────────────────────────────────────────────────
// One sheet: a "store header" row (Location Name filled, employee name
// blank) followed by that store's employee rows (Location Name blank,
// employee name filled), repeating for every store. Ends in the file's own
// "Grand Total" row, which we skip since it has no name at all.
export async function parseStylistReport(file) {
  const grid = await readWorkbookGrid(file);
  return parseStylistReportFromGrid(grid, file.name);
}

// Grid-in, no-File-object-required variant — shared with the server-side
// email ingestion path (api/email-report.js), which has no FileReader/File
// and builds a grid straight from a Buffer instead.
export function parseStylistReportFromGrid(grid, fileName) {
  const header = grid[0];
  const col = {
    startDate: findCol(header, 'Report Start Date'),
    endDate: findCol(header, 'Report End Date'),
    location: findCol(header, 'Location Name'),
    firstName: findCol(header, 'Employee First Name'),
    lastName: findCol(header, 'Employee Last Name'),
    sales: findCol(header, '$EE Net no svs'),
    tsth: findCol(header, '$EE TSTH no svs'),
    haircuts: findCol(header, 'Hair Cut Count'),
    colorNet: findCol(header, '$Color Net'),
    cpc: findCol(header, 'CPC'),
    otherNet: findCol(header, '$Emp Other Net'),
    opc: findCol(header, 'OPC'),
    productNet: findCol(header, '$Product Net'),
    rpc: findCol(header, 'RPC'),
    daysWorked: findCol(header, 'Days Worked'),
    totalHours: findCol(header, 'Total Hours'),
    prodHours: findCol(header, 'Production Hours'),
    nonProdHours: findCol(header, 'Non-Production Hours'),
  };
  if (col.location === -1 || col.firstName === -1 || col.sales === -1) {
    throw new Error('Could not find the expected columns (Location Name, Employee First Name, $EE Net no svs) in this file.');
  }

  let dateRangeLabel = null;
  let startDateISO = null;
  let endDateISO = null;
  const stores = [];
  let current = null;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;

    // The file's own summary row can put "Grand Total" in any column
    // depending on the export — scan the whole row so it's never mistaken
    // for a store or an employee, no matter where the label lands.
    if (row.some(c => /grand\s*total/i.test(cellText(c)))) continue;

    const locationRaw = cellText(row[col.location]);
    const first = cellText(row[col.firstName]);
    const last = cellText(row[col.lastName]);

    if (locationRaw && !first && !last) {
      // Store header row — starts a new store section.
      const codeMatch = locationRaw.match(/^\s*(\d+)/);
      current = { name: cleanStoreName(locationRaw), code: codeMatch ? String(parseInt(codeMatch[1], 10)) : null, employees: [] };
      stores.push(current);
      if (!dateRangeLabel) {
        const start = cellText(row[col.startDate]);
        const end = cellText(row[col.endDate]);
        if (start && end) {
          dateRangeLabel = `${start} – ${end}`;
          startDateISO = toISODate(start);
          endDateISO = toISODate(end);
        }
      }
      continue;
    }

    if (!current) continue; // stray row before any store header
    if (!first && !last) continue; // blank/summary row (e.g. the file's own Grand Total)

    const empHaircuts = numOf(row[col.haircuts]);
    const empHours = numOf(row[col.totalHours]);
    const empServiceSales = numOf(row[col.sales]);
    const empRetail = numOf(row[col.productNet]);
    const empSales = empServiceSales + empRetail;
    current.employees.push({
      name: `${first} ${last}`.trim(),
      // "Sales" = total revenue (service + retail), matching the same
      // definition used everywhere else in the app (see rollup() above and
      // historyTotalsToReportShape in metrics.js).
      sales: empSales,
      colorSales: numOf(row[col.colorNet]),
      retail: empRetail,
      cpc: numOf(row[col.cpc]),
      rpc: numOf(row[col.rpc]),
      tsth: numOf(row[col.tsth]),
      haircuts: empHaircuts,
      totalHours: empHours,
      // No CPH column in the source export — unlike CPC/RPC/TSTH, this one's
      // ours to compute, so it only appears when both figures are actually present.
      cph: empHours > 0 ? empHaircuts / empHours : null,
      // Same story for Average Ticket — no column for it, computed from the
      // same Sales/haircuts this row already carries.
      avgTicket: empHaircuts > 0 ? empSales / empHaircuts : null,
      prodHours: numOf(row[col.prodHours]),
      nonProdHours: numOf(row[col.nonProdHours]),
      daysWorked: numOf(row[col.daysWorked]),
      // "$Emp Other Net" / "OPC" — other services (beard trims, waxes,
      // shampoos, anything not Color/Signature Service/the haircut itself)
      // already broken out by the source export at the per-employee level.
      otherServices: numOf(row[col.otherNet]),
      opc: numOf(row[col.opc]),
    });
  }

  if (!stores.length) throw new Error('No store sections found in this file.');

  stores.forEach(s => { s.totals = rollup(s.employees); });

  const allEmployees = [];
  stores.forEach(s => s.employees.forEach(e => allEmployees.push({ ...e, store: s.name })));

  const companyTotals = rollup(allEmployees);

  return {
    dateRangeLabel,
    startDateISO,
    endDateISO,
    stores,
    allEmployees,
    companyTotals,
    storeCount: stores.length,
    employeeCount: allEmployees.length,
    fileName,
  };
}

// ─── Employee start-date roster ─────────────────────────────────────────────
// A simple two-column list: Employee Name | Employee start date (as text,
// e.g. "1/16/2026"). Company-wide — includes everyone ever entered in the
// system, not just people currently on a store's schedule.
function parseUSDate(text) {
  const m = String(text).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, da, yr] = m;
  if (yr.length === 2) yr = '20' + yr;
  const d = new Date(Number(yr), Number(mo) - 1, Number(da));
  return isNaN(d.getTime()) ? null : d;
}
function parseDateCell(cell) {
  const raw = cell?.v;
  if (typeof raw === 'number') {
    // Excel serial date (days since 1899-12-30)
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + raw * 86400000);
  }
  return parseUSDate(cellText(cell));
}

export async function parseEmployeeStartDates(file) {
  const grid = await readWorkbookGrid(file);
  return parseEmployeeStartDatesFromGrid(grid, file.name);
}

export function parseEmployeeStartDatesFromGrid(grid, fileName) {
  const hdrRowIdx = grid.findIndex(row => row.some(c => cellText(c).toLowerCase() === 'employee name'));
  if (hdrRowIdx === -1) throw new Error('Could not find an "Employee Name" column in this file.');
  const headerRow = grid[hdrRowIdx];
  const nameCol = findCol(headerRow, 'Employee Name');
  const dateCol = findCol(headerRow, 'Employee start date');
  if (dateCol === -1) throw new Error('Could not find an "Employee start date" column in this file.');

  const seen = new Set();
  const employees = [];
  for (let r = hdrRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const name = cellText(row[nameCol]);
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue; // this file has repeated rows for the same person
    const startDate = parseDateCell(row[dateCol]);
    if (!startDate) continue;
    seen.add(key);
    employees.push({ name, startDate: startDate.toISOString() });
  }

  if (!employees.length) throw new Error('No employees with a valid start date were found in this file.');

  return { employees, fileName };
}

// ─── HSA class schedule (Date | Event | location | Time) ──────────────────
// One shared calendar upload covering every class/training type (HSA, HSA
// Cert, Manager Training, Fade Class, etc.) — App.js tags each row
// `source: 'hsa'` and merges it straight into the Homepage events calendar
// rather than keeping a separate list, so these show up on the same
// calendar hand-authored events already use.
function slugify(text) {
  return String(text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function dateCellToISO(cell) {
  const raw = cell?.v;
  if (typeof raw === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(epoch.getTime() + raw * 86400000).toISOString().slice(0, 10);
  }
  const m = cellText(cell).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, da, yr] = m;
  if (yr.length === 2) yr = '20' + yr;
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
}

export async function parseHsaScheduleFile(file) {
  const grid = await readWorkbookGrid(file);
  return parseHsaScheduleFromGrid(grid, file.name);
}

export function parseHsaScheduleFromGrid(grid, fileName) {
  const hdrRowIdx = grid.findIndex(row => row.some(c => cellText(c).toLowerCase().startsWith('date')));
  if (hdrRowIdx === -1) throw new Error('Could not find a "Date" column in this file.');
  const headerRow = grid[hdrRowIdx];
  const findAny = labels => {
    for (const label of labels) {
      const idx = findCol(headerRow, label);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const dateCol = findAny(['date:', 'date']);
  const eventCol = findAny(['event']);
  const locationCol = findAny(['location']);
  const timeCol = findAny(['time:', 'time']);
  if (dateCol === -1) throw new Error('Could not find a "Date" column in this file.');
  if (eventCol === -1) throw new Error('Could not find an "Event" column in this file.');

  const classes = [];
  for (let r = hdrRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const iso = dateCellToISO(row[dateCol]);
    const event = cellText(row[eventCol]);
    if (!iso || !event) continue;
    const location = locationCol !== -1 ? cellText(row[locationCol]) : '';
    const time = timeCol !== -1 ? cellText(row[timeCol]) : '';
    // Deterministic id from content (not random/incrementing) so re-uploading
    // the same schedule keeps the same class ids — sign-ups reference a
    // class by id, so a random id here would orphan every existing signup
    // on the very next re-upload.
    const id = `hsa-${iso}-${slugify(event)}-${slugify(location)}-${slugify(time)}`;
    classes.push({ id, date: iso, event, location, time });
  }
  if (!classes.length) throw new Error('No class rows with a valid date and event were found in this file.');
  return { classes, fileName };
}

// ─── Goal file (DL | Salon | Goal amount) ──────────────────────────────────
// Read by column position rather than header text, since the goal column's
// header changes every time (e.g. "July 26 Goal") — always DL, Store, Goal.
export async function parseGoalFile(file) {
  const grid = await readWorkbookGrid(file);
  if (grid.length < 2) throw new Error('This file does not have any goal rows in it.');

  const periodLabel = cellText(grid[0][2]) || 'Goal';
  const entries = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const storeName = cellText(row[1]);
    if (!storeName) continue;
    const amount = numOf(row[2]);
    entries.push({ storeName, amount });
  }
  if (!entries.length) throw new Error('No store goal rows found in this file.');

  return { entries, periodLabel, fileName: file.name };
}

// ─── DL Color Goals file (DL | Salon | same-month-last-year Color $ |
// current-month Color $ (ignored — the app already tracks this itself from
// real uploads) | new Color $ goal | current Retail/Color attach % |
// new attach % goal) ─────────────────────────────────────────────────────
// "Attach %" = color tickets that also carry a retail item. As of the
// Invoice No column being added to the Sales-Accrual export (see
// parseSalesAccrualFile below), the ACTUAL side of this can now be computed
// for real from a historical import — the StoreMetricTab UI always prefers
// that real figure when it's available for the period being viewed. This
// file's "current attach %" column still gets imported as a fallback for
// whenever it isn't (older Sales-Accrual data from before Invoice No
// existed, or the live current-period weekly Stylist Report, which has no
// per-ticket detail at all) — and its goal column is still the ONLY source
// for the goal side either way, since there's nothing to compute a goal
// from. Read by column position (col 1 Salon, 2 last-year Color $, 4 new
// Color $ goal, 5 current attach %, 6 new attach % goal) since the header
// text is a month label that changes every time this file is regenerated.
export async function parseColorAttachGoalsFile(file) {
  const grid = await readWorkbookGrid(file);
  if (grid.length < 2) throw new Error('This file does not have any store rows in it.');

  // The source sheet is inconsistent about how it stores a percent: a couple
  // of cells are real percent-formatted fractions (0.05 meaning 5%), most
  // are plain whole numbers meant as percentage points (13 meaning 13%, not
  // 1300%). >=1 (not >1) is the right cutoff — one real store in this file
  // has a raw value of exactly 1, clearly meant as "1%" like its neighboring
  // stores' 0/3/4% rows, not a literal 100% attach rate; nothing in this
  // file's actual percent-formatted cells goes anywhere near 100% (0.75 is
  // the highest), so >=1 can only ever catch a percentage-point cell.
  const normalizePct = cell => {
    if (cellText(cell) === '') return null;
    const n = numOf(cell);
    return n >= 1 ? n / 100 : n;
  };
  const numOrNull = cell => (cellText(cell) === '' ? null : numOf(cell));

  const entries = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const storeName = cellText(row[1]);
    if (!storeName) continue;
    entries.push({
      storeName,
      colorLastYear: numOrNull(row[2]),
      colorGoal: numOrNull(row[4]),
      retailAttach: normalizePct(row[5]),
      retailAttachGoal: normalizePct(row[6]),
    });
  }
  if (!entries.length) throw new Error('No store rows found in this file.');

  return { entries, fileName: file.name };
}

// Blank template for the above — same DL | Store | Goal column layout (DL is
// ignored on import, kept here only so the person filling it in can see
// which stores are theirs), with the Goal column left empty. Works for any
// of the four goal types, since parseGoalFile never looks at the header
// text — filling it in and using any "Import ... Goals from file" button
// round-trips straight back through the same parser.
export function downloadGoalTemplate(rows) {
  const aoa = [['DL', 'Store', 'Goal'], ...rows.map(r => [r.leaderName, r.storeName, null])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Goals');
  XLSX.writeFile(wb, 'goal-sheet-template.xlsx');
}

// ─── Manager roster (STORE | Manager) ──────────────────────────────────────
// A simple two-column list — store name, manager name ("Open" for a vacant
// position, kept as-is rather than treated as empty since it's meaningful).
// Read by header text (case-insensitive) since column order isn't guaranteed.
export async function parseManagerFile(file) {
  const grid = await readWorkbookGrid(file);
  if (grid.length < 2) throw new Error('This file does not have any manager rows in it.');

  const header = grid[0];
  const storeCol = findCol(header, 'Store');
  const managerCol = findCol(header, 'Manager');
  if (storeCol === -1 || managerCol === -1) {
    throw new Error('Could not find the expected columns ("Store", "Manager") in this file.');
  }

  const entries = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const storeName = cellText(row[storeCol]);
    if (!storeName) continue;
    const managerName = cellText(row[managerCol]).replace(/\s+/g, ' ').trim();
    entries.push({ storeName, managerName });
  }
  if (!entries.length) throw new Error('No manager rows found in this file.');

  return { entries, fileName: file.name };
}

// ─── Milestone goals (Salon | Goal | Milestone) ────────────────────────────
// Goal = the number a store HAS to hit; Milestone = a stretch target above
// it. Updated monthly. Headers are stable (unlike the DL/Salon/Goal file
// above, whose goal column header changes every month), so read by header
// text instead of position.
export async function parseMilestoneGoalFile(file) {
  const grid = await readWorkbookGrid(file);
  if (grid.length < 2) throw new Error('This file does not have any milestone goal rows in it.');

  const header = grid[0];
  const storeCol = findCol(header, 'Salon');
  const goalCol = findCol(header, 'Goal');
  const milestoneCol = findCol(header, 'Milestone');
  if (storeCol === -1 || goalCol === -1 || milestoneCol === -1) {
    throw new Error('Could not find the expected columns ("Salon", "Goal", "Milestone") in this file.');
  }

  const entries = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const storeName = cellText(row[storeCol]);
    if (!storeName) continue;
    entries.push({ storeName, goal: numOf(row[goalCol]), milestone: numOf(row[milestoneCol]) });
  }
  if (!entries.length) throw new Error('No milestone goal rows found in this file.');

  return { entries, fileName: file.name };
}

// ─── Reviews export (CSV) ───────────────────────────────────────────────────
// A Google-reviews style export. The "location" column is a verbose listing
// name that doesn't match our store naming — "location short name" is the
// store CODE, which is what we actually match on (same pattern as goals).
export async function parseReviews(file) {
  const grid = await readWorkbookGrid(file); // XLSX.read auto-detects CSV too
  return parseReviewsFromGrid(grid, file.name);
}

export function parseReviewsFromGrid(grid, fileName) {
  const header = grid[0];
  const col = {
    location: findCol(header, 'location'),
    code: findCol(header, 'location short name'),
    postedAt: findCol(header, 'posted at'),
    userName: findCol(header, 'user name'),
    rating: findCol(header, 'rating'),
    message: findCol(header, 'message'),
    reply: findCol(header, 'reply'),
    url: findCol(header, 'review url'),
  };
  if (col.code === -1 || col.rating === -1) {
    throw new Error('Could not find the expected columns ("location short name", "rating") in this file.');
  }

  const reviews = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const code = canonicalizeStoreCode(cellText(row[col.code]));
    if (!code) continue;
    reviews.push({
      code,
      rawLocation: col.location !== -1 ? cellText(row[col.location]) : '',
      postedAt: col.postedAt !== -1 ? cellText(row[col.postedAt]) : '',
      userName: col.userName !== -1 ? cellText(row[col.userName]) : '',
      rating: numOf(row[col.rating]),
      message: col.message !== -1 ? cellText(row[col.message]) : '',
      reply: col.reply !== -1 ? cellText(row[col.reply]) : '',
      url: col.url !== -1 ? cellText(row[col.url]) : '',
    });
  }
  if (!reviews.length) throw new Error('No review rows found in this file.');

  return { reviews, fileName };
}

// ─── Employee access roster (login system) ─────────────────────────────────
// Admin-maintained list that drives who can sign up/log in and what they can
// see: Employee Name | Employee Code | Phone Number | Role | Store Codes.
// Role is Owner / District Leader / Manager / Employee (case-insensitive,
// "DL" also accepted for District Leader). Store Codes only matters for
// District Leader (multiple codes, separated by commas/semicolons/spaces)
// and Manager (one code) — blank for Owner/Employee. Every upload is treated
// as the full current roster by api/roster.js, not a diff.
function normalizeAccessRole(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'owner') return 'owner';
  if (t === 'district leader' || t === 'dl') return 'district_leader';
  if (t === 'manager') return 'manager';
  if (t === 'employee') return 'employee';
  return null;
}

export async function parseEmployeeAccessFile(file) {
  const grid = await readWorkbookGrid(file);
  return parseEmployeeAccessFromGrid(grid, file.name);
}

export function parseEmployeeAccessFromGrid(grid, fileName) {
  const header = grid[0];
  const col = {
    name: findCol(header, 'Employee Name'),
    code: findCol(header, 'Employee Code'),
    phone: findCol(header, 'Phone Number'),
    role: findCol(header, 'Role'),
    storeCodes: findCol(header, 'Store Codes'),
  };
  if (col.name === -1 || col.code === -1 || col.phone === -1 || col.role === -1) {
    throw new Error('Could not find the expected columns (Employee Name, Employee Code, Phone Number, Role) in this file.');
  }

  const employees = [];
  const errors = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const name = cellText(row[col.name]);
    const employeeCode = cellText(row[col.code]);
    const phone = cellText(row[col.phone]).replace(/\D/g, '');
    const role = normalizeAccessRole(cellText(row[col.role]));
    // Employee Code and Phone Number can be blank — that person still gets a
    // row (with a placeholder code, assigned server-side) so they show up in
    // Setup > Employee Access for the owner to fill in by hand once known,
    // rather than being silently dropped from the roster entirely.
    if (!name || !role) {
      errors.push(`Row ${r + 1}: missing or unrecognized data — need at least a name and a valid Role (Owner/District Leader/Manager/Employee).`);
      continue;
    }
    const storeCodes = col.storeCodes !== -1
      ? cellText(row[col.storeCodes]).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
      : [];
    employees.push({ name, employeeCode, phone, role, storeCodes, incomplete: !employeeCode || !phone });
  }
  if (!employees.length) throw new Error('No usable rows found in this file.');

  return { employees, errors, fileName };
}

// ─── Master Salon List import (the big internal multi-tab company workbook,
// as opposed to the purpose-built EmployeeAccessRoster.csv above) ──────────
// Combines three tabs of one workbook into the same {name, employeeCode,
// phone, role, storeCodes} shape parseEmployeeAccessFromGrid produces, so it
// feeds the exact same rosterUpload endpoint with no server-side changes:
//   - "Emplopyee List": every stylist, one row per person, with a real
//     numeric Emp ID and phone — becomes role 'employee'.
//   - "Exec Team, DL & Salons": has a "District Leaders" and an "Area
//     Supervisors" section, each a list of leader-groups (a named row with
//     that leader's own phone, followed by blank-name rows that are just
//     more store codes covered by the leader named above them) — becomes
//     role 'district_leader' (this app doesn't distinguish DL from Area
//     Supervisor, matching leaderRoster.js's existing convention).
//   - "DLs and Managers": same leader-group shape, but each store row also
//     names that store's Manager — becomes role 'manager'. A store whose
//     Manager is the DL/Area Supervisor themself (matched by email, since
//     names are sometimes spelled two different ways for the same person —
//     see the Christina Nole / Christine Noles case) is skipped, since that
//     store is already covered by the leader's own district_leader row.
// The Administrative Team and Education Team sections of the Exec sheet are
// deliberately never read — those people aren't stylists, DLs, or store
// managers, and were explicitly excluded from this import by the owner.
export const MASTER_LIST_SHEETS = ['Emplopyee List', 'Exec Team, DL & Salons', 'DLs and Managers'];

function normalizeEmail(raw) {
  return String(raw).trim().toLowerCase();
}

function parseMasterEmployeeListGrid(grid) {
  const hdrIdx = grid.findIndex(row => row.some(c => cellText(c).toLowerCase() === 'emp id'));
  if (hdrIdx === -1) throw new Error('Could not find the "Emp ID" column on the Employee List sheet.');
  const header = grid[hdrIdx];
  const col = {
    salon: findCol(header, 'Salon'),
    empId: findCol(header, 'Emp ID'),
    first: findCol(header, 'First Name'),
    last: findCol(header, 'Last Name'),
    phone: findCol(header, 'Phone'),
  };
  if (Object.values(col).some(c => c === -1)) {
    throw new Error('Could not find the expected columns (Salon, Emp ID, First Name, Last Name, Phone) on the Employee List sheet.');
  }

  const stylists = [];
  const skipped = [];
  for (let r = hdrIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const salon = cellText(row[col.salon]);
    const empId = cellText(row[col.empId]);
    const name = `${cellText(row[col.first])} ${cellText(row[col.last])}`.replace(/\s+/g, ' ').trim();
    const phone = cellText(row[col.phone]).replace(/\D/g, '');
    if (!salon || !empId || !name) continue;
    const storeCode = getCodeForStoreName(salon);
    if (!storeCode) {
      // Almost always a store from a different business sharing this same
      // workbook (e.g. "WTC ..." — Waxing the City stores), not a real gap.
      skipped.push(`${name} (Emp ID ${empId}): unrecognized salon "${salon}" — skipped.`);
      continue;
    }
    stylists.push({ name, employeeCode: empId, phone, salon, storeCode });
  }
  return { stylists, skipped };
}

// Shared shape for both the "District Leaders"/"Area Supervisors" section
// grouping on the Exec sheet and the leader-groups on the DLs and Managers
// sheet — a leader-summary row (name in col 0) followed by continuation rows
// (col 0 blank) that each carry one more store code under that leader.
function parseLeaderGroupsGrid(grid, sectionMarkers, { storeCodeCol, emailCol, phoneCol }) {
  const groups = [];
  let inSection = false;
  let current = null;
  for (const row of grid) {
    const c0 = cellText(row[0]);
    if (sectionMarkers.includes(c0)) { inSection = true; current = null; continue; }
    if (!inSection || !rowHasData(row)) continue;
    if (c0) {
      current = { name: c0, email: normalizeEmail(cellText(row[emailCol])), phone: cellText(row[phoneCol]).replace(/\D/g, ''), storeCodes: [] };
      groups.push(current);
    }
    const code = cellText(row[storeCodeCol]);
    if (current && code) current.storeCodes.push(code);
  }
  return groups;
}

function parseMasterManagersGrid(grid) {
  // Both "District Leader and Managers by Salons" and "Area Supervisors and
  // Managers by Salon" sections share this layout: col0=leader name (blank
  // on continuation/store rows), col1=store code, col2=location, col3=
  // manager name, col4=manager email, col5=manager phone. A leader-summary
  // row (col0 set) carries that leader's own email in col4 — captured so
  // store rows underneath it can tell a self-managed store apart from a
  // real separate manager.
  const SECTION_MARKERS = ['District Leader and Managers by Salons', 'Area Supervisors and Managers by Salon'];
  const HEADER_ROWS = ['District Leader', 'Area Supervisor'];
  const managers = new Map(); // key: manager email (or name fallback) -> { name, phone, storeCodes }
  let inSection = false;
  let currentLeaderEmail = null;
  for (const row of grid) {
    const c0 = cellText(row[0]);
    if (SECTION_MARKERS.includes(c0)) { inSection = true; currentLeaderEmail = null; continue; }
    if (HEADER_ROWS.includes(c0)) continue; // the column-header row itself, not a person
    if (!inSection || !rowHasData(row)) continue;
    if (c0) {
      currentLeaderEmail = normalizeEmail(cellText(row[4]));
      continue;
    }
    const storeCode = cellText(row[1]);
    const managerName = cellText(row[3]);
    const managerEmail = normalizeEmail(cellText(row[4]));
    const managerPhone = cellText(row[5]).replace(/\D/g, '');
    if (!storeCode || !managerName || managerName.toLowerCase() === 'open') continue;
    if (managerEmail && managerEmail === currentLeaderEmail) continue; // self-managed — the leader's own row already covers this store
    const key = managerEmail || `name:${normalizeName(managerName)}`;
    if (!managers.has(key)) managers.set(key, { name: managerName, phone: managerPhone, storeCodes: [] });
    const m = managers.get(key);
    if (!m.phone && managerPhone) m.phone = managerPhone;
    m.storeCodes.push(storeCode);
  }
  return managers;
}

export function parseMasterSalonListFromGrids(grids, fileName) {
  const { stylists, skipped } = parseMasterEmployeeListGrid(grids['Emplopyee List']);
  const leaders = parseLeaderGroupsGrid(grids['Exec Team, DL & Salons'], ['District Leaders', 'Area Supervisors'], { storeCodeCol: 1, emailCol: 3, phoneCol: 4 });
  const managers = parseMasterManagersGrid(grids['DLs and Managers']);

  const stylistByPhone = new Map();
  stylists.forEach(s => { if (s.phone && !stylistByPhone.has(s.phone)) stylistByPhone.set(s.phone, s); });

  const employees = stylists.map(s => ({ name: s.name, employeeCode: s.employeeCode, phone: s.phone, role: 'employee', storeCodes: [] }));

  const dedupe = codes => Array.from(new Set(codes));
  // Merge into an existing row for the same employeeCode rather than
  // replacing it outright — the source workbook sometimes lists the same
  // leader twice under slightly different names with only a partial store
  // list each (e.g. "Allie Clifford" and "Allie Clifford (under KI)"), and
  // overwriting would silently drop whichever store subset processed first.
  const overlay = (name, phone, role, storeCodes) => {
    const match = phone && stylistByPhone.get(phone);
    const employeeCode = match ? match.employeeCode : '';
    const idx = employeeCode ? employees.findIndex(e => e.employeeCode === employeeCode) : -1;
    // Keep the first-seen name on a merge — a duplicate listing like "Allie
    // Clifford (under KI)" is an annotation on the duplicate row, not a
    // better name than the original "Allie Clifford".
    const displayName = idx >= 0 ? employees[idx].name : name;
    const priorCodes = idx >= 0 ? employees[idx].storeCodes : [];
    const rec = { name: displayName, employeeCode, phone, role, storeCodes: dedupe([...priorCodes, ...storeCodes]) };
    if (idx >= 0) employees[idx] = rec; else employees.push(rec);
  };

  managers.forEach(m => overlay(m.name, m.phone, 'manager', m.storeCodes));
  leaders.forEach(l => overlay(l.name, l.phone, 'district_leader', l.storeCodes));

  if (!employees.length) throw new Error('No usable rows found in this file.');
  return { employees, errors: skipped, fileName };
}

export async function parseMasterSalonListFile(file) {
  const grids = await readWorkbookSheetsByName(file, MASTER_LIST_SHEETS);
  return parseMasterSalonListFromGrids(grids, file.name);
}

// ─── Historical import: Sales-Accrual & Attendance ─────────────────────────
// Both are line-item exports (one row per transaction, or per employee per
// day). We aggregate down to one record per store per day here, rather than
// keeping every raw row — that's what actually gets stored permanently.

function toISODate(text) {
  const m = String(text).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, da, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
}

function extractCode(centerText) {
  const m = String(centerText).match(/^\s*(\d+)/);
  return m ? String(parseInt(m[1], 10)) : null;
}

// A retail product name almost always has a size, kit, or gift-set marker in
// it somewhere — "(4.12 fl. oz.)", "8.5 OZ" with no parens, "(1 Kit)", "Gift
// Set", etc. Blank Stylist + a Sold By name is the same signal from a
// different angle (product sales aren't attributed to a stylist).
const RETAIL_SIZE_RE = /\d[\d.]*[\s_-]*(?:fl\.?[\s_]*oz\.?|oz\.?|ml|liters?)\b|\bkit\b|\bgift\s*set\b/i;
function isRetailItem(itemName, stylist, soldBy) {
  if (RETAIL_SIZE_RE.test(itemName)) return true;
  if (!stylist && soldBy) return true;
  return false;
}

const COLOR_KEYWORDS = ['color', 'colour', 'highlight', 'foil', 'demi', 'toner', 'balayage', 'grey blending', 'gray blending', 'repigmentation', 'supercolor', 'hairpainting'];
function isColorItem(itemName) {
  const t = itemName.toLowerCase();
  return COLOR_KEYWORDS.some(k => t.includes(k));
}

// "Signature Service" — its own tracked $ figure (Setup > Historical Import
// only; the routine weekly Stylist Report has no item-level detail to match
// against). Real exports DO carry an Item Category for this ("Conditioning
// Treatment Services", used directly above whenever present) — this
// name-only regex is now just the fallback for the older export format
// with no Item Type/Category columns at all, where category isn't an
// option. It under-counts on its own (only matches items literally named
// "Signature Service ...", not every item in the category), so don't use
// it when a category column is available.
function isSignatureServiceItem(itemName) {
  return /signature\s*service/i.test(itemName);
}

// CPC/RPC need a "customer count" to divide by — the file's own Item
// Category gives this exactly ("Haircut Services") when present; otherwise
// fall back to matching common haircut SKU names.
const HAIRCUT_KEYWORDS = ['supercut', 'buzz cut', 'kids cut', 'trim'];
function isHaircutItem(itemName) {
  const t = itemName.toLowerCase();
  return HAIRCUT_KEYWORDS.some(k => t.includes(k));
}

export async function parseSalesAccrualFile(file) {
  const grid = await readWorkbookGrid(file);
  const hdrRowIdx = grid.findIndex(row => row.some(c => cellText(c).toLowerCase() === 'center name'));
  if (hdrRowIdx === -1) throw new Error('Could not find a "Center Name" column in this file.');
  const headerRow = grid[hdrRowIdx];
  const col = {
    center: findCol(headerRow, 'Center Name'),
    item: findCol(headerRow, 'Item Name'),
    qty: findCol(headerRow, 'Qty'),
    sales: findCol(headerRow, 'Sales (Exc. Tax)'),
    date: findCol(headerRow, 'Sale Date'),
    stylist: findCol(headerRow, 'Stylist'),
    soldBy: findCol(headerRow, 'Sold By'),
    itemType: findCol(headerRow, 'Item Type'),
    itemCategory: findCol(headerRow, 'Item Category'),
    invoice: findCol(headerRow, 'Invoice No'),
  };
  if (col.center === -1 || col.sales === -1 || col.date === -1) {
    throw new Error('Could not find the expected columns (Center Name, Sales (Exc. Tax), Sale Date) in this file.');
  }
  // Newer exports include an exact "Item Type" (Product/Service/Gift card)
  // and "Item Category" (e.g. "Color Services") — when present, use those
  // directly instead of guessing from the item name. No more heuristics,
  // no double-dipping between Sales and Retail.
  const hasExactTypes = col.itemType !== -1;

  // Retail Attach % (color tickets that also have a retail item on the same
  // invoice) needs real per-ticket linkage — only possible when this export
  // carries an "Invoice No" column (added to the source report after this
  // was first built; older exports won't have it, and this whole block is a
  // no-op when col.invoice === -1). Two-pass: rows for one invoice aren't
  // guaranteed contiguous in the file, so flag each invoice number as we go
  // (invoiceFlags), then fold the finished per-invoice flags into the
  // matching store/day record once the main loop is done.
  const invoiceFlags = new Map(); // invoiceNo -> { code, date, hasColor, hasRetail }
  const markInvoice = (invoiceNo, code, isoDate, isColorRow, isRetailRow) => {
    if (!invoiceNo || col.invoice === -1) return;
    if (!invoiceFlags.has(invoiceNo)) invoiceFlags.set(invoiceNo, { code, date: isoDate, hasColor: false, hasRetail: false });
    const f = invoiceFlags.get(invoiceNo);
    if (isColorRow) f.hasColor = true;
    if (isRetailRow) f.hasRetail = true;
  };

  const daily = new Map(); // `${code}|${isoDate}` -> { code, date, service, retail, color, giftCards, haircuts, signatureS, signatureSCount, colorTicketCount, colorTicketsWithRetail, employees: {name: {sales, colorSales, haircuts, signatureS, signatureSCount}} }
  for (let r = hdrRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const code = extractCode(cellText(row[col.center]));
    if (!code) continue;
    const isoDate = toISODate(cellText(row[col.date]));
    if (!isoDate) continue;

    const amount = numOf(row[col.sales]);
    const itemName = cellText(row[col.item]);
    const qty = col.qty !== -1 ? (numOf(row[col.qty]) || 1) : 1;
    const stylist = col.stylist !== -1 ? cellText(row[col.stylist]) : '';
    // Retail/product rows are typically attributed via "Sold By" rather than
    // "Stylist" in this export — fall back to Stylist if Sold By is blank.
    const soldBy = col.soldBy !== -1 ? cellText(row[col.soldBy]) : '';
    const invoiceNo = col.invoice !== -1 ? cellText(row[col.invoice]) : '';

    const key = `${code}|${isoDate}`;
    if (!daily.has(key)) daily.set(key, { code, date: isoDate, service: 0, retail: 0, color: 0, giftCards: 0, haircuts: 0, signatureS: 0, signatureSCount: 0, bottles: 0, otherServices: 0, colorTicketCount: 0, colorTicketsWithRetail: 0, employees: {}, products: {} });
    const rec = daily.get(key);
    const employeeFor = name => {
      if (!name) return null;
      if (!rec.employees[name]) rec.employees[name] = { sales: 0, colorSales: 0, haircuts: 0, retail: 0, signatureS: 0, signatureSCount: 0, otherServices: 0 };
      return rec.employees[name];
    };
    // "Other Services" — a non-retail, non-gift-card item that isn't Color,
    // isn't the haircut itself, and isn't Signature Service: beard trims,
    // waxes, shampoos, or anything else no other bucket already accounts
    // for. Deliberately a residual category (mirrors Signature Service's own
    // "Conditioning Treatment Services" bucket) rather than its own keyword
    // list, since the whole point is to catch everything the other three
    // don't — a keyword list would just under-count it the same way the old
    // Signature Service name-regex did (see isSignatureServiceItem's comment).
    const addService = (name, isColor, isHaircut, isSignature) => {
      const isOther = !isColor && !isHaircut && !isSignature;
      const emp = employeeFor(name);
      if (!emp) return;
      emp.sales += amount;
      if (isColor) emp.colorSales += amount;
      if (isHaircut) emp.haircuts += qty;
      if (isSignature) { emp.signatureS += amount; emp.signatureSCount += qty; }
      if (isOther) emp.otherServices += amount;
    };
    const addRetail = name => {
      const emp = employeeFor(name);
      // Also counts toward this employee's own `sales` — "Sales" means
      // total revenue (service + retail) app-wide now, same as the live
      // Stylist Report parser above, so a store's per-employee Sales column
      // always sums to the store's own combined Sales total.
      if (emp) { emp.retail += amount; emp.sales += amount; }
    };
    // Per-product breakdown for the Retail tab's "Products" view — only
    // meaningful when this export has a real Item Type column (the "Product"
    // rows this branch already isolates for the retail $ total); the older
    // name-heuristic branch below has no equally reliable signal for which
    // rows are genuinely one distinct product vs. a service line that merely
    // looks retail-shaped, so it's deliberately left out of product tracking.
    const addProduct = () => {
      if (!itemName) return;
      if (!rec.products[itemName]) rec.products[itemName] = { qty: 0, amount: 0 };
      rec.products[itemName].qty += qty;
      rec.products[itemName].amount += amount;
    };

    if (hasExactTypes) {
      const itemType = cellText(row[col.itemType]).trim();
      if (/^total\b/i.test(itemType)) continue; // the file's own grand-total row isn't real per-store revenue
      if (/^gift\s*card/i.test(itemType)) { rec.giftCards += amount; continue; }
      if (itemType === 'Product') {
        rec.retail += amount;
        rec.bottles += qty;
        addRetail(soldBy || stylist);
        addProduct();
        markInvoice(invoiceNo, code, isoDate, false, true);
      } else {
        rec.service += amount;
        const category = col.itemCategory !== -1 ? cellText(row[col.itemCategory]) : '';
        const isColor = category === 'Color Services';
        const isHaircut = category === 'Haircut Services';
        // Item Category DOES cover Signature Service after all — real exports
        // carry it as "Conditioning Treatment Services", contrary to the old
        // assumption behind isSignatureServiceItem's name-only regex (see its
        // comment below). That regex only matched items literally named
        // "Signature Service ...", silently missing every other item in the
        // same category (Awapuhi Treatment, JPM Bond Rx Treatment/Upcharge,
        // Tea Tree Escape, plain "Treatment") — undercounting both the count
        // and the $ total. Category is authoritative whenever it's present,
        // exactly like isColor/isHaircut above; the name regex is now only a
        // fallback for exports with no Item Category column at all (below).
        const isSignature = category === 'Conditioning Treatment Services';
        if (isColor) rec.color += amount;
        if (isHaircut) rec.haircuts += qty;
        if (isSignature) { rec.signatureS += amount; rec.signatureSCount += qty; }
        if (!isColor && !isHaircut && !isSignature) rec.otherServices += amount;
        addService(stylist, isColor, isHaircut, isSignature);
        markInvoice(invoiceNo, code, isoDate, isColor, false);
      }
    } else {
      // Older export without Item Type/Category — fall back to name-based heuristics.
      if (/^gift\s*card/i.test(itemName)) { rec.giftCards += amount; continue; }
      if (isRetailItem(itemName, stylist, soldBy)) {
        rec.retail += amount;
        addRetail(soldBy || stylist);
        markInvoice(invoiceNo, code, isoDate, false, true);
      } else {
        rec.service += amount;
        const isColor = isColorItem(itemName);
        const isHaircut = isHaircutItem(itemName);
        const isSignature = isSignatureServiceItem(itemName);
        if (isColor) rec.color += amount;
        if (isHaircut) rec.haircuts += qty;
        if (isSignature) { rec.signatureS += amount; rec.signatureSCount += qty; }
        if (!isColor && !isHaircut && !isSignature) rec.otherServices += amount;
        addService(stylist, isColor, isHaircut, isSignature);
        markInvoice(invoiceNo, code, isoDate, isColor, false);
      }
    }
  }

  // Fold the finished per-invoice flags into their store/day record — done
  // as a second pass (not inline during the main loop) since an invoice's
  // rows aren't guaranteed to be contiguous in the file, so `hasColor`/
  // `hasRetail` aren't known for sure until every row has been seen.
  invoiceFlags.forEach(f => {
    if (!f.hasColor) return;
    const rec = daily.get(`${f.code}|${f.date}`);
    if (!rec) return;
    rec.colorTicketCount += 1;
    if (f.hasRetail) rec.colorTicketsWithRetail += 1;
  });

  if (!daily.size) throw new Error('No sales rows found in this file.');
  const records = Array.from(daily.values()).map(r => ({
    code: r.code, date: r.date,
    service: Math.round(r.service * 100) / 100,
    retail: Math.round(r.retail * 100) / 100,
    color: Math.round(r.color * 100) / 100,
    giftCards: Math.round(r.giftCards * 100) / 100,
    haircuts: Math.round(r.haircuts * 100) / 100,
    signatureS: Math.round(r.signatureS * 100) / 100,
    signatureSCount: Math.round(r.signatureSCount * 100) / 100,
    bottles: Math.round(r.bottles * 100) / 100,
    otherServices: Math.round(r.otherServices * 100) / 100,
    colorTicketCount: r.colorTicketCount,
    colorTicketsWithRetail: r.colorTicketsWithRetail,
    employees: Object.entries(r.employees).map(([name, v]) => ({
      name, sales: Math.round(v.sales * 100) / 100, colorSales: Math.round(v.colorSales * 100) / 100,
      haircuts: Math.round(v.haircuts * 100) / 100, retail: Math.round(v.retail * 100) / 100,
      signatureS: Math.round(v.signatureS * 100) / 100,
      signatureSCount: Math.round(v.signatureSCount * 100) / 100,
      otherServices: Math.round(v.otherServices * 100) / 100,
    })),
    products: Object.fromEntries(
      Object.entries(r.products).map(([name, v]) => [name, { qty: Math.round(v.qty * 100) / 100, amount: Math.round(v.amount * 100) / 100 }])
    ),
  }));
  return { records, fileName: file.name };
}

export async function parseAttendanceHistoryFile(file) {
  const grid = await readWorkbookGrid(file);
  const hdrRowIdx = grid.findIndex(row => row.some(c => cellText(c).toLowerCase() === 'employee name'));
  if (hdrRowIdx === -1) throw new Error('Could not find an "Employee Name" column in this file.');
  const headerRow = grid[hdrRowIdx];
  const col = {
    date: findCol(headerRow, 'Date'),
    employeeName: findCol(headerRow, 'Employee Name'),
    workCenter: findCol(headerRow, 'Work Center'),
    actualHours: findCol(headerRow, 'Actual Hours'),
  };
  if (col.date === -1 || col.workCenter === -1 || col.actualHours === -1) {
    throw new Error('Could not find the expected columns (Date, Work Center, Actual Hours) in this file.');
  }

  const daily = new Map(); // `${code}|${isoDate}` -> { code, date, hours, employees: {name: hours} }
  for (let r = hdrRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const code = extractCode(cellText(row[col.workCenter]));
    if (!code) continue;
    const isoDate = toISODate(cellText(row[col.date]));
    if (!isoDate) continue;
    const hours = numOf(row[col.actualHours]);
    const empName = col.employeeName !== -1 ? cellText(row[col.employeeName]) : '';

    const key = `${code}|${isoDate}`;
    if (!daily.has(key)) daily.set(key, { code, date: isoDate, hours: 0, employees: {} });
    const rec = daily.get(key);
    rec.hours += hours;
    if (empName) rec.employees[empName] = (rec.employees[empName] || 0) + hours;
  }

  if (!daily.size) throw new Error('No attendance rows found in this file.');
  const records = Array.from(daily.values()).map(r => ({
    code: r.code, date: r.date, hours: Math.round(r.hours * 100) / 100,
    employees: Object.entries(r.employees).map(([name, hrs]) => ({ name, totalHours: Math.round(hrs * 100) / 100 })),
  }));
  return { records, fileName: file.name };
}

// Merge newly-parsed daily records into the existing permanent history.
// Re-uploading the same file/date range is safe — it just overwrites those
// exact store+date entries with the same numbers, no duplication.
// Merges one source's per-employee fields into an existing {name: {...}} map
// without clobbering fields that came from a different source (e.g. Sales
// gives sales/colorSales, Attendance gives totalHours — either can arrive
// first or be re-uploaded later without erasing the other's contribution).
function mergeEmployeeFields(existingMap, newEntries, fields) {
  const merged = { ...(existingMap || {}) };
  newEntries.forEach(e => {
    const prev = merged[e.name] || {};
    const next = { ...prev };
    fields.forEach(f => { next[f] = e[f]; });
    merged[e.name] = next;
  });
  return merged;
}

export function mergeSalesIntoHistory(history, salesRecords) {
  const next = { ...history };
  salesRecords.forEach(r => {
    const key = `${r.code}|${r.date}`;
    const existing = next[key] || { code: r.code, date: r.date, service: null, retail: null, color: null, hours: null, giftCards: null, haircuts: null, signatureS: null, signatureSCount: null, bottles: null, otherServices: null, colorTicketCount: null, colorTicketsWithRetail: null, employees: {}, products: {} };
    next[key] = {
      ...existing, service: r.service, retail: r.retail, color: r.color, giftCards: r.giftCards, haircuts: r.haircuts, signatureS: r.signatureS, signatureSCount: r.signatureSCount, bottles: r.bottles, otherServices: r.otherServices,
      colorTicketCount: r.colorTicketCount, colorTicketsWithRetail: r.colorTicketsWithRetail,
      products: r.products || {},
      employees: mergeEmployeeFields(existing.employees, r.employees || [], ['sales', 'colorSales', 'haircuts', 'retail', 'signatureS', 'signatureSCount', 'otherServices']),
    };
  });
  return next;
}
export function mergeAttendanceIntoHistory(history, attendanceRecords) {
  const next = { ...history };
  attendanceRecords.forEach(r => {
    const key = `${r.code}|${r.date}`;
    const existing = next[key] || { code: r.code, date: r.date, service: null, retail: null, color: null, hours: null, giftCards: null, haircuts: null, signatureS: null, signatureSCount: null, employees: {} };
    next[key] = {
      ...existing, hours: r.hours,
      employees: mergeEmployeeFields(existing.employees, r.employees || [], ['totalHours']),
    };
  });
  return next;
}

// ─── Weekly snapshot (fed by the regular Stylist Report upload) ────────────
// Turns an already-parsed Stylist Report into one record per store for that
// exact week (keyed by its real start/end dates), so every normal Monday
// upload permanently extends the history — without needing the heavier
// Sales-Accrual/Attendance historical import for ongoing weeks.
export function buildWeeklyRecord(report) {
  if (!report.startDateISO || !report.endDateISO) return null;
  const weekKey = `${report.startDateISO}_${report.endDateISO}`;
  const stores = {};
  report.stores.forEach(s => {
    if (!s.code) return;
    stores[s.code] = {
      // Raw service-only figure, deliberately NOT s.totals.sales (which is
      // now service+retail combined) — history must keep service/retail as
      // separate raw fields, same shape Sales-Accrual already stores, or
      // getRangeTotals would double-count this week's retail the next time
      // it's read back (see rollup()'s serviceSales field in parser.js).
      service: s.totals.serviceSales,
      retail: s.totals.retail,
      color: s.totals.colorSales,
      hours: s.totals.totalHours,
      haircuts: s.totals.haircuts,
      otherServices: s.totals.otherServices,
      employees: s.employees.map(e => ({
        name: e.name, sales: e.sales, colorSales: e.colorSales, retail: e.retail,
        haircuts: e.haircuts, totalHours: e.totalHours, otherServices: e.otherServices,
      })),
    };
  });
  return { weekKey, startDate: report.startDateISO, endDate: report.endDateISO, stores };
}

// Re-uploading the same week is safe — its whole entry is just replaced.
export function mergeWeeklyIntoHistory(weeklyHistory, weekRecord) {
  if (!weekRecord) return weeklyHistory;
  return { ...weeklyHistory, [weekRecord.weekKey]: weekRecord };
}
