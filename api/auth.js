// Vercel serverless function — Node.js runtime.
// Sign up / log in / log out for the employee login system. There's no
// username at login — Sign In is a bare PIN, so api/serverAuth.js's
// findEmployeeByPin has to scan every registered employee's hashed PIN to
// find a match (see the comment there). Sign up ("Create a Login") is
// gated by phone number alone — matched against the roster the owner
// uploaded via Setup > Employee Access (api/roster.js), there's no open
// registration — and is a two-step flow client-side: checkEligible confirms
// the phone matches exactly one not-yet-registered account before the
// person bothers picking a PIN, then signup does the real work once the PIN
// is chosen.
//
// Phone numbers aren't guaranteed unique in this roster (a handful of real
// people genuinely share a phone with someone else — see HANDOFF.md), so a
// phone that matches more than one still-unregistered account is treated as
// ambiguous and rejected with a message to contact the owner, rather than
// guessing which person is signing up.

import { createServiceClient, normalizePhone, generateToken, hashPin, findEmployeeByPin } from '../src/serverAuth.js';

const PIN_PATTERN = /^[a-zA-Z0-9]{5,}$/;
const AMBIGUOUS_PHONE_ERROR = 'More than one account on file shares this phone number — the owner will need to set your PIN directly in Employee Access.';
const NOT_FOUND_ERROR = "That phone number doesn't match an active account on file. Check with the owner.";
const ALREADY_REGISTERED_ERROR = 'This account already has a PIN — use Sign In instead.';

// Returns the single eligible (active, not yet registered) employee row for
// this phone, or throws a user-facing error if there's none or more than one.
async function findEligibleSignupRow(supabase, phone) {
  const { data: candidates, error } = await supabase
    .from('employees').select('*')
    .eq('phone', normalizePhone(phone))
    .eq('active', true);
  if (error) throw new Error(error.message);
  if (!candidates || !candidates.length) throw Object.assign(new Error(NOT_FOUND_ERROR), { status: 404 });
  const unregistered = candidates.filter(e => !e.pin_hash);
  if (!unregistered.length) throw Object.assign(new Error(ALREADY_REGISTERED_ERROR), { status: 409 });
  if (unregistered.length > 1) throw Object.assign(new Error(AMBIGUOUS_PHONE_ERROR), { status: 409 });
  return unregistered[0];
}

// Append-only audit trail, separate from `sessions` — `sessions` rows get
// deleted on logout (it's just "who's currently signed in"), which makes it
// useless for answering "how many times has this person logged in." A row
// here is never deleted, so counts/last-login are always reconstructable.
// Best-effort: a failure here shouldn't block someone from actually logging
// in, so errors are swallowed rather than thrown.
async function logLoginEvent(supabase, employee) {
  try {
    await supabase.from('login_events').insert({ employee_id: employee.id, employee_name: employee.name });
  } catch {
    // swallow — see comment above
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }

  const { action, phone, pin, token } = req.body || {};

  try {
    if (action === 'checkEligible') {
      if (!phone) {
        res.status(400).json({ error: 'Phone number is required.' });
        return;
      }
      await findEligibleSignupRow(supabase, phone);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'signup') {
      if (!phone || !pin) {
        res.status(400).json({ error: 'Phone number and a PIN are both required.' });
        return;
      }
      if (!PIN_PATTERN.test(pin)) {
        res.status(400).json({ error: 'PIN must be at least 5 letters and/or numbers.' });
        return;
      }
      const employee = await findEligibleSignupRow(supabase, phone);
      // There's no username, so two people can't be told apart by anything
      // but the PIN itself — it has to be unique across everyone, checked
      // the same way login finds an account (scan + compare).
      const clash = await findEmployeeByPin(supabase, pin);
      if (clash) {
        res.status(409).json({ error: 'That PIN is already in use by someone else — please choose a different one.' });
        return;
      }
      const pinHash = await hashPin(pin);
      const { error: updateError } = await supabase.from('employees').update({ pin_hash: pinHash }).eq('id', employee.id);
      if (updateError) throw new Error(updateError.message);
      const sessionToken = generateToken();
      const { error: sessionError } = await supabase.from('sessions').insert({ token: sessionToken, employee_id: employee.id });
      if (sessionError) throw new Error(sessionError.message);
      await logLoginEvent(supabase, employee);
      res.status(200).json({ token: sessionToken, name: employee.name, role: employee.role });
      return;
    }

    if (action === 'login') {
      if (!pin) {
        res.status(400).json({ error: 'PIN is required.' });
        return;
      }
      const employee = await findEmployeeByPin(supabase, pin);
      if (!employee) {
        res.status(401).json({ error: 'Incorrect PIN.' });
        return;
      }
      const sessionToken = generateToken();
      const { error: sessionError } = await supabase.from('sessions').insert({ token: sessionToken, employee_id: employee.id });
      if (sessionError) throw new Error(sessionError.message);
      await logLoginEvent(supabase, employee);
      res.status(200).json({ token: sessionToken, name: employee.name, role: employee.role });
      return;
    }

    if (action === 'logout') {
      if (token) await supabase.from('sessions').delete().eq('token', token);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}
