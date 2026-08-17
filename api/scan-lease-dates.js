// Vercel serverless function — owner-only. Reads a store's already-uploaded
// lease documents straight out of Supabase Storage and tries to pull the
// current lease term (start/end) out of their text with pattern matching —
// no Claude/Anthropic call, no API spend. This replaced an earlier version
// that sent PDFs to Claude for the same job; the user asked for a free
// alternative, so this trades the LLM's cross-document reasoning for plain
// keyword-proximity + date-regex heuristics against each PDF's extracted
// text (`pdf-parse`, pure JS, no native deps — safe on Vercel's Node
// runtime).
//
// OCR fallback (added later, same free-only constraint): a document with no
// embedded text layer (near-universal for pre-2010s leases — these are
// literal desk-scanner output, "EPSON Scan" as the PDF producer) used to be
// reported as unreadable outright. Now, when pdf-parse comes back empty,
// each page is rasterized with pdfjs-dist + @napi-rs/canvas and read with
// Tesseract (tesseract.js, WASM, no native OCR binary/install needed) —
// still zero API spend, just local compute. Verified against 4 real scanned
// Supercuts lease PDFs (Bethlehem, Harrisburg, Phoenixville, Morrell Plaza)
// in a standalone Node script before wiring this in: pdfjs-dist 4.x's
// bundled JPEG decoder produces malformed output on these old EPSON scans
// that segfaults @napi-rs/canvas's native renderer outright (not a catchable
// JS error — kills the process) — pdfjs-dist 6.x fixed the decoder and
// rendered/OCR'd all 4 cleanly, which is why the dependency is pinned to
// 6.x, not the more conservative 4.x releases. pdfjs-dist 6.x's Node
// engines requirement (>=22.13) is why package.json now declares that as
// its minimum — if this deployment's Vercel Project Settings > Node.js
// Version is pinned below that, this whole path (and possibly the import
// itself) will fail; check that first if OCR errors out in production.
// Bounded by a wall-clock deadline (not just a page-count cap) since a
// render+OCR pass is genuinely slow (~5-6s/page observed locally) against a
// 60s function budget — see OCR_DEADLINE_MS below. Never verified against
// an actual Vercel deployment (no live session in this sandbox); the local
// script proved the rendering/OCR logic itself works against real files,
// not that it survives Vercel's specific Lambda environment/cold start.
import { createServiceClient, requireSession } from '../src/serverAuth.js';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';

const BUCKET = 'lease-documents';
// Guard against a pathological huge file spiking function memory/time —
// generous, since there's no Claude request-size limit to respect anymore.
const MAX_FILE_BYTES = 30 * 1024 * 1024;

// pdfjs-dist's own Node canvas factory lazily `require()`s "@napi-rs/canvas"
// via `process.getBuiltinModule('module')` — a Node 22.3+-only API — and
// silently degrades (broken rendering, no thrown error) if that's
// unavailable. Importing @napi-rs/canvas directly here and polyfilling the
// couple of DOM globals pdf.js's renderer expects sidesteps that path
// entirely, so this only depends on @napi-rs/canvas itself actually
// installing/loading — no extra Node-version landmine beyond pdfjs-dist's
// own declared minimum.
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// Wall-clock budget for the OCR phase specifically, measured from handler
// entry — leaves headroom under vercel.json's 60s maxDuration for auth,
// Supabase Storage signed-URL/download round trips (which happen before we
// even know a given file needs OCR), the Tesseract worker's own startup
// (~1-2s, paid once per request and reused across pages/docs), and response
// serialization. Checked before every page render, not just once per
// document, so a truncation lands mid-document rather than only between
// documents.
const OCR_BUDGET_MS = 42000;
// Per-document page cap, independent of the time budget — without this, one
// long scanned original (leases here run 40-100+ pages) could consume the
// entire budget alone and leave zero time for a store's other documents
// (amendments/renewals), which are exactly the ones most likely to carry
// the CURRENT term. Lease term info is overwhelmingly on a document's early
// pages (opening recitals / signature-page term restatement), so this is a
// real trade of "read every page" for "read enough pages across every
// document to have a shot at all of them."
const MAX_OCR_PAGES_PER_DOC = 6;
// 2x PDF's 72dpi base ≈ 144dpi — matches what was verified locally to OCR
// cleanly against these real scans; lower is faster but blurs small print,
// higher roughly doubles render+recognize time for marginal gain.
const OCR_RENDER_SCALE = 2.0;

async function ocrPdfPages(buf, worker, deadline) {
  const data = new Uint8Array(buf);
  const loadingTask = getDocument({ data, canvasFactory: new NodeCanvasFactory(), verbosity: 0 });
  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages;
  const pageLimit = Math.min(totalPages, MAX_OCR_PAGES_PER_DOC);
  let text = '';
  let pagesScanned = 0;
  let truncatedForTime = false;
  try {
    for (let pageNum = 1; pageNum <= pageLimit; pageNum++) {
      if (Date.now() > deadline) { truncatedForTime = true; break; }
      const page = await pdfDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
      const canvasFactory = new NodeCanvasFactory();
      const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
      await page.render({ canvasContext: canvasAndContext.context, viewport, canvasFactory }).promise;
      const pngBuf = canvasAndContext.canvas.toBuffer('image/png');
      page.cleanup();
      const { data: ocrData } = await worker.recognize(pngBuf);
      text += '\n' + (ocrData.text || '');
      pagesScanned++;
    }
  } finally {
    await pdfDocument.destroy();
  }
  return { text, pagesScanned, totalPages, truncatedForTime };
}

// Tesseract's traineddata needs somewhere writable to cache to — Vercel's
// function filesystem is read-only outside /tmp. Left unset, tesseract.js
// would try to write next to itself in node_modules and fail with EROFS.
// Default cacheMethod ("write") means a cold start downloads
// eng.traineddata from tesseract.js's CDN once and a warm container reuses
// it from /tmp on subsequent requests in that same container's lifetime.
async function getOcrWorker() {
  return createWorker('eng', 1, { cachePath: '/tmp', logger: () => {} });
}

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

  const requestStart = Date.now();
  const ocrDeadline = requestStart + OCR_BUDGET_MS;
  let worker = null;
  let workerFailed = null; // set once if worker creation itself fails, so we don't retry it per-file

  try {
    const skipped = [];
    const noTextDocs = [];
    const ocrUsed = []; // { name, pagesScanned, totalPages, truncatedForTime }
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
        // No real text layer — almost always a scanned image page. Fall
        // back to OCR if there's still time budget left; otherwise (or if
        // OCR itself can't get going/comes back empty too) this document
        // stays unreadable, same as before.
        if (Date.now() >= ocrDeadline) {
          skipped.push({ name: file.name, reason: 'no text layer, and the time budget for OCR was already used up by earlier documents in this scan' });
          noTextDocs.push(file.name);
          continue;
        }
        if (!worker && !workerFailed) {
          try { worker = await getOcrWorker(); }
          catch (err) { workerFailed = err.message; }
        }
        if (!worker) {
          skipped.push({ name: file.name, reason: `no text layer, and OCR couldn't start (${workerFailed})` });
          noTextDocs.push(file.name);
          continue;
        }
        try {
          const ocrResult = await ocrPdfPages(buf, worker, ocrDeadline);
          text = ocrResult.text;
          ocrUsed.push({ name: file.name, pagesScanned: ocrResult.pagesScanned, totalPages: ocrResult.totalPages, truncatedForTime: ocrResult.truncatedForTime });
        } catch (err) {
          skipped.push({ name: file.name, reason: `OCR failed (${err.message})` });
          noTextDocs.push(file.name);
          continue;
        }
        if (text.trim().length < 20) {
          noTextDocs.push(file.name);
          continue;
        }
      }

      const { starts, ends } = findDateCandidates(text);
      ends.forEach(date => { if (!bestEnd || date > bestEnd.date) bestEnd = { date, doc: file.name }; });
      starts.forEach(date => { if (!bestStart || date < bestStart.date) bestStart = { date, doc: file.name }; });
    }

    if (!bestStart && !bestEnd) {
      const reason = noTextDocs.length
        ? `No lease-term dates could be located — ${noTextDocs.length} of ${files.length} document(s) had no extractable text even after OCR (likely scanned images too degraded to read, or ran out of time budget), and the rest didn't contain a recognizable commencement/expiration date near a date.`
        : `No lease-term dates could be located in these documents' text.`;
      res.status(200).json({ ok: true, result: null, skipped, noTextDocs, ocrUsed, message: reason });
      return;
    }

    const parts = [];
    if (bestStart) parts.push(`commencement date found in "${bestStart.doc}"`);
    if (bestEnd) parts.push(`expiration date found in "${bestEnd.doc}" (the furthest-out end date across all documents, on the theory that's the most recent renewal/amendment)`);
    if (ocrUsed.length) {
      const truncatedCount = ocrUsed.filter(o => o.truncatedForTime).length;
      parts.push(`OCR was used on ${ocrUsed.length} scanned document(s) with no text layer (${ocrUsed.map(o => `${o.pagesScanned}/${o.totalPages} pages read of "${o.name}"`).join('; ')})${truncatedCount ? ' — some were cut short by the scan time budget, re-run the scan if a date you expect is missing' : ''}`);
    }
    if (noTextDocs.length) parts.push(`${noTextDocs.length} document(s) still had no extractable text and weren't scanned`);

    res.status(200).json({
      ok: true,
      skipped,
      noTextDocs,
      ocrUsed,
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
  } finally {
    if (worker) { try { await worker.terminate(); } catch { /* best-effort cleanup */ } }
  }
}
