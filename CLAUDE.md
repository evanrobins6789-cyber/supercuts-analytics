# Supercuts Analytics — working notes for Claude Code

## Start-of-session checklist
1. Read `HANDOFF.md` first — it has current project status, what's pending, and known tradeoffs. Don't re-derive this from git log/conversation memory; the doc is the source of truth for "where things stand."
2. Check `git status` / `git log -5` to confirm HANDOFF.md still matches reality (the user may have made changes outside a session with you).

## End-of-phase checklist
When a meaningful chunk of work wraps up (a feature is done, a bug is fixed and verified, or the user says to wrap up / start a new phase), update `HANDOFF.md`:
- What shipped this phase (brief, not a full changelog — git log already has that)
- Current state of the app / any in-progress work
- Known issues, tradeoffs, or deliberate limitations (and why)
- What's next, if the user has indicated a direction
- Anything a fresh session would need to know to avoid re-deriving it or repeating a mistake

Keep it concise — it's a hand-off, not documentation. Prefer linking to specific files/functions over re-explaining code that's easy to re-read.

## Project basics
- Single-page React app (Create React App), one large file at `src/App.js` (~2900 lines) plus `src/App.css`, `src/parser.js` (Excel/CSV parsing), `src/db.js` (Supabase + localStorage persistence), `src/leaderRoster.js` (hardcoded DL/store roster), `src/storeDirectory.js` (store code ↔ name).
- `api/chat.js` is a Vercel serverless function proxying to the Anthropic API for "Tilly," the in-app AI assistant.
- Deployed via GitHub → Vercel auto-deploy on push to `main`. The user has historically deployed by dragging files into the GitHub web UI (hence the "Add files via upload" commit history) as well as through this tool.
- Persistence: Supabase (`weekly_report` table, single `report_id`/`payload` jsonb schema reused for every dataset — reports, goals, reviews, chunked history, etc.) with a localStorage fallback/mirror. No other backend.
- No test suite and no Node.js available in the sandboxed environment this session — verification has been manual (careful re-reading + brace/paren balance checks), not `npm run build`. If Node becomes available, prefer an actual build check.
- The `supercuts-analytics/` subdirectory is a stale, abandoned duplicate from early in the project's history — not the deployed app. Ignore it.

## Standing user preferences (also in persistent memory, repeated here for visibility)
- Always wire any new data source, upload type, or computed field into Tilly's context (`buildAIContext()` in `src/App.js`) as part of the same change — don't wait to be told Tilly is missing something.
- Push directly to `main` after making a fix/change; the user approved this working pattern early in the project and it's been the norm since (no repeated per-push confirmation). Still call out anything unusually risky before pushing it.
