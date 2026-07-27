// Vercel serverless function — Node.js runtime.
// Sign up / log in / log out for the employee login system. Sign up is
// gated by an employee code + phone number that only exists because the
// owner uploaded it via Setup > Employee Access (api/roster.js) — there's
// no open registration. Passwords are set by the employee themselves at
// sign-up time, hashed with bcrypt, never stored or shown in plain text.

import { createServiceClient, normalizePhone, generateToken, hashPassword, verifyPassword } from '../src/serverAuth.js';

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

  const { action, employeeCode, phone, password, token } = req.body || {};

  try {
    if (action === 'signup') {
      if (!employeeCode || !phone || !password) {
        res.status(400).json({ error: 'Employee code, phone number, and password are all required.' });
        return;
      }
      if (String(password).length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' });
        return;
      }
      const { data: employee } = await supabase
        .from('employees').select('*')
        .eq('employee_code', String(employeeCode).trim())
        .eq('phone', normalizePhone(phone))
        .eq('active', true)
        .maybeSingle();
      if (!employee) {
        res.status(404).json({ error: "That employee code and phone number don't match an active account on file. Check with the owner." });
        return;
      }
      if (employee.password_hash) {
        res.status(409).json({ error: 'This account is already set up — use Log In instead.' });
        return;
      }
      const passwordHash = await hashPassword(password);
      const { error: updateError } = await supabase.from('employees').update({ password_hash: passwordHash }).eq('id', employee.id);
      if (updateError) throw new Error(updateError.message);
      const sessionToken = generateToken();
      const { error: sessionError } = await supabase.from('sessions').insert({ token: sessionToken, employee_id: employee.id });
      if (sessionError) throw new Error(sessionError.message);
      res.status(200).json({ token: sessionToken, name: employee.name, role: employee.role });
      return;
    }

    if (action === 'login') {
      if (!phone || !password) {
        res.status(400).json({ error: 'Phone number and password are required.' });
        return;
      }
      const { data: employee } = await supabase
        .from('employees').select('*')
        .eq('phone', normalizePhone(phone))
        .eq('active', true)
        .maybeSingle();
      if (!employee || !(await verifyPassword(password, employee.password_hash))) {
        res.status(401).json({ error: 'Incorrect phone number or password.' });
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
