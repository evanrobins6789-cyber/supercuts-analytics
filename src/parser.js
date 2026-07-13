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

// Find a column index by exact (case-insensitive, trimmed) header match.
function findCol(headerRow, label) {
  const target = label.trim().toLowerCase();
  for (let c = 0; c < headerRow.length; c++) {
    if (cellText(headerRow[c]).toLowerCase() === target) return c;
  }
  return -1;
}

export async function parseWeeklyReport(file) {
  const grid = await new Promise((resolve, reject) => {
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

  const headerRow = grid[0];
  const col = {
    startDate: findCol(headerRow, 'Report Start Date'),
    endDate: findCol(headerRow, 'Report End Date'),
    name: findCol(headerRow, 'Location Name'),
    visits: findCol(headerRow, '#Customer Visit'),
    haircuts: findCol(headerRow, 'Hair Cut Count'),
    cph: findCol(headerRow, 'CPH'),
    netSales: findCol(headerRow, '$Net Sales w/o GC'),
    ticketAvg: findCol(headerRow, 'Ticket Average'),
    tsth: findCol(headerRow, 'TSTH'),
    totalHours: findCol(headerRow, 'Total Hours'),
    prodHours: findCol(headerRow, 'Production Hours'),
    nonProdHours: findCol(headerRow, 'Non Production Hours'),
    colorNet: findCol(headerRow, '$Color Net'),
    cpc: findCol(headerRow, 'CPC'),
    productNet: findCol(headerRow, 'Product Net'),
    rpc: findCol(headerRow, 'RPC'),
    otherNet: findCol(headerRow, '$All Other Services Net'),
    opc: findCol(headerRow, 'OPC'),
  };
  if (col.name === -1 || col.netSales === -1 || col.totalHours === -1) {
    throw new Error('Could not find the expected columns (Location Name, $Net Sales w/o GC, Total Hours) in this file.');
  }

  let dateRangeLabel = null;
  const stores = [];

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const name = cellText(row[col.name]);
    if (!name) continue;
    if (/^grand\s*total\s*:?$/i.test(name)) continue; // skip the file's own (invalid) summary row

    if (!dateRangeLabel) {
      const start = cellText(row[col.startDate]);
      const end = cellText(row[col.endDate]);
      if (start && end) dateRangeLabel = `${start} – ${end}`;
    }

    stores.push({
      name,
      visits: numOf(row[col.visits]),
      haircuts: numOf(row[col.haircuts]),
      cph: numOf(row[col.cph]),
      netSales: numOf(row[col.netSales]),
      ticketAvg: numOf(row[col.ticketAvg]),
      tsth: numOf(row[col.tsth]),
      totalHours: numOf(row[col.totalHours]),
      prodHours: numOf(row[col.prodHours]),
      nonProdHours: numOf(row[col.nonProdHours]),
      colorNet: numOf(row[col.colorNet]),
      cpc: numOf(row[col.cpc]),
      productNet: numOf(row[col.productNet]),
      rpc: numOf(row[col.rpc]),
      otherNet: numOf(row[col.otherNet]),
      opc: numOf(row[col.opc]),
    });
  }

  if (!stores.length) throw new Error('No store rows found in this file.');

  // Company-wide totals: sum the additive columns ourselves, then compute
  // weighted (not simply-averaged) rate metrics from those sums. Summing
  // per-store ratios like TSTH or CPH directly would be mathematically
  // wrong, which is why we don't trust the file's own "Grand Total" row
  // for anything except as a heads-up that it exists (we skip it above).
  const sum = key => stores.reduce((s, st) => s + (st[key] || 0), 0);
  const totalVisits = sum('visits');
  const totalHaircuts = sum('haircuts');
  const totalNetSales = sum('netSales');
  const totalHours = sum('totalHours');
  const totalProdHours = sum('prodHours');
  const totalNonProdHours = sum('nonProdHours');
  const totalColorNet = sum('colorNet');
  const totalProductNet = sum('productNet');
  const totalOtherNet = sum('otherNet');

  const totals = {
    visits: totalVisits,
    haircuts: totalHaircuts,
    netSales: Math.round(totalNetSales * 100) / 100,
    totalHours: Math.round(totalHours * 100) / 100,
    prodHours: Math.round(totalProdHours * 100) / 100,
    nonProdHours: Math.round(totalNonProdHours * 100) / 100,
    colorNet: Math.round(totalColorNet * 100) / 100,
    productNet: Math.round(totalProductNet * 100) / 100,
    otherNet: Math.round(totalOtherNet * 100) / 100,
    cph: totalHours > 0 ? totalHaircuts / totalHours : null,
    ticketAvg: totalVisits > 0 ? totalNetSales / totalVisits : null,
    tsth: totalHours > 0 ? totalNetSales / totalHours : null,
    cpc: totalHaircuts > 0 ? totalColorNet / totalHaircuts : null,
    rpc: totalHaircuts > 0 ? totalProductNet / totalHaircuts : null,
    opc: totalHaircuts > 0 ? totalOtherNet / totalHaircuts : null,
  };

  return { dateRangeLabel, stores, totals, storeCount: stores.length, fileName: file.name };
}
