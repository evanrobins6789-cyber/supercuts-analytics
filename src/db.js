import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

const LOCAL_PREFIX = 'supercuts_report_v1_';

function readLocal(key) {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Generic loader/saver — `key` distinguishes multiple datasets (the weekly
// stylist report, the employee start-date roster, etc.) sharing one table.
// Returns { data, source: 'supabase'|'local', error }
export async function loadData(key) {
  if (supabase) {
    const { data, error } = await supabase.from('weekly_report').select('*').eq('report_id', key).maybeSingle();
    if (!error) {
      return { data: data ? data.payload : null, source: 'supabase', error: null };
    }
    return { data: readLocal(key), source: 'local', error: error.message };
  }
  return { data: readLocal(key), source: 'local', error: null };
}

// Returns { ok, error }
export async function saveData(key, payload) {
  if (payload == null) return { ok: false, error: 'Internal error: no data to save' };
  let error = null;
  if (supabase) {
    const res = await supabase.from('weekly_report').upsert({ report_id: key, payload }, { onConflict: 'report_id' });
    if (res.error) { error = res.error.message; console.error('Supabase save error', res.error); }
  }
  try { localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(payload)); } catch {}
  return { ok: !error, error };
}

export async function clearData(key) {
  if (supabase) {
    await supabase.from('weekly_report').delete().eq('report_id', key);
  }
  localStorage.removeItem(LOCAL_PREFIX + key);
}
