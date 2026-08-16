// Vercel serverless function — owner-only. Reads a store's already-uploaded
// lease documents straight out of Supabase Storage, sends them to Claude as
// native PDF input, and asks it to determine the CURRENT lease term
// (start/end) by reasoning across renewals/amendments — the piece the bulk
// upload's filename-based date extraction can't do for real Leasecake
// "Export" folder documents (raw filenames like "8150 2nd Renewal 2003.pdf",
// no dates encoded — see the 2026-08-16 Leases entry in HANDOFF.md).
import { createServiceClient, requireSession } from '../src/serverAuth.js';

const BUCKET = 'lease-documents';
// Stay comfortably under Claude's 32MB request limit — base64 inflates each
// file ~33%, and multiple documents plus prompt text share one request.
const MAX_TOTAL_ENCODED_BYTES = 24 * 1024 * 1024;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    termStart: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Current lease term commencement date, ISO 8601 (YYYY-MM-DD), or null if not determinable from these documents.',
    },
    termEnd: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Current lease term expiration date, ISO 8601 (YYYY-MM-DD), or null if not determinable from these documents.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: {
      type: 'string',
      description: 'One or two sentences on how the term was determined — especially which document (renewal/amendment/extension) set the CURRENT term, and why it supersedes any earlier one.',
    },
    sourceDocument: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The filename of the document that established the current term, or null if none clearly did.',
    },
  },
  required: ['termStart', 'termEnd', 'confidence', 'reasoning', 'sourceDocument'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'AI is not configured yet — the ANTHROPIC_API_KEY environment variable is missing on this deployment.' });
    return;
  }

  const supabase = createServiceClient();
  if (!supabase) {
    res.status(500).json({ error: 'Login is not configured on this deployment.' });
    return;
  }

  const { token, storeCode, storeName, files } = req.body || {};
  const { employee, error: sessionError } = await requireSession(supabase, token);
  if (!employee) {
    res.status(401).json({ error: sessionError });
    return;
  }
  if (employee.role !== 'owner') {
    res.status(403).json({ error: 'Only the owner can scan lease documents.' });
    return;
  }

  if (!storeCode || !Array.isArray(files) || !files.length) {
    res.status(400).json({ error: 'Missing storeCode or files.' });
    return;
  }

  try {
    const docBlocks = [];
    const skipped = [];
    let totalEncodedBytes = 0;

    for (const file of files) {
      if (!file?.path || !file?.name) continue;
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(file.path, 300);
      if (signError) { skipped.push({ name: file.name, reason: signError.message }); continue; }

      const fileResp = await fetch(signed.signedUrl);
      if (!fileResp.ok) { skipped.push({ name: file.name, reason: `download failed (${fileResp.status})` }); continue; }

      const buf = Buffer.from(await fileResp.arrayBuffer());
      const encodedSize = Math.ceil(buf.length * 4 / 3); // base64 inflation
      if (totalEncodedBytes + encodedSize > MAX_TOTAL_ENCODED_BYTES) {
        skipped.push({ name: file.name, reason: 'skipped — over the per-scan size budget' });
        continue;
      }
      totalEncodedBytes += encodedSize;
      docBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
        title: file.name,
      });
    }

    if (!docBlocks.length) {
      res.status(200).json({ ok: true, result: null, skipped, message: 'None of this store’s documents could be read.' });
      return;
    }

    const promptText = `These are all the real-estate lease documents on file for the ${storeName || `store ${storeCode}`} location (a retail salon lease) — they may include the original lease, amendments, renewals, extensions, and assignments, in no particular order, with filenames as they came from the source export (not necessarily descriptive of contents). Determine the CURRENT effective lease term: the commencement/start date and the expiration/end date that apply RIGHT NOW, accounting for any renewal, amendment, or extension that supersedes an earlier term. If documents conflict, prefer whichever renewal/amendment/extension is dated latest or explicitly extends the term furthest into the future. If you cannot determine a reliable current term from these documents, return null for both dates rather than guessing.`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [...docBlocks, { type: 'text', text: promptText }],
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      res.status(502).json({ error: `The AI service returned an error: ${errText.slice(0, 300)}` });
      return;
    }

    const data = await anthropicRes.json();
    if (data.stop_reason === 'refusal') {
      res.status(200).json({ ok: true, result: null, skipped, message: 'The AI declined to process these documents.' });
      return;
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    let result = null;
    if (textBlock) {
      try { result = JSON.parse(textBlock.text); } catch { result = null; }
    }
    res.status(200).json({ ok: true, result, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
