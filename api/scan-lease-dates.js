// Vercel serverless function — owner-only. Reads a store's already-uploaded
// lease documents straight out of Supabase Storage and tries to pull the
// current lease term (start/end) out of their text with pattern matching —
// no Claude/Anthropic call, no API spend. This replaced an earlier version
// that sent PDFs to Claude for the same job; the user asked for a free
// alternative, so this trades the LLM's cross-document reasoning for plain
// keyword-proximity + date-regex heuristics against each PDF's extracted
// text (`pdf-parse`, pure JS, no native deps — safe on Vercel's Node
// runtime). Real limitation, stated plainly in the result: any document
// that's a scanned image with no text layer (common for pre-2000s leases)
// yields nothing here — those still need manual entry.
import { createServiceClient, requireSession } from '../src/serverAuth.js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const BUCKET = 'lease-documents';
// Guard against a pathological huge file spiking function memory/time —
// generous, since there's no Claude request-size limit to respect anymore.
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const MONTH_PATTERN = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
// Three date shapes: "Month Day, Year", "Day (of) Month, Year", "MM/DD/YYYY"
// — all requiring a 4-digit year, so there's no 2-digit-year century
// ambiguity to guess at.
const DATE_REGEX = new RegExp(
  `${MONTH_PATTERN}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})` +
  `|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?${MONTH_PATTERN}\\.?,?\\s+(\\d{4})` +
  `|(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})`,
  'gi'
);

const MONTH_INDEX = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

function isoFromParts(year, monthIdx, day) {
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// One match of DATE_REGEX → ISO date, or null if the parts don't make sense
// (e.g. day 32, month 13 from a false-positive numeric match).
function matchToISO(m) {
  if (m[3]) return isoFromParts(Number(m[3]), MONTH_INDEX[m[1].toLowerCase().replace('.', '')] ?? -1, Number(m[2]));
  if (m[6]) return isoFromParts(Number(m[6]), MONTH_INDEX[m[5].toLowerCase().replace('.', '')] ?? -1, Number(m[4]));
  if (m[9]) return isoFromParts(Number(m[9]), Number(m[7]) - 1, Number(m[8]));
  return null;
}

const START_KEYWORDS = /commenc\w*|effective\s+date|term\s+shall\s+begin|lease\s+shall\s+begin/i;
const END_KEYWORDS = /expir\w*|terminat\w*|end\s+of\s+(?:the\s+)?term|shall\s+continue\s+(?:until|through)|extend\w*\s+(?:the\s+term\s+)?(?:through|until|to)/i;
const KEYWORD_WINDOW = 70; // chars of context checked on each side of a date match

// Scans one document's text for start/end lease-term date candidates,
// classified by whatever start/end keyword appears within KEYWORD_WINDOW
// characters of the date. A date with no nearby keyword is dropped —
// documents are full of unrelated dates (signature blocks, notarization,
// recording stamps) and an unclassified date is just noise.
function findDateCandidates(text) {
  const starts = [];
  const ends = [];
  let m;
  DATE_REGEX.lastIndex = 0;
  while ((m = DATE_REGEX.exec(text))) {
    const iso = matchToISO(m);
    if (!iso) continue;
    const from = Math.max(0, m.index - KEYWORD_WINDOW);
    const to = Math.min(text.length, m.index + m[0].length + KEYWORD_WINDOW);
    const context = text.slice(from, to);
    if (END_KEYWORDS.test(context)) ends.push(iso);
    else if (START_KEYWORDS.test(context)) starts.push(iso);
  }
  return { starts, ends };
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

  const { token, storeCode, files } = req.body || {};
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
    const skipped = [];
    const noTextDocs = [];
    // Best end candidate = furthest-out date found anywhere (a later
    // renewal/amendment always pushes expiration further into the future,
    // same "furthest end date wins" rule the filename-based bulk-upload
    // fill already uses). Best start candidate = earliest date found
    // (the original commencement date isn't reset by later amendments).
    let bestEnd = null; // { date, doc }
    let bestStart = null; // { date, doc }

    for (const file of files) {
      if (!file?.path || !file?.name) continue;
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(file.path, 300);
      if (signError) { skipped.push({ name: file.name, reason: signError.message }); continue; }

      const fileResp = await fetch(signed.signedUrl);
      if (!fileResp.ok) { skipped.push({ name: file.name, reason: `download failed (${fileResp.status})` }); continue; }

      const buf = Buffer.from(await fileResp.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) { skipped.push({ name: file.name, reason: 'skipped — file too large to scan' }); continue; }

      let text = '';
      try {
        const parsed = await pdfParse(buf);
        text = parsed.text || '';
      } catch (err) {
        skipped.push({ name: file.name, reason: `couldn't read PDF (${err.message})` });
        continue;
      }

      if (text.trim().length < 20) {
        // No real text layer — almost always a scanned image page with no OCR.
        noTextDocs.push(file.name);
        continue;
      }

      const { starts, ends } = findDateCandidates(text);
      ends.forEach(date => { if (!bestEnd || date > bestEnd.date) bestEnd = { date, doc: file.name }; });
      starts.forEach(date => { if (!bestStart || date < bestStart.date) bestStart = { date, doc: file.name }; });
    }

    if (!bestStart && !bestEnd) {
      const reason = noTextDocs.length
        ? `No lease-term dates could be located — ${noTextDocs.length} of ${files.length} document(s) had no extractable text (likely scanned images), and the rest didn't contain a recognizable commencement/expiration date near a date.`
        : `No lease-term dates could be located in these documents' text.`;
      res.status(200).json({ ok: true, result: null, skipped, noTextDocs, message: reason });
      return;
    }

    const parts = [];
    if (bestStart) parts.push(`commencement date found in "${bestStart.doc}"`);
    if (bestEnd) parts.push(`expiration date found in "${bestEnd.doc}" (the furthest-out end date across all documents, on the theory that's the most recent renewal/amendment)`);
    if (noTextDocs.length) parts.push(`${noTextDocs.length} document(s) had no extractable text and weren't scanned`);

    res.status(200).json({
      ok: true,
      skipped,
      noTextDocs,
      result: {
        termStart: bestStart ? bestStart.date : null,
        termEnd: bestEnd ? bestEnd.date : null,
        confidence: 'low',
        reasoning: `Pattern-matched from document text, not read by a person or AI — double-check against the source document before trusting it. ${parts.join('; ')}.`,
        sourceDocument: bestEnd ? bestEnd.doc : (bestStart ? bestStart.doc : null),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
