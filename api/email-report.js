// Vercel serverless function — Node.js runtime.
// Receives a base64-encoded report attachment (forwarded by the Google Apps
// Script set up via Setup > Email Reports in the app, one JSON POST per
// email) and saves it exactly like a manual Setup > Upload would — same
// parsers, same Supabase table, same weekly-history merge for the stylist report.
//
// Auth is a single shared secret (EMAIL_INGEST_SECRET) since this has no user
// session to check — anyone with the URL + secret can overwrite live data, so
// treat the secret like a password.

import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import {
  sheetToGrid,
  parseStylistReportFromGrid,
  parseReviewsFromGrid,
  parseEmployeeStartDatesFromGrid,
  buildWeeklyRecord,
  mergeWeeklyIntoHistory,
} from '../src/parser.js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';
const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

async function loadRow(key) {
  const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
  if (error) throw new Error(`Supabase load failed: ${error.message}`);
  return data ? data.payload : null;
}
async function saveRow(key, payload) {
  const { error } = await supabase.from('weekly_report').upsert({ report_id: key, payload }, { onConflict: 'report_id' });
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
}

function gridFromBase64(contentBase64) {
  const buf = Buffer.from(contentBase64, 'base64');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = sheetToGrid(ws);
  if (!grid.length) throw new Error('No data found in the attached file.');
  return grid;
}

// One entry per report type this endpoint knows how to ingest — add a new
// key here (plus a matching Gmail label + Apps Script entry) to support
// another emailed report in the future.
const HANDLERS = {
  stylist_report: async (grid, fileName) => {
    const parsed = parseStylistReportFromGrid(grid, fileName);
    await saveRow('stylist_report', parsed);

    // Mirrors handleFile's weekly-history merge in App.js, but only loads/saves
    // the one affected month's chunk instead of the whole in-memory history —
    // the browser has the full thing loaded already, this endpoint doesn't need to.
    const weekRecord = buildWeeklyRecord(parsed);
    if (weekRecord) {
      const month = weekRecord.startDate.slice(0, 7);
      const existingChunk = (await loadRow(`weekly_history_${month}`)) || {};
      const mergedChunk = mergeWeeklyIntoHistory(existingChunk, weekRecord);
      await saveRow(`weekly_history_${month}`, mergedChunk);
    }
    return `Stylist report saved — ${parsed.storeCount} stores, ${parsed.employeeCount} employees.`;
  },
  reviews: async (grid, fileName) => {
    const parsed = parseReviewsFromGrid(grid, fileName);
    await saveRow('reviews', parsed);
    return `Reviews saved — ${parsed.reviews.length} reviews.`;
  },
  employee_start_dates: async (grid, fileName) => {
    const parsed = parseEmployeeStartDatesFromGrid(grid, fileName);
    await saveRow('employee_start_dates', parsed);
    return `Employee start dates saved — ${parsed.employees.length} employees.`;
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const expectedSecret = process.env.EMAIL_INGEST_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'EMAIL_INGEST_SECRET is not configured on this deployment.' });
    return;
  }
  const { secret, type, fileName, contentBase64 } = req.body || {};
  if (secret !== expectedSecret) {
    res.status(401).json({ error: 'Invalid or missing secret.' });
    return;
  }

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured on this deployment.' });
    return;
  }

  const handlerFn = HANDLERS[type];
  if (!handlerFn) {
    res.status(400).json({ error: `Unknown report type "${type}". Expected one of: ${Object.keys(HANDLERS).join(', ')}` });
    return;
  }
  if (!contentBase64) {
    res.status(400).json({ error: 'No file content was provided.' });
    return;
  }

  try {
    const grid = gridFromBase64(contentBase64);
    const message = await handlerFn(grid, fileName || 'email-attachment');
    res.status(200).json({ ok: true, message });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
}
