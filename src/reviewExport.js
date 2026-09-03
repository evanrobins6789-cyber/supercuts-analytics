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

function starString(rating) {
  const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length > 10 ? iso : `${iso}T00:00:00`);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// `reviews` — already-filtered/sorted array (whatever the Reviews tab is
// currently showing for this store: respects the active date range plus
// any category/sentiment/"mentioned only" narrowing), each with
// `employeeMatch` (string|null) and `notes` ([{at, text}]) already attached
// — see exportStoreReviewsPDF in App.js, which builds this shape right
// before calling here so this module stays UI-agnostic.
export async function exportReviewsToPDF({ storeName, reviews, dateRange, filterLabels }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  let y = PAGE_MARGIN;

  const ensureRoom = needed => {
    if (y + needed > PAGE_HEIGHT - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
  };
  const writeLines = (lines, { size = 10, lineHeight = 13, font = 'helvetica', style = 'normal', color = '#222222' } = {}) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    lines.forEach(line => {
      ensureRoom(lineHeight);
      doc.text(line, PAGE_MARGIN, y);
      y += lineHeight;
    });
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor('#111111');
  doc.text(`${storeName} — Customer Reviews`, PAGE_MARGIN, y);
  y += 22;

  const rangeLabel = dateRange?.start && dateRange?.end
    ? `${fmtDate(dateRange.start)} – ${fmtDate(dateRange.end)}`
    : 'All time';
  const subLines = [`Period: ${rangeLabel}`];
  if (filterLabels && filterLabels.length) subLines.push(`Filters: ${filterLabels.join(', ')}`);
  subLines.push(`Generated: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  writeLines(subLines, { size: 10, lineHeight: 14, style: 'normal', color: '#555555' });
  y += 4;

  const total = reviews.length;
  const avg = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
  writeLines([`${total} review${total !== 1 ? 's' : ''} shown — average rating ${avg.toFixed(2)} / 5`], { size: 11, style: 'bold', color: '#111111' });
  y += 6;
  ensureRoom(1);
  doc.setDrawColor('#cccccc');
  doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
  y += 16;

  if (!total) {
    writeLines(['No reviews match the current view.'], { style: 'italic', color: '#777777' });
  }

  reviews.forEach((r, idx) => {
    ensureRoom(40); // keep a review's head line + at least one body line together
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor('#111111');
    doc.text(starString(r.rating), PAGE_MARGIN, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor('#555555');
    doc.text(`${r.userName || 'Anonymous'}  ·  ${fmtDate(r.postedAt)}`, PAGE_MARGIN + 70, y);
    y += 16;

    if (r.message) {
      const wrapped = doc.splitTextToSize(r.message, CONTENT_WIDTH);
      writeLines(wrapped, { size: 10, lineHeight: 13, color: '#222222' });
    }

    if (r.employeeMatch) {
      writeLines([`Mentions: ${r.employeeMatch}`], { size: 9, style: 'italic', color: '#8a5a00' });
    }

    if (r.notes && r.notes.length) {
      writeLines(['Staff follow-up:'], { size: 9, style: 'bold', color: '#333333' });
      r.notes.forEach(n => {
        const noteWrapped = doc.splitTextToSize(`• ${fmtDate(n.at)} — ${n.text}`, CONTENT_WIDTH - 10);
        writeLines(noteWrapped, { size: 9, color: '#333333' });
      });
    }

    y += 10;
    if (idx < reviews.length - 1) {
      ensureRoom(1);
      doc.setDrawColor('#e5e5e5');
      doc.line(PAGE_MARGIN, y - 6, PAGE_WIDTH - PAGE_MARGIN, y - 6);
    }
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(storeName).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  doc.save(`${safeName}-reviews-${stamp}.pdf`);
}
