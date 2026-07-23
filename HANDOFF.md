# Handoff — Supercuts Analytics

Last updated: 2026-07-23, end of session covering the fix below plus four feature additions (not yet committed as of this writing — see `git log` once pushed).

## What this app is
A Store Scoreboard / analytics dashboard for a Supercuts franchise (React SPA, Supabase-backed, deployed on Vercel). Tabs for Overview, Stores, Employees, Retail, Color Sales, DL, 60 Day Employee, Reviews, Weekly, and Setup (which also holds Goals / Managers / Historical Import / Upload as sub-sections). Has an in-app AI assistant, "Tilly," that answers questions about the business data via a serverless Anthropic API proxy (`api/chat.js`).

## Current state: believed fixed, awaiting user confirmation
- **Historical Import data vanishing on refresh — likely root cause found and fixed.** After the prior session's four fixes, the user reported it was *still* happening. Root cause: the initial-load merge in `App.js` combined Supabase chunks via `Object.assign` in whatever order the query returned rows — but Postgres gives **no ordering guarantee** on an unordered `SELECT`. If a month ever had both an old single-chunk row and new per-store split rows at once (possible because `clearData`/`clearDataByPrefix` in `src/db.js` used to swallow delete errors silently, so a superseded-format cleanup could fail without anyone knowing), which row won on any given page load was a coin flip — exactly matching "disappears on refresh."
  - Fixed in three parts (all in this session, not yet user-verified):
    1. `clearData`/`clearDataByPrefix` (`src/db.js`) now return `{ok, error}` instead of swallowing delete failures silently.
    2. `saveHistoryMonthChunks` (`App.js`) checks that cleanup-delete result and logs a console error if it fails, instead of assuming success.
    3. **The real fix**: the initial-load merge (`App.js`, in the app's startup `useEffect`) now applies single-chunk rows first and per-store split rows second — deterministic regardless of Postgres row order — and also fixed the legacy pre-chunking blob (`daily_history`/`weekly_history` keys) being applied *last* (backwards — it should never be able to override fresher chunk data; now applied first as a base). It also proactively detects leftover contamination (both formats present for the same month) on load and deletes the stale one.
  - **Not yet re-confirmed by the user.** Next step: re-run Historical Import, refresh, and check the Employees tab / Tilly for the affected month. The existing `[history load]`/`[history save]` console diagnostics from the prior session are still in place if another repro is needed.

## What shipped this phase (new features, on top of the bug fix)
- **Gold Comb reviews** — a button on each review card (Reviews tab) lets staff acknowledge an awesome review. Persisted under its own db key (`review_gold_combs`, same pattern as `review_notes`), toggled via `handleToggleGoldComb` in `App.js`. Wired into Tilly's context (`buildAIContext`) as a "GOLD COMB REVIEWS" section.
- **TSTH red/green coloring** — TSTH ≥ $54 renders green (`tsth-good`), below renders red (`tsth-bad`), everywhere TSTH appears (Stores, Employees, DL, Retail/Color Sales tabs, company/store footers). Threshold is `TSTH_TARGET` in `App.js`, easy to adjust later if this changes.
- **MANAGER tag + Manager roster** — user picked the "editable in Setup" option over a hardcoded file (managers turn over more than DLs). New Setup sub-section (`ManagersTab`) lets the user type each store's manager name (free text, no password gate). Persisted as `store_managers` (`{storeCode: name}`). A `withManagerFlag` helper matches the assigned name (normalized) against each store's employee rows to render a "MANAGER" tag next to their name in every employee table (Stores, Employees, DL, Retail, Color Sales). **Known limitation**: matching is exact-normalized-name based — if the typed name doesn't match how the name appears in the stylist report (typo, nickname, middle initial), the assignment still saves but the tag won't show anywhere until it's corrected. Also wired into Tilly's context as a "STORE MANAGERS" section.
- **DL tab "Managers" view** — a view toggle (Full Stats / 👔 Managers) on the DL tab. The Managers view rolls up each DL's stores with just their assigned manager name, sourced directly from the `store_managers` map (doesn't depend on the name-matching above).

## Known limitations (deliberate, not oversights)
- Tilly's historical data is **month-level only** — no day/week granularity in her context (the context itself tells her this, so she should say so rather than guess).
- Review text sent to Tilly is capped at the 40 most recent negative / 15 most recent positive reviews — aggregates/counts are complete and uncapped, only raw quotes are bounded.
- Sales-Accrual historical imports only attribute retail to an employee if the source file's "Sold By" (or "Stylist") column has a value — if neither is populated, retail stays store-level only. Already-imported months need to be re-uploaded to backfill per-employee retail if that matters for a given month.
- Manager name matching (see above) is exact-normalized-name, not fuzzy — this was a deliberate simplicity tradeoff, flagged to the user in the Setup > Managers hint text.
- No test suite exists, and **this session's environment still has no Node.js/npm/python available** — nothing has been verified with an actual local `npm run build`. Verification this session was manual (careful re-reading of every edited section for brace/paren/JSX balance). After pushing, use `gh api repos/evanrobins6789-cyber/supercuts-analytics/commits/<sha>/status --jq '.statuses[]'` to poll the GitHub↔Vercel status check — this is an actual compile check and doesn't require local Node. **Use this after every push.**

## Architecture notes for a fresh session
- `src/App.js` is one large file (~3300 lines now) — most tabs are components within it. Read the relevant function directly rather than assuming structure.
- `src/db.js`: generic Supabase (`weekly_report` table) + localStorage persistence layer. `loadData`/`saveData`/`clearData` and their `*ByPrefix` counterparts now ALL return `{ok, error}` (or `{data, source, error}` for loads) — every caller should check these, especially cleanup deletes after a format-swap save.
- `src/leaderRoster.js`: hardcoded DL/Area Supervisor → store-code roster (edited + redeployed on change — different pattern from the new Managers feature, which is user-editable in-app).
- The `supercuts-analytics/` subdirectory in the repo root is a **stale duplicate**, not the deployed app — ignore it.
- Deploys automatically via Vercel on push to `main`.

## Recurring bug pattern worth knowing
The historical-data-loss bug ultimately came down to **trusting an implicit ordering guarantee that doesn't exist** (unordered SQL row order) combined with **a silently-swallowed error one layer down** (delete failures in `clearData`/`clearDataByPrefix`) — same family as the earlier "silent save failure" bugs from the prior session, just one layer removed. When something intermittent and "shouldn't be possible" keeps recurring after a fix, look for an assumption about ordering/timing that isn't actually guaranteed by the underlying system, not just the data path itself.
