// Vercel serverless function — Node.js runtime.
// Sign up / log in / log out for the employee login system. There's no
// username at login — Sign In is a bare PIN, so api/serverAuth.js's
// findEmployeeByPin has to scan every registered employee's hashed PIN to
// find a match (see the comment there). Sign up ("Create a Login") is
// gated by an employee code + phone number that only exists because the
// owner uploaded it via Setup > Employee Access (api/roster.js) — there's
// no open registration — and is a two-step flow client-side: checkEligible
// confirms the code/phone match before the person bothers picking a PIN,
// then signup does the real work once the PIN is chosen.

import { createServiceClient, normalizePhone, generateToken, hashPin, findEmployeeByPin } from '../src/serverAuth.js';

const PIN_PATTERN = /^[a-zA-Z0-9]{5,}$/;

async function findEligibleSignupRow(supabase, employeeCode, phone) {
  const { data: employee } = await supabase
    .from('employees').select('*')
    .eq('employee_code', String(employeeCode || '').trim())
    .eq('phone', normalizePhone(phone))
    .eq('active', true)
    .maybeSingle();
  return employee;
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

  const { action, employeeCode, phone, pin, token } = req.body || {};

  try {
    if (action === 'checkEligible') {
      if (!employeeCode || !phone) {
        res.status(400).json({ error: 'Employee code and phone number are both required.' });
        return;
      }
      const employee = await findEligibleSignupRow(supabase, employeeCode, phone);
      if (!employee) {
        res.status(404).json({ error: "That employee code and phone number don't match an active account on file. Check with the owner." });
        return;
      }
      if (employee.pin_hash) {
        res.status(409).json({ error: 'This account already has a PIN — use Sign In instead.' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'signup') {
      if (!employeeCode || !phone || !pin) {
        res.status(400).json({ error: 'Employee code, phone number, and a PIN are all required.' });
        return;
      }
      if (!PIN_PATTERN.test(pin)) {
        res.status(400).json({ error: 'PIN must be at least 5 letters and/or numbers.' });
        return;
      }
      const employee = await findEligibleSignupRow(supabase, employeeCode, phone);
      if (!employee) {
        res.status(404).json({ error: "That employee code and phone number don't match an active account on file. Check with the owner." });
        return;
      }
      if (employee.pin_hash) {
        res.status(409).json({ error: 'This account already has a PIN — use Sign In instead.' });
        return;
      }
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
    res.status(500).json({ error: err.message });
  }
}
