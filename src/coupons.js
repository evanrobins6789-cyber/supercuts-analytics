import React, { useEffect, useMemo, useState } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { couponStats } from './auth';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip);

// ─── Coupons (owner only) ──────────────────────────────────────────────────
// Numbers from the ad coupon landing pages (separate site and repo:
// Documents/landing-pages). Each ad links to its own offer page; the page
// records what people do there and this tab asks for the totals through
// api/_coupon-stats.js (server to server, shared secret).
//
// Events (landing-pages/supabase-tracking.sql):
//   view          opened the offer page
//   screenshot    tapped "No thanks, just show the coupon to screenshot". Only in
//                 data from before 2026-11-16: the popup is gone, so no new ones.
//   email_signup  new email signup (one per email per offer)
//   email_repeat  same email signed up again (got the same code)
//   email_sent    the coupon email actually went out
//   email_again   (old) tapped "Email me this coupon" after screenshotting
//   book_click    tapped Book Now (opens supercuts.com's booking page)
// Page views count every visit; `viewers` is the unique count (a random id per
// browser) and is what every % is "of". Screenshot/Book Now count people.

const PEOPLE_EVENTS = new Set(['screenshot', 'email_again', 'book_click']);

// Chart colors: the dataviz skill's reference categorical slots 1-3, validated
// all-pairs for color blindness (2026-11-16). Aqua is under 3:1 contrast, so the
// chart always has a legend and the By day table is the readable fallback.
const SERIES = [
  { key: 'view', label: 'Page views', color: '#2a78d6' },
  { key: 'email_signup', label: 'Email signups', color: '#eb6834' },
  { key: 'book_click', label: 'Book Now taps', color: '#1baf7a' },
];

// utm_source tags are saved lowercased; show them the way people write them.
const SOURCE_NAMES = {
  facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', ig: 'Instagram', google: 'Google',
  tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', nextdoor: 'Nextdoor', twitter: 'Twitter',
  x: 'X', snapchat: 'Snapchat', pinterest: 'Pinterest', yelp: 'Yelp', bing: 'Bing', email: 'Email',
  sms: 'Text message', text: 'Text message', qr: 'QR code', flyer: 'Flyer', mailer: 'Mailer', poster: 'Poster',
};
// Nicknames folded into one source, so "fb" and "facebook" are one row.
const SOURCE_ALIAS = { fb: 'facebook', ig: 'instagram', text: 'sms' };
const sourceKey = s => SOURCE_ALIAS[String(s || '').toLowerCase()] || String(s || '').toLowerCase();

export function sourceLabel(s) {
  if (!s) return 'No ad tag';
  const k = String(s).toLowerCase();
  if (SOURCE_NAMES[k]) return SOURCE_NAMES[k];
  return k.split(/[-_\s.]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

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

const emptyCounts = () => ({ view: 0, viewers: 0, screenshot: 0, email_signup: 0, email_repeat: 0, email_sent: 0, email_again: 0, book_click: 0 });

// Rolls the landing site's rows up into { total, byOffer, bySource, byDay }.
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
    const v = r.event === 'view' ? Number(r.visitors) || 0 : 0;
    for (const c of [total, byOffer[r.offer_slug] ||= emptyCounts(), bySource[sourceKey(r.source)] ||= emptyCounts()]) {
      c[r.event] += n;
      c.viewers += v;
    }
  }
  for (const r of (data?.daily || [])) {
    if (!want(r) || !(r.event in total)) continue;
    const c = byDay[r.day] ||= emptyCounts();
    c[r.event] += amount(r);
    if (r.event === 'view') c.viewers += Number(r.visitors) || 0;
  }
  return { total, byOffer, bySource, byDay };
}

// Share of unique visitors (falls back to page views if there's no unique count).
export function rateOf(n, c) {
  const people = c.viewers || c.view;
  return people ? n / people : null;
}
// Coupons claimed: new email signups, plus old screenshot taps (minus the overlap we can see).
const claimed = c => Math.max(0, c.screenshot + c.email_signup - c.email_again);
export function claimRate(c) { return rateOf(claimed(c), c); }

const pct = v => (v == null ? '—' : `${v >= 0.095 || v === 0 ? Math.round(v * 100) : (v * 100).toFixed(1)}%`);
const num = n => Number(n || 0).toLocaleString();

// Text block for Tilly (src/App.js extraContext). data = last 30 days.
export function couponsContext(data) {
  if (!data || !data.summary) return '';
  const { total, byOffer, bySource } = summarizeCoupons(data);
  const name = slug => data.offers?.find(o => o.slug === slug)?.headline || slug;
  const line = c => `${c.view} page views (${c.viewers} unique visitors), ${c.email_signup} email signups (${pct(rateOf(c.email_signup, c))} of visitors; ${c.email_sent} emails sent), ${c.book_click} Book Now taps (${pct(rateOf(c.book_click, c))} of visitors)${c.screenshot ? `, ${c.screenshot} old screenshot taps` : ''}`;
  const out = [`AD COUPON LANDING PAGES (owner only; ${data.from} to ${data.to}; separate site; page views count every visit, % are of unique visitors; the coupon shows without a popup since 2026-11-16, so no new screenshot taps): ${line(total)}.`];
  for (const [slug, c] of Object.entries(byOffer)) out.push(`- Offer "${name(slug)}" (${slug}): ${line(c)}.`);
  const sources = Object.entries(bySource).filter(([, c]) => c.view);
  if (sources.length) out.push(`Where visits came from (utm_source on the ad link): ${sources.map(([s, c]) => `${sourceLabel(s)} ${c.view} views (${pct(total.view ? c.view / total.view : null)}), ${c.email_signup} signups, ${c.book_click} Book Now`).join('; ')}.`);
  const samples = (data.offers || []).filter(o => o.sample).map(o => o.slug);
  if (samples.length) out.push(`Sample (not real yet) offers: ${samples.join(', ')}.`);
  return out.join('\n');
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Tile({ label, value, sub, hint }) {
  return (
    <div className="summary-tile" title={hint} style={{ cursor: 'default' }}>
      <p className="summary-tile-label">{label}</p>
      <p className="summary-tile-value">{value}</p>
      {sub && <p className="summary-tile-sub">{sub}</p>}
    </div>
  );
}

// Every day in the range, oldest first, so quiet days show as 0 instead of being skipped.
function daysBetween(start, end) {
  const out = [];
  const d = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (d <= last && out.length < 400) { out.push(localISO(d)); d.setDate(d.getDate() + 1); }
  return out;
}
const shortDay = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function DailyChart({ byDay, start, end }) {
  const days = daysBetween(start, end);
  const data = {
    labels: days.map(shortDay),
    datasets: SERIES.map(s => ({
      label: s.label,
      data: days.map(d => byDay[d]?.[s.key] || 0),
      borderColor: s.color,
      backgroundColor: s.color,
      borderWidth: 2,
      pointRadius: days.length > 31 ? 0 : 3,
      pointHoverRadius: 5,
      pointBorderColor: '#fff',
      pointBorderWidth: 2,
      tension: 0.25,
    })),
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { padding: 10, boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#5A6B80', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      y: { beginAtZero: true, grid: { color: '#EEF1F4' }, border: { display: false }, ticks: { color: '#5A6B80', precision: 0, maxTicksLimit: 5 } },
    },
  };
  return (
    <div className="chart-card">
      <p className="chart-title">By day</p>
      <div className="coupon-legend">
        {SERIES.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <div className="coupon-chart"><Line data={data} options={options} /></div>
    </div>
  );
}

// "Where visits came from": one bar per ad source, length = share of page views.
function SourceBars({ bySource, total }) {
  const rows = Object.entries(bySource).filter(([, c]) => c.view || c.email_signup || c.book_click)
    .sort((a, b) => b[1].view - a[1].view);
  const max = Math.max(1, ...rows.map(([, c]) => c.view));
  return (
    <div className="chart-card">
      <p className="chart-title">Where visits came from</p>
      {rows.length === 0 ? <p className="empty-note">No visits in this date range.</p> : (
        <div className="source-bars">
          {rows.map(([src, c]) => (
            <div key={src || '_'} className="source-bar-row" title={`${sourceLabel(src)}: ${num(c.view)} page views, ${num(c.email_signup)} email signups (${pct(rateOf(c.email_signup, c))}), ${num(c.book_click)} Book Now (${pct(rateOf(c.book_click, c))})`}>
              <span className="source-bar-name">{sourceLabel(src)}</span>
              <span className="source-bar-track"><span className="source-bar-fill" style={{ width: `${(c.view / max) * 100}%` }} /></span>
              <span className="source-bar-value"><strong>{pct(total.view ? c.view / total.view : null)}</strong> · {num(c.view)}</span>
            </div>
          ))}
          <p className="source-bar-note">Share of page views. Tag each ad's link with <code>?utm_source=facebook</code> (or google, instagram, flyer…) to see it here.</p>
        </div>
      )}
    </div>
  );
}

function CountsTable({ title, rows, firstHeader, showScreenshot }) {
  return (
    <div className="chart-card">
      <p className="chart-title">{title}</p>
      {rows.length === 0 ? <p className="empty-note">Nothing in this date range.</p> : (
        <div className="ledger-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>{firstHeader}</th>
                <th title="Every visit, repeat visits included">Page views</th>
                <th title="Different phones/browsers">Unique visitors</th>
                <th title="New email signups">Email signups</th>
                <th title="Email signups as a % of unique visitors">Email %</th>
                <th title="People who tapped Book Now">Book Now</th>
                <th title="Book Now taps as a % of unique visitors">Book %</th>
                <th title="Coupon emails that went out">Emails sent</th>
                {showScreenshot && <th title="Old screenshot-button taps (before the popup was removed)">Screenshot</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, label, c]) => (
                <tr key={key}>
                  <td style={{ textAlign: 'left' }}>{label}</td>
                  <td>{num(c.view)}</td>
                  <td>{num(c.viewers)}</td>
                  <td>{num(c.email_signup)}</td>
                  <td>{pct(rateOf(c.email_signup, c))}</td>
                  <td>{num(c.book_click)}</td>
                  <td>{pct(rateOf(c.book_click, c))}</td>
                  <td>{num(c.email_sent)}</td>
                  {showScreenshot && <td>{num(c.screenshot)}</td>}
                </tr>
              ))}
            </tbody>
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
  const dayRows = Object.entries(s.byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, c]) => [day, shortDay(day), c]);
  const t = s.total;
  const showScreenshot = t.screenshot > 0;
  const requested = t.email_signup + t.email_repeat;

  return (
    <div className="tab-content">
      <p className="section-hint">
        Only you can see this tab. These numbers come from the ad coupon pages (supercutsoffer.com). Page views count
        every visit; the percentages are out of <strong>unique visitors</strong> (different phones or browsers).
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
            <Tile label="Page views" value={num(t.view)} sub={`${num(t.viewers)} unique visitors`} hint="Every visit to the offer page, repeat visits included" />
            <Tile label="Email signups" value={num(t.email_signup)} sub={`${pct(rateOf(t.email_signup, t))} of visitors`} hint="New emails, as a share of unique visitors" />
            <Tile label="Book Now taps" value={num(t.book_click)} sub={`${pct(rateOf(t.book_click, t))} of visitors`} hint="People who tapped Book Now, as a share of unique visitors" />
            <Tile label="Emails sent" value={num(t.email_sent)} sub={requested ? `${pct(t.email_sent / requested)} delivered` : 'none requested'} hint="Coupon emails that went out, out of every email request (repeats included)" />
          </div>
          {(t.email_repeat > 0 || showScreenshot) && (
            <p className="section-hint">
              {t.email_repeat > 0 && <>Also {num(t.email_repeat)} repeat email requests (same email again). </>}
              {showScreenshot && <>{num(t.screenshot)} screenshot-button taps are from before the popup was removed; there won't be new ones.</>}
            </p>
          )}
          <div className="coupon-chart-grid">
            <DailyChart byDay={s.byDay} start={range.start} end={range.end} />
            <SourceBars bySource={s.bySource} total={t} />
          </div>
          <CountsTable title="By ad source (the ?utm_source= tag on the ad link)" firstHeader="Source" rows={sourceRows} showScreenshot={showScreenshot} />
          <CountsTable title="By offer (each ad's link)" firstHeader="Offer" rows={offerRows} showScreenshot={showScreenshot} />
          <CountsTable title="By day" firstHeader="Day" rows={dayRows} showScreenshot={showScreenshot} />
        </>
      )}
    </div>
  );
}
