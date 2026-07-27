// Vercel serverless function — Node.js runtime.
// Owner-only admin over the `employees` table (Setup > Employee Access):
// list the current roster, upload a replacement roster, or reset one
// person's password so they can sign back up. The uploaded file is parsed
// client-side (parseEmployeeAccessFromGrid in src/parser.js, same pattern as
// every other upload in this app) — this endpoint receives plain rows, not
// a raw file.

import { createServiceClient, requireSession } from '../src/serverAuth.js';

const VALID_ROLES = ['owner', 'district_leader', 'manager', 'employee'];

function serializeEmployee(e) {
  return {
    id: e.id,
    name: e.name,
    phone: e.phone,
    employeeCode: e.employee_code,
    role: e.role,
    storeCodes: e.store_codes || [],
    active: e.active,
    registered: !!e.password_hash,
  };
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

  const { action, token, rows, id } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'owner') {
    res.status(403).json({ error: 'Only the owner can manage employee access.' });
    return;
  }

  try {
    if (action === 'list') {
      const { data, error } = await supabase.from('employees').select('*').order('name');
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, employees: (data || []).map(serializeEmployee) });
      return;
    }

    if (action === 'upload') {
      if (!Array.isArray(rows) || !rows.length) {
        res.status(400).json({ error: 'No rows to upload.' });
        return;
      }
      if (rows.some(r => !VALID_ROLES.includes(r.role))) {
        res.status(400).json({ error: 'One or more rows has an invalid Role.' });
        return;
      }
      const newCodes = rows.map(r => String(r.employeeCode).trim());
      const upserts = rows.map(r => ({
        employee_code: String(r.employeeCode).trim(),
        phone: String(r.phone).replace(/\D/g, ''),
        name: r.name,
        role: r.role,
        store_codes: r.storeCodes || [],
        active: true,
      }));
      const { error: upsertError } = await supabase.from('employees').upsert(upserts, { onConflict: 'employee_code' });
      if (upsertError) throw new Error(upsertError.message);

      // Every upload is the full current roster, not a diff — anyone whose
      // employee code isn't in this file loses access, which is the whole
      // point of re-uploading when someone quits or is let go.
      const { data: existing, error: listError } = await supabase.from('employees').select('id, employee_code');
      if (listError) throw new Error(listError.message);
      const toDeactivate = (existing || []).filter(e => !newCodes.includes(e.employee_code)).map(e => e.id);
      if (toDeactivate.length) {
        const { error: deactivateError } = await supabase.from('employees').update({ active: false }).in('id', toDeactivate);
        if (deactivateError) throw new Error(deactivateError.message);
      }
      res.status(200).json({ ok: true, count: rows.length, deactivated: toDeactivate.length });
      return;
    }

    if (action === 'resetPassword') {
      if (!id) {
        res.status(400).json({ error: 'Missing employee id.' });
        return;
      }
      const { error } = await supabase.from('employees').update({ password_hash: null }).eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
