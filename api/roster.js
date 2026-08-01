// Vercel serverless function — Node.js runtime.
// Owner-only admin over the `employees` table (Setup > Employee Access):
// list the current roster, upload a replacement roster, or reset one
// person's PIN so they can create a new one. The uploaded file is parsed
// client-side (parseEmployeeAccessFromGrid in src/parser.js, same pattern as
// every other upload in this app) — this endpoint receives plain rows, not
// a raw file.

import { createServiceClient, requireSession, hashPin, findEmployeeByPin } from '../src/serverAuth.js';

const VALID_ROLES = ['owner', 'district_leader', 'manager', 'employee'];
const PIN_PATTERN = /^[a-zA-Z0-9]{5,}$/;

// Stable per-name placeholder so re-uploading the SAME still-incomplete row
// twice doesn't create a duplicate — it always resolves to the same code,
// so the upsert below updates the same DB row instead of inserting a new
// one. Only used when a row has no real Employee Code yet.
function pendingCode(name) {
  const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `PENDING-${slug || 'unknown'}`;
}

function serializeEmployee(e) {
  return {
    id: e.id,
    name: e.name,
    phone: e.phone,
    employeeCode: e.employee_code,
    role: e.role,
    storeCodes: e.store_codes || [],
    active: e.active,
    registered: !!e.pin_hash,
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

  const { action, token, rows, id, name, employeeCode, phone, role, storeCodes, pin } = req.body || {};
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
      // A row can arrive with no Employee Code / Phone yet (parseEmployeeAccessFromGrid
      // no longer drops those — see its comment). Give it a stable placeholder
      // code instead so it still gets a real DB row (visible in Setup >
      // Employee Access for the owner to fill in later) rather than being
      // silently skipped or colliding with every other blank row on the
      // unique employee_code target this upsert conflicts on.
      const upserts = rows.map(r => {
        const trimmedCode = String(r.employeeCode || '').trim();
        const phoneDigits = String(r.phone || '').replace(/\D/g, '');
        return {
          employee_code: trimmedCode || pendingCode(r.name),
          phone: phoneDigits || null,
          name: r.name,
          role: r.role,
          store_codes: r.storeCodes || [],
          active: true,
        };
      });
      const newCodes = upserts.map(u => u.employee_code);
      const { error: upsertError } = await supabase.from('employees').upsert(upserts, { onConflict: 'employee_code' });
      if (upsertError) throw new Error(upsertError.message);

      // Every upload is the full current roster, not a diff — anyone whose
      // employee code isn't in this file loses access, which is the whole
      // point of re-uploading when someone quits or is let go. Except the
      // person doing the upload right now: a file that doesn't happen to
      // include them (e.g. the Master Salon List import, which deliberately
      // skips the Admin Team the seeded Owner account isn't sourced from)
      // must never deactivate the very account performing the upload —
      // that's a self-lockout with no in-app way back in.
      const { data: existing, error: listError } = await supabase.from('employees').select('id, employee_code');
      if (listError) throw new Error(listError.message);
      const toDeactivate = (existing || []).filter(e => e.id !== employee.id && !newCodes.includes(e.employee_code)).map(e => e.id);
      if (toDeactivate.length) {
        const { error: deactivateError } = await supabase.from('employees').update({ active: false }).in('id', toDeactivate);
        if (deactivateError) throw new Error(deactivateError.message);
      }
      const pending = upserts.filter(u => u.employee_code.startsWith('PENDING-')).length;
      res.status(200).json({ ok: true, count: rows.length, deactivated: toDeactivate.length, pending });
      return;
    }

    if (action === 'update') {
      if (!id) {
        res.status(400).json({ error: 'Missing employee id.' });
        return;
      }
      const patch = {};
      if (typeof name === 'string') patch.name = name.trim();
      if (typeof employeeCode === 'string') {
        const trimmed = employeeCode.trim();
        if (!trimmed) { res.status(400).json({ error: 'Employee code cannot be blank.' }); return; }
        patch.employee_code = trimmed;
      }
      if (typeof phone === 'string') patch.phone = phone.replace(/\D/g, '') || null;
      if (typeof role === 'string') {
        if (!VALID_ROLES.includes(role)) { res.status(400).json({ error: 'Invalid role.' }); return; }
        patch.role = role;
      }
      if (Array.isArray(storeCodes)) patch.store_codes = storeCodes;
      if (!Object.keys(patch).length) {
        res.status(400).json({ error: 'Nothing to update.' });
        return;
      }
      const { error } = await supabase.from('employees').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'resetPin') {
      if (!id) {
        res.status(400).json({ error: 'Missing employee id.' });
        return;
      }
      const { error } = await supabase.from('employees').update({ pin_hash: null }).eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    // Lets the owner set (or overwrite) any employee's PIN directly to a
    // chosen value — unlike resetPin, this doesn't require the person to go
    // through "Create a Login" themselves afterward. PINs stay one-way
    // hashed same as everywhere else (see src/serverAuth.js) — this doesn't
    // let the owner *view* anyone's existing PIN, only set a new one.
    if (action === 'setPin') {
      if (!id || !pin) {
        res.status(400).json({ error: 'Missing employee id or PIN.' });
        return;
      }
      if (!PIN_PATTERN.test(pin)) {
        res.status(400).json({ error: 'PIN must be at least 5 letters and/or numbers.' });
        return;
      }
      const clash = await findEmployeeByPin(supabase, pin);
      if (clash && clash.id !== id) {
        res.status(409).json({ error: 'That PIN is already in use by someone else — please choose a different one.' });
        return;
      }
      const pinHash = await hashPin(pin);
      const { error } = await supabase.from('employees').update({ pin_hash: pinHash }).eq('id', id);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
