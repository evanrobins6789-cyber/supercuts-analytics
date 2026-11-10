import React, { useEffect, useMemo, useState } from 'react';
import { couponStats } from './auth';

// ─── Coupons (owner only) ──────────────────────────────────────────────────
// Numbers from the ad coupon landing pages (separate site and repo:
// Documents/landing-pages). Each ad links to its own offer page; the page
// records what people do there and this tab asks for the totals through
// api/_coupon-stats.js (server to server, shared secret).
//
// Events (landing-pages/supabase-tracking.sql):
//   view          opened the offer page
//   screenshot    tapped "No thanks, just show the coupon to screenshot"
//                 (a tap, not proof they took a screenshot: phones don't tell websites that)
//   email_signup  new email signup (one per email per offer)
//   email_repeat  same email signed up again (got the same code)
//   email_sent    the coupon email actually went out (needs the landing site's Resend setup)
//   email_again   tapped "Email me this coupon" after screenshotting
//   book_click    tapped Book Now (opens supercuts.com's booking page)
// Browser events count people (a random id per browser), server events count signups.

const PEOPLE_EVENTS = new Set(['view', 'screenshot', 'email_again', 'book_click']);

export const COUPON_COLUMNS = [
  { key: 'view', label: 'Page views', hint: 'People who opened the offer page' },
  { key: 'screenshot', label: 'Screenshot', hint: 'Tapped "show the coupon to screenshot"' },
  { key: 'email_signup', label: 'Email signups', hint: 'New emails (one code per email)' },
  { key: 'email_sent', label: 'Emails sent', hint: 'Coupon emails that went out' },
  { key: 'book_click', label: 'Book Now', hint: 'Tapped Book Now' },
];

const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function daysAgoISO(n) { const d = new Date(); d.setDate(d.getDate() - n); return localISO(d); }

export function couponPresets() {
  const now = new Date();
  const today = localISO(now);
  return [
    { label: 'Today', start: today, end: today },
    { label: 'Last 7 days', start: daysAgoISO(6), end: today },
    { label: 'Last 30 days', start: daysAgoISO(29), end: today },
    { label: 'This month', start: localISO(new Date(now.getFullYear(), now.getMonth(), 1)), end: today },
    { label: 'Last 90 days', start: daysAgoISO(89), end: today },
  ];
}

const emptyCounts = () => ({ view: 0, screenshot: 0, email_signup: 0, email_repeat: 0, email_sent: 0, email_again: 0, book_click: 0 });

// Rolls the landing site's rows up into { total, byOffer, bySource, byDay }.
// People events add visitors, server events add totals.
export function summarizeCoupons(data, offerFilter = '') {
  const total = emptyCounts();
  const byOffer = {};
  const bySource = {};
  const byDay = {};
  const want = r => !offerFilter || r.offer_slug === offerFilter;
  const amount = r => Number(PEOPLE_EVENTS.has(r.event) ? r.visitors : r.total) || 0;
  for (const r of (data?.summary || [])) {
    if (!want(r) || !(r.event in total)) continue;
    const n = amount(r);
    total[r.event] += n;
    (byOffer[r.offer_slug] ||= emptyCounts())[r.event] += n;
    (bySource[r.source || ''] ||= emptyCounts())[r.event] += n;
  }
  for (const r of (data?.daily || [])) {
    if (!want(r) || !(r.event in total)) continue;
    (byDay[r.day] ||= emptyCounts())[r.event] += amount(r);
  }
  return { total, byOffer, bySource, byDay };
}

// Share of page viewers who took the coupon (screenshot or email). Can pass 100%
// a little if someone does both; email_again is the overlap we can see.
export function claimRate(c) {
  if (!c.view) return null;
  return Math.max(0, c.screenshot + c.email_signup - c.email_again) / c.view;
}

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const sourceLabel = s => (s ? s : '(no ad tag)');

// Text block for Tilly (src/App.js extraContext). data = last 30 days.
export function couponsContext(data) {
  if (!data || !data.summary) return '';
  const { total, byOffer, bySource } = summarizeCoupons(data);
  const name = slug => data.offers?.find(o => o.slug === slug)?.headline || slug;
  const line = c => `${c.view} page views, ${c.screenshot} screenshot taps, ${c.email_signup} email signups (${c.email_sent} emailed), ${c.book_click} Book Now taps, claim rate ${pct(claimRate(c))}`;
  const out = [`AD COUPON LANDING PAGES (owner only; ${data.from} to ${data.to}; separate site, counts people not taps for views/screenshots/Book Now): ${line(total)}.`];
  for (const [slug, c] of Object.entries(byOffer)) out.push(`- Offer "${name(slug)}" (${slug}): ${line(c)}.`);
  const sources = Object.entries(bySource).filter(([, c]) => c.view);
  if (sources.length) out.push(`By ad source: ${sources.map(([s, c]) => `${sourceLabel(s)} ${c.view} views / ${c.screenshot + c.email_signup} claims`).join('; ')}.`);
  const samples = (data.offers || []).filter(o => o.sample).map(o => o.slug);
  if (samples.length) out.push(`Sample (not real yet) offers: ${samples.join(', ')}.`);
  out.push('A "screenshot" is a tap on the screenshot button, not proof a screenshot was taken.');
  return out.join('\n');
}

function CountsRow({ label, c, first }) {
  return (
    <tr>
      <td style={{ textAlign: 'left' }}>{first || label}</td>
      {COUPON_COLUMNS.map(col => <td key={col.key}>{c[col.key].toLocaleString()}</td>)}
      <td>{pct(claimRate(c))}</td>
    </tr>
  );
}

function CountsTable({ title, rows, firstHeader }) {
  return (
    <div className="chart-card">
      <p className="chart-title">{title}</p>
      {rows.length === 0 ? <p className="empty-note">Nothing in this date range.</p> : (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{firstHeader}</th>
                {COUPON_COLUMNS.map(col => <th key={col.key} title={col.hint}>{col.label}</th>)}
                <th title="Screenshot taps + new email signups, as a share of page views">Claim rate</th>
              </tr>
            </thead>
            <tbody>{rows.map(([key, label, c]) => <CountsRow key={key} label={label} c={c} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CouponsTab({ token }) {
  const presets = useMemo(() => couponPresets(), []);
  const [range, setRange] = useState({ start: presets[2].start, end: presets[2].end });
  const [offerFilter, setOfferFilter] = useState('');
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let live = true;
    if (!range.start || !range.end || range.start > range.end) return undefined;
    setState(s => ({ ...s, loading: true, error: null }));
    couponStats(token, range.start, range.end).then(res => {
      if (!live) return;
      if (!res.ok) setState({ loading: false, error: res.error, data: null });
      else setState({ loading: false, error: null, data: res });
    });
    return () => { live = false; };
  }, [token, range.start, range.end]);

  const data = state.data;
  const offers = data?.offers || [];
  const offerName = slug => offers.find(o => o.slug === slug)?.headline || slug;
  const s = useMemo(() => summarizeCoupons(data, offerFilter), [data, offerFilter]);
  const offerRows = Object.entries(s.byOffer)
    .sort((a, b) => b[1].view - a[1].view)
    .map(([slug, c]) => {
      const o = offers.find(x => x.slug === slug);
      const tags = [o?.sample && 'sample', o && !o.live && 'ended'].filter(Boolean);
      return [slug, `${offerName(slug)}${tags.length ? ` (${tags.join(', ')})` : ''}`, c];
    });
  const sourceRows = Object.entries(s.bySource).sort((a, b) => b[1].view - a[1].view).map(([src, c]) => [src || '_', sourceLabel(src), c]);
  const dayRows = Object.entries(s.byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, c]) => [day, day, c]);
  const t = s.total;

  return (
    <div className="tab-content">
      <p className="section-hint">
        Only you can see this tab. These numbers come from the ad coupon pages (supercuts-landing-pages). Views, screenshots
        and Book Now count <strong>people</strong> (once per phone or browser), not taps. "Screenshot" means they tapped the
        screenshot button. Phones don't tell websites when a screenshot is actually taken.
      </p>

      <div className="date-range-bar">
        <span className="date-range-label">Dates</span>
        <input className="date-range-input" type="date" value={range.start} max={range.end} onChange={e => setRange(r => ({ ...r, start: e.target.value }))} />
        <span className="date-range-to">to</span>
        <input className="date-range-input" type="date" value={range.end} min={range.start} onChange={e => setRange(r => ({ ...r, end: e.target.value }))} />
        {presets.map(p => (
          <button key={p.label} type="button" className="date-range-quick-btn" onClick={() => setRange({ start: p.start, end: p.end })}>{p.label}</button>
        ))}
        {offers.length > 1 && (
          <select className="date-range-input" value={offerFilter} onChange={e => setOfferFilter(e.target.value)}>
            <option value="">All offers</option>
            {offers.map(o => <option key={o.slug} value={o.slug}>{o.headline}{o.sample ? ' (sample)' : ''}</option>)}
          </select>
        )}
      </div>

      {state.error && <p className="empty-note lp-error">Couldn't load coupon numbers: {state.error}</p>}
      {state.loading && !data && <p className="empty-note">Loading coupon numbers…</p>}

      {data && (
        <>
          <div className="summary-grid">
            {COUPON_COLUMNS.map(col => (
              <div key={col.key} className="summary-tile" title={col.hint} style={{ cursor: 'default' }}>
                <p className="summary-tile-label">{col.label}</p>
                <p className="summary-tile-value">{t[col.key].toLocaleString()}</p>
              </div>
            ))}
            <div className="summary-tile" style={{ cursor: 'default' }} title="Screenshot taps + new email signups, as a share of page views">
              <p className="summary-tile-label">Claim rate</p>
              <p className="summary-tile-value">{pct(claimRate(t))}</p>
              <p className="summary-tile-sub">{(t.screenshot + t.email_signup - t.email_again).toLocaleString()} coupons claimed</p>
            </div>
          </div>
          {(t.email_repeat > 0 || t.email_again > 0) && (
            <p className="section-hint">
              Also: {t.email_repeat} repeat email signups (same email again, same code) and {t.email_again} people who
              screenshotted first and then asked for the email (taken out of "coupons claimed" so they count once).
            </p>
          )}
          <CountsTable title="By offer (each ad's link)" firstHeader="Offer" rows={offerRows} />
          <CountsTable title="By ad source (the ?utm_source= tag on the ad link)" firstHeader="Source" rows={sourceRows} />
          <CountsTable title="By day" firstHeader="Day" rows={dayRows} />
        </>
      )}
    </div>
  );
}
