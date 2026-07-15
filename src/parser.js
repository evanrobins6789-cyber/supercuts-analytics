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
        if (start && end) dateRangeLabel = `${start} – ${end}`;
      }
      continue;
    }

    if (!current) continue; // stray row before any store header
    if (!first && !last) continue; // blank/summary row (e.g. the file's own Grand Total)

    current.employees.push({
      name: `${first} ${last}`.trim(),
      sales: numOf(row[col.sales]),
      colorSales: numOf(row[col.colorNet]),
      retail: numOf(row[col.productNet]),
      cpc: numOf(row[col.cpc]),
      rpc: numOf(row[col.rpc]),
      tsth: numOf(row[col.tsth]),
      haircuts: numOf(row[col.haircuts]),
      totalHours: numOf(row[col.totalHours]),
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
