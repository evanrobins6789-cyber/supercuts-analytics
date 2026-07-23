# Handoff — Supercuts Analytics

Last updated: 2026-07-23, end of session adding the Homepage tab (see below). Prior sessions' historical-import fix and Milestone Goals / celebration popup / manager roster features are all shipped and on `main` (see `git log`).

## What this app is
A Store Scoreboard / analytics dashboard for a Supercuts franchise (React SPA, Supabase-backed, deployed on Vercel). Tabs: Homepage (landing page — new this session), Overview, Stores, Employees, Retail, Color Sales, DL, 60 Day Employee, Reviews, Weekly, and Setup (which also holds Goals / Managers / Milestone Goals / Historical Import / Upload as sub-sections). Has an in-app AI assistant, "Tilly," that answers questions about the business data via a serverless Anthropic API proxy (`api/chat.js`).

## What shipped this session
- **Homepage tab** — now the default landing tab (`TABS` in `App.js` starts with it; `tab` state defaults to `'Homepage'`). First-time users with no report uploaded still get redirected to Setup > Upload on load, same as before.
  - **News & Updates** and **Upcoming Events** — user-editable feeds, no password gate (same philosophy as the Managers feature: simple, in-app, no file upload needed). Persisted as `homepage_news` (array, newest first) and `homepage_events` (array, sorted by date) via the standard `loadData`/`saveData` pattern in `db.js`. CRUD handlers: `handleAddNews`/`handleDeleteNews`/`handleAddEvent`/`handleDeleteEvent` in `App.js`. Past events are visually deprioritized (dimmed + "Past" tag) but not auto-deleted.
  - **Top 10 sidebar widgets** — four `TopTenChart` bar charts (Retail, Color Sales, CPH, TSTH), built with `chart.js`/`react-chartjs-2` (already in `package.json` but previously unused — no new dependency added). Horizontal bar, one hue per widget, top-3 bars get a medal emoji baked into the label, value labeled at the bar tip. Followed the project's `dataviz` skill guidance: single-series charts get no legend box, gridlines are hairline/recessive, bar ends are 4px-rounded, colors are flat brand hexes pulled from the existing `:root` palette in `App.css` (no new palette introduced).
  - **PNG export** — each widget has a "⬇ PNG" button that calls the chart.js instance's `toBase64Image()` via a ref and triggers a download. A small custom plugin (`homepagePngBg`) paints a white background first, since a chart.js canvas is transparent by default and an exported PNG with no background looks broken when dropped into Slack/email.
  - Wired into Tilly's context (`buildAIContext`) as "NEWS & UPDATES" and "UPCOMING/RECENT EVENTS" sections, and threaded through `AIChatWidget`'s props — per the standing rule to always wire new data sources into Tilly in the same change.

## Known limitations (deliberate, not oversights)
- Tilly's historical data is **month-level only** — no day/week granularity in her context (the context itself tells her this, so she should say so rather than guess).
- Review text sent to Tilly is capped at the 40 most recent negative / 15 most recent positive reviews — aggregates/counts are complete and uncapped, only raw quotes are bounded.
- Sales-Accrual historical imports only attribute retail to an employee if the source file's "Sold By" (or "Stylist") column has a value — if neither is populated, retail stays store-level only. Already-imported months need to be re-uploaded to backfill per-employee retail if that matters for a given month.
- Manager name matching (Setup > Managers) is exact-normalized-name, not fuzzy — deliberate simplicity tradeoff, flagged to the user in the Setup > Managers hint text.
- Homepage News/Events have no password gate and no edit — only post/delete. If that turns out to be too permissive for a public-facing kiosk view, add a gate the same way Goals does it (`GOALS_PASSWORD` pattern in `App.js`).
- No test suite exists, and **this session's environment still has no Node.js/npm available** (confirmed again this session — `node`/`npm` not found via Bash or PowerShell, and `node_modules` isn't installed locally). Nothing has been verified with an actual local `npm run build`. Verification this session was manual (careful re-reading of every edited section, plus a brace/paren balance check via `perl`). **After pushing, use `gh api repos/evanrobins6789-cyber/supercuts-analytics/commits/<sha>/status --jq '.statuses[]'` to poll the GitHub↔Vercel status check** — this is an actual compile check and doesn't require local Node. Use this after every push, and pay particular attention this time since it's the first real usage of the `chart.js`/`react-chartjs-2` dependencies in the app.

## Architecture notes for a fresh session
- `src/App.js` is one large file (~3900+ lines now) — most tabs are components within it. Read the relevant function directly rather than assuming structure.
- `src/db.js`: generic Supabase (`weekly_report` table) + localStorage persistence layer. `loadData`/`saveData`/`clearData` and their `*ByPrefix` counterparts ALL return `{ok, error}` (or `{data, source, error}` for loads) — every caller should check these, especially cleanup deletes after a format-swap save.
- `src/leaderRoster.js`: hardcoded DL/Area Supervisor → store-code roster (edited + redeployed on change — different pattern from Managers/Homepage News/Events, which are user-editable in-app).
- The `supercuts-analytics/` subdirectory in the repo root is a **stale duplicate**, not the deployed app — ignore it.
- Deploys automatically via Vercel on push to `main`.
- Historical-import data-loss bug (nondeterministic Supabase row-merge order) was fixed a few sessions back and hasn't recurred since — see `git log` (`8201515` and earlier) if it ever needs revisiting. The underlying lesson — don't trust an implicit ordering guarantee that doesn't exist, and don't let errors get silently swallowed a layer down — is worth keeping in mind for any new persistence code.

## What's next
No specific direction from the user yet beyond the Homepage tab. Natural follow-ups if asked: a password gate for News/Events, letting News posts be edited (not just deleted and re-added), or adding more Top 10 widgets (e.g. Net Sales, Cuts) if the current four aren't enough.
