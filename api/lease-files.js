// Vercel serverless function — owner-only Supabase Storage access for lease
// documents. Mirrors api/scoped-data.js's pattern (service-role client,
// session re-checked fresh on every call) but for file storage instead of
// the weekly_report jsonb table, since nothing in this app has needed
// Supabase Storage before now. Files themselves never pass through this
// function's request body — it only ever hands back short-lived signed
// URLs, so the browser uploads/downloads directly against Supabase Storage
// and Vercel's serverless body-size limit never comes into play.
import { createServiceClient, requireSession } from '../src/serverAuth.js';

const BUCKET = 'lease-documents';
let bucketEnsured = false;

// Created lazily on first use rather than requiring a manual dashboard step
// — the service-role key already has storage-admin rights, so this is safe
// to do on demand. `bucketEnsured` just avoids a redundant listBuckets call
// on every request within the same warm serverless instance.
async function ensureBucket(supabase) {
  if (bucketEnsured) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(error.message);
  if (!buckets.some(b => b.name === BUCKET)) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) throw new Error(createError.message);
  }
  bucketEnsured = true;
}

// Storage object keys are otherwise unconstrained — strip anything that
// isn't a safe path segment so a weird source filename (unicode, stray
// slashes) can't produce a surprising object key.
function sanitizeFileName(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned.slice(-150) || 'file';
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

  const { token, action, storeCode, fileName, path } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  // Lease documents (rent rolls, landlord contacts, signed leases) are
  // owner-only, same blanket rule as store_leases itself in scoped-data.js.
  if (employee.role !== 'owner') {
    res.status(403).json({ error: 'Only the owner can manage lease documents.' });
    return;
  }

  try {
    await ensureBucket(supabase);

    if (action === 'uploadUrl') {
      if (!storeCode || !fileName) {
        res.status(400).json({ error: 'Missing storeCode or fileName.' });
        return;
      }
      const objectPath = `${storeCode}/${Date.now()}-${sanitizeFileName(fileName)}`;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(objectPath);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, path: objectPath, uploadToken: data.token, signedUrl: data.signedUrl });
      return;
    }

    if (action === 'viewUrl') {
      if (!path) {
        res.status(400).json({ error: 'Missing path.' });
        return;
      }
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true, url: data.signedUrl });
      return;
    }

    if (action === 'delete') {
      if (!path) {
        res.status(400).json({ error: 'Missing path.' });
        return;
      }
      const { error } = await supabase.storage.from(BUCKET).remove([path]);
      if (error) throw new Error(error.message);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
