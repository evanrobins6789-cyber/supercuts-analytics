// Client-side PDF export for a single store's reviews (Reviews tab "Export
// PDF" button) — runs entirely in the browser via jsPDF, no server round
// trip and no API spend, same reasoning that pushed lease-date scanning off
// the Anthropic API and onto free local processing (see HANDOFF.md).
//
// jsPDF (~130KB gzipped, mostly embedded font metrics) is dynamically
// imported inside exportReviewsToPDF below rather than at module load —
// every user pays for parser.js/App.js on first load regardless of role,
// and most roles (employee, most managers day-to-day) never click Export,
// so a static top-level import would bloat the main bundle for everyone to
// serve a District-Leader/owner-only feature. Only the person who actually
// clicks Export fetches this chunk.

const NAVY = '#142A4A';
const GOLD = '#C9A227';
const GREEN = '#2E7D4F';
const RED = '#C23B3B';
const PAPER = '#F4F6F8';
const LINE = '#E1E7ED';
const INK = '#1A2433';
const INK_SOFT = '#5A6B80';

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const HEADER_HEIGHT = 56;
const FOOTER_SAFE = 30;

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00`);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Standard 5-point star, drawn as a real vector path rather than the ★/☆
// Unicode glyphs — jsPDF's built-in "helvetica" font is the base WinAnsi
// standard font with no glyph for U+2605/2606, so those characters were
// silently substituted with "&" in the first version of this export.
function starPoints(cx, cy, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts;
}
function drawStar(doc, cx, cy, outerR, innerR, style) {
  const pts = starPoints(cx, cy, outerR, innerR);
  const [sx, sy] = pts[0];
  const deltas = [];
  for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  doc.lines(deltas, sx, sy, [1, 1], style, true);
}
function drawStarRow(doc, x, y, rating, { outerR = 5, innerR = 2, gap = 13 } = {}) {
  const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
  for (let i = 0; i < 5; i++) {
    const cx = x + outerR + i * gap;
    if (i < r) {
      doc.setFillColor(GOLD);
      doc.setDrawColor(GOLD);
      drawStar(doc, cx, y, outerR, innerR, 'F');
    } else {
      doc.setDrawColor(GOLD);
      doc.setFillColor('#ffffff');
      drawStar(doc, cx, y, outerR, innerR, 'S');
    }
  }
  return x + 5 * gap + 4; // x position right after the star row
}

function toneColor(rating) {
  if (rating <= 2) return RED;
  if (rating >= 4) return GREEN;
  return GOLD;
}

// `reviews` — already-filtered/sorted array (whatever the Reviews tab is
// currently showing for this store: respects the active date range plus
// any category/sentiment/"mentioned only" narrowing), each with
// `employeeMatch` (string|null) and `notes` ([{at, text}]) already attached
// — see exportStoreReviewsPDF in App.js, which builds this shape right
// before calling here so this module stays UI-agnostic.
export async function exportReviewsToPDF({ storeName, reviews, dateRange, filterLabels }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  const rangeLabel = dateRange?.start && dateRange?.end
    ? `${fmtDate(dateRange.start)} – ${fmtDate(dateRange.end)}`
    : 'All time';
  const total = reviews.length;
  const avg = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
  const generatedStamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const drawHeader = () => {
    doc.setFillColor(NAVY);
    doc.rect(0, 0, PAGE_WIDTH, HEADER_HEIGHT, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.setTextColor('#ffffff');
    doc.text(storeName, PAGE_MARGIN, 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor('#B9C6D6');
    doc.text('Customer Reviews', PAGE_MARGIN, 42);
    doc.setFontSize(9);
    doc.text(rangeLabel, PAGE_WIDTH - PAGE_MARGIN, 28, { align: 'right' });
    doc.text(`${total} review${total !== 1 ? 's' : ''}`, PAGE_WIDTH - PAGE_MARGIN, 42, { align: 'right' });
  };

  const drawFooter = pageNum => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor('#9AA7B4');
    doc.text(`Generated ${generatedStamp}`, PAGE_MARGIN, PAGE_HEIGHT - 16);
    doc.text(`Page ${pageNum} of {total_pages}`, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 16, { align: 'right' });
  };

  let y = HEADER_HEIGHT + 22;
  let pageNum = 1;
  drawHeader();

  const newPage = () => {
    drawFooter(pageNum);
    doc.addPage();
    pageNum += 1;
    y = HEADER_HEIGHT + 22;
    drawHeader();
  };
  const ensureRoom = needed => {
    if (y + needed > PAGE_HEIGHT - FOOTER_SAFE) newPage();
  };

  // ── Intro: period / filters + a couple of summary stat cards ──────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(INK_SOFT);
  if (filterLabels && filterLabels.length) {
    doc.text(`Filters: ${filterLabels.join(' · ')}`, PAGE_MARGIN, y);
    y += 16;
  }

  const cardW = 160, cardH = 44, cardGap = 12;
  doc.setDrawColor(LINE);
  doc.setFillColor('#ffffff');
  doc.roundedRect(PAGE_MARGIN, y, cardW, cardH, 6, 6, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(INK_SOFT);
  doc.text('TOTAL REVIEWS', PAGE_MARGIN + 12, y + 17);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(NAVY);
  doc.text(String(total), PAGE_MARGIN + 12, y + 35);

  const card2X = PAGE_MARGIN + cardW + cardGap;
  doc.setDrawColor(LINE);
  doc.setFillColor('#ffffff');
  doc.roundedRect(card2X, y, cardW, cardH, 6, 6, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(INK_SOFT);
  doc.text('AVERAGE RATING', card2X + 12, y + 17);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(NAVY);
  doc.text(avg.toFixed(2), card2X + 12, y + 35);
  if (total) drawStarRow(doc, card2X + 48, y + 31, avg, { outerR: 4.5, innerR: 1.8, gap: 11 });

  y += cardH + 20;

  if (!total) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(INK_SOFT);
    doc.text('No reviews match the current view.', PAGE_MARGIN, y);
  }

  // ── One rounded card per review ────────────────────────────────────────
  reviews.forEach(r => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const messageLines = r.message ? doc.splitTextToSize(r.message, CONTENT_WIDTH - 26) : [];
    doc.setFontSize(8.3);
    const noteLineGroups = (r.notes || []).map(n => doc.splitTextToSize(`•  ${fmtDate(n.at)} — ${n.text}`, CONTENT_WIDTH - 34));

    const headRowH = 20;
    const msgH = messageLines.length * 12.5;
    const mentionH = r.employeeMatch ? 14 : 0;
    const notesH = noteLineGroups.length ? 12 + noteLineGroups.reduce((s, ls) => s + ls.length * 11, 0) : 0;
    const padTop = 12, padBottom = 12;
    const boxH = padTop + headRowH + msgH + mentionH + notesH + padBottom;

    ensureRoom(boxH + 10);

    const boxY = y;
    doc.setFillColor(PAPER);
    doc.setDrawColor(LINE);
    doc.roundedRect(PAGE_MARGIN, boxY, CONTENT_WIDTH, boxH, 5, 5, 'FD');
    doc.setFillColor(toneColor(r.rating));
    doc.roundedRect(PAGE_MARGIN, boxY, 4, boxH, 2, 2, 'F');

    let cy = boxY + padTop;
    const textX = PAGE_MARGIN + 16;
    const starsRightEdge = drawStarRow(doc, textX, cy - 2, r.rating);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(INK);
    doc.text(r.userName || 'Anonymous', starsRightEdge + 6, cy + 2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(INK_SOFT);
    doc.text(fmtDate(r.postedAt), PAGE_MARGIN + CONTENT_WIDTH - 16, cy + 2, { align: 'right' });
    cy += headRowH;

    if (messageLines.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(INK);
      messageLines.forEach(line => { doc.text(line, textX, cy + 8); cy += 12.5; });
    }

    if (r.employeeMatch) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor('#8a5a00');
      doc.text(`Mentions: ${r.employeeMatch}`, textX, cy + 8);
      cy += mentionH;
    }

    if (noteLineGroups.length) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.3);
      doc.setTextColor(INK_SOFT);
      doc.text('Staff follow-up', textX, cy + 8);
      cy += 12;
      doc.setFont('helvetica', 'normal');
      noteLineGroups.forEach(lines => {
        lines.forEach(line => { doc.text(line, textX, cy + 6); cy += 11; });
      });
    }

    y = boxY + boxH + 10;
  });

  drawFooter(pageNum);
  if (typeof doc.putTotalPages === 'function') doc.putTotalPages('{total_pages}');

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(storeName).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  doc.save(`${safeName}-reviews-${stamp}.pdf`);
}
