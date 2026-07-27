// Shared server-side helpers for the employee login system — imported by
// api/auth.js, api/roster.js, and api/scoped-data.js. Kept in src/, not
// api/, so it isn't picked up as its own Vercel function route (same reason
// api/email-report.js already imports parser.js from here instead of
// duplicating it under api/).
//
// Uses a Supabase SERVICE-ROLE key (SUPABASE_SERVICE_ROLE_KEY, server-only —
// never REACT_APP_-prefixed, so it never reaches the browser bundle), unlike
// db.js's client-side anon key. The `employees`/`sessions` tables have RLS
// enabled with no policies, so only this service-role key can read/write
// them at all.
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function createServiceClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

export function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

// Looks up a session token, joins the employee row, and confirms it's still
// active. Every request re-checks this fresh instead of trusting anything
// embedded in the token itself, so removing someone from the roster (or
// changing their role/store assignment) takes effect on their very next
// request — not just their next login.
export async function requireSession(supabase, token) {
  if (!token) return { employee: null, error: 'Not logged in.' };
  const { data: session, error: sessionError } = await supabase
    .from('sessions').select('employee_id').eq('token', token).maybeSingle();
  if (sessionError || !session) return { employee: null, error: 'Session expired or invalid — please log in again.' };
  const { data: employee, error: empError } = await supabase
    .from('employees').select('*').eq('id', session.employee_id).maybeSingle();
  if (empError || !employee || !employee.active) return { employee: null, error: 'Your access has been removed. Contact the owner.' };
  return { employee, error: null };
}
