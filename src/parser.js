import * as XLSX from 'xlsx';

function sheetToGrid(ws) {
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

// Weighted (not naively summed) rollup for a group of employee rows.
function rollup(employees) {
  const sum = key => employees.reduce((s, e) => s + (e[key] || 0), 0);
  const totalSales = sum('sales');
  const totalHours = sum('totalHours');
  const totalColor = sum('colorSales');
  const totalRetail = sum('retail');
  const totalHaircuts = sum('haircuts');
  return {
    sales: Math.round(totalSales * 100) / 100,
    totalHours: Math.round(totalHours * 100) / 100,
    colorSales: Math.round(totalColor * 100) / 100,
    retail: Math.round(totalRetail * 100) / 100,
    haircuts: totalHaircuts,
    tsth: totalHours > 0 ? totalSales / totalHours : null,
    cpc: totalHaircuts > 0 ? totalColor / totalHaircuts : null,
    rpc: totalHaircuts > 0 ? totalRetail / totalHaircuts : null,
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
    current.employees.push({
      name: `${first} ${last}`.trim(),
      sales: numOf(row[col.sales]),
      colorSales: numOf(row[col.colorNet]),
      retail: numOf(row[col.productNet]),
      cpc: numOf(row[col.cpc]),
      rpc: numOf(row[col.rpc]),
      tsth: numOf(row[col.tsth]),
      haircuts: empHaircuts,
      totalHours: empHours,
      // No CPH column in the source export — unlike CPC/RPC/TSTH, this one's
      // ours to compute, so it only appears when both figures are actually present.
      cph: empHours > 0 ? empHaircuts / empHours : null,
      prodHours: numOf(row[col.prodHours]),
      nonProdHours: numOf(row[col.nonProdHours]),
      daysWorked: numOf(row[col.daysWorked]),
      otherNet: numOf(row[col.otherNet]),
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
    fileName: file.name,
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

  return { employees, fileName: file.name };
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

// ─── Reviews export (CSV) ───────────────────────────────────────────────────
// A Google-reviews style export. The "location" column is a verbose listing
// name that doesn't match our store naming — "location short name" is the
// store CODE, which is what we actually match on (same pattern as goals).
export async function parseReviews(file) {
  const grid = await readWorkbookGrid(file); // XLSX.read auto-detects CSV too
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
    const code = cellText(row[col.code]);
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

  return { reviews, fileName: file.name };
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
  };
  if (col.center === -1 || col.sales === -1 || col.date === -1) {
    throw new Error('Could not find the expected columns (Center Name, Sales (Exc. Tax), Sale Date) in this file.');
  }
  // Newer exports include an exact "Item Type" (Product/Service/Gift card)
  // and "Item Category" (e.g. "Color Services") — when present, use those
  // directly instead of guessing from the item name. No more heuristics,
  // no double-dipping between Sales and Retail.
  const hasExactTypes = col.itemType !== -1;

  const daily = new Map(); // `${code}|${isoDate}` -> { code, date, service, retail, color, giftCards, haircuts, employees: {name: {sales, colorSales, haircuts}} }
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

    const key = `${code}|${isoDate}`;
    if (!daily.has(key)) daily.set(key, { code, date: isoDate, service: 0, retail: 0, color: 0, giftCards: 0, haircuts: 0, employees: {} });
    const rec = daily.get(key);
    const employeeFor = name => {
      if (!name) return null;
      if (!rec.employees[name]) rec.employees[name] = { sales: 0, colorSales: 0, haircuts: 0, retail: 0 };
      return rec.employees[name];
    };
    const addService = (name, isColor, isHaircut) => {
      const emp = employeeFor(name);
      if (!emp) return;
      emp.sales += amount;
      if (isColor) emp.colorSales += amount;
      if (isHaircut) emp.haircuts += qty;
    };
    const addRetail = name => {
      const emp = employeeFor(name);
      if (emp) emp.retail += amount;
    };

    if (hasExactTypes) {
      const itemType = cellText(row[col.itemType]).trim();
      if (/^total\b/i.test(itemType)) continue; // the file's own grand-total row isn't real per-store revenue
      if (/^gift\s*card/i.test(itemType)) { rec.giftCards += amount; continue; }
      if (itemType === 'Product') {
        rec.retail += amount;
        addRetail(soldBy || stylist);
      } else {
        rec.service += amount;
        const category = col.itemCategory !== -1 ? cellText(row[col.itemCategory]) : '';
        const isColor = category === 'Color Services';
        const isHaircut = category === 'Haircut Services';
        if (isColor) rec.color += amount;
        if (isHaircut) rec.haircuts += qty;
        addService(stylist, isColor, isHaircut);
      }
    } else {
      // Older export without Item Type/Category — fall back to name-based heuristics.
      if (/^gift\s*card/i.test(itemName)) { rec.giftCards += amount; continue; }
      if (isRetailItem(itemName, stylist, soldBy)) {
        rec.retail += amount;
        addRetail(soldBy || stylist);
      } else {
        rec.service += amount;
        const isColor = isColorItem(itemName);
        const isHaircut = isHaircutItem(itemName);
        if (isColor) rec.color += amount;
        if (isHaircut) rec.haircuts += qty;
        addService(stylist, isColor, isHaircut);
      }
    }
  }

  if (!daily.size) throw new Error('No sales rows found in this file.');
  const records = Array.from(daily.values()).map(r => ({
    code: r.code, date: r.date,
    service: Math.round(r.service * 100) / 100,
    retail: Math.round(r.retail * 100) / 100,
    color: Math.round(r.color * 100) / 100,
    giftCards: Math.round(r.giftCards * 100) / 100,
    haircuts: Math.round(r.haircuts * 100) / 100,
    employees: Object.entries(r.employees).map(([name, v]) => ({
      name, sales: Math.round(v.sales * 100) / 100, colorSales: Math.round(v.colorSales * 100) / 100,
      haircuts: Math.round(v.haircuts * 100) / 100, retail: Math.round(v.retail * 100) / 100,
    })),
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
    const existing = next[key] || { code: r.code, date: r.date, service: null, retail: null, color: null, hours: null, giftCards: null, haircuts: null, employees: {} };
    next[key] = {
      ...existing, service: r.service, retail: r.retail, color: r.color, giftCards: r.giftCards, haircuts: r.haircuts,
      employees: mergeEmployeeFields(existing.employees, r.employees || [], ['sales', 'colorSales', 'haircuts', 'retail']),
    };
  });
  return next;
}
export function mergeAttendanceIntoHistory(history, attendanceRecords) {
  const next = { ...history };
  attendanceRecords.forEach(r => {
    const key = `${r.code}|${r.date}`;
    const existing = next[key] || { code: r.code, date: r.date, service: null, retail: null, color: null, hours: null, giftCards: null, haircuts: null, employees: {} };
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
      service: s.totals.sales,
      retail: s.totals.retail,
      color: s.totals.colorSales,
      hours: s.totals.totalHours,
      haircuts: s.totals.haircuts,
      employees: s.employees.map(e => ({
        name: e.name, sales: e.sales, colorSales: e.colorSales, retail: e.retail,
        haircuts: e.haircuts, totalHours: e.totalHours,
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
