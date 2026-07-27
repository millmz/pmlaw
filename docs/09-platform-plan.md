# PAM — Full Platform Build Plan

## Context

The foundation is built and deployed: mock Smokeball (from the vendored OpenAPI spec), golden dataset, sync worker, Postgres cache, six read tools with citations, agent loop, eval harness, and a minimal chat page — 53 tests green, live on Render behind an access code. Jeff's interview (docs/08) settled the product's shape. This plan turns that foundation into the complete platform: a friendly, phone-ready app your dad opens every morning, with the Settlement Status Board as its headline feature, then controlled write actions, then proactive intelligence.

Decisions already made with Adam: **landing view = Today dashboard**, **mobile matters from day one**, **brief stays in-app** (no email delivery for now). Everything builds against the mock and swaps to real Smokeball via config when credentials arrive (that cutover is Milestone R, which slots in whenever access is granted).

## The product, screen by screen

Navigation: left rail on desktop (like the approved mockup — PAM bracket monogram, gold/burgundy), bottom tab bar on phone. Screens: **Today · Chat · Matters · Settlements · Courts · Activity** (+ Settings).

### 1. Sign-in
A branded login page (replaces the current browser Basic-auth popup — that popup is hostile UX). Access code → httpOnly session cookie. Same code Render generates today; upgrades to per-user login before any second user or real client data.

### 2. Today — the landing screen
Jeff's morning routine, rendered in his exact order (docs/08 §1):
- **Now/next strip**: the next event with a countdown ("Clarkstown, Judge Kafinas — in 40 min").
- **Today's calendar** as a timeline; each event shows matter chip, court, judge.
- **Rest of this week** condensed; **from Wednesday on, next week's Mon–Fri court list appears automatically** (his Wednesday rule), staying live as events move.
- **Due today** checklist.
- **Overdue — needs a decision**, oldest first, each row with a one-tap "Move to…" (disabled until M4 write actions; shows "coming soon" tooltip before that).
- **Statute reminders** in a visually distinct, collapsed section labeled "tracked — leave as-is." Never mixed with actionable overdue.
- **Watchlist** (fed by M3/M5): settlement packages awaiting response, stalled matters.
- Header shows "Data as of 8:02 AM" with a sync-now button. Every row cites its Smokeball records.

### 3. Chat — PAM everywhere
Desktop: a slide-over panel available from every screen (keyboard shortcut + button), so he can ask "what's the Grasso posture?" while looking at the board. Phone: full-screen tab. Streaming replies; **citation chips link into the relevant matter page**; suggested-command chips seeded from his interview phrasing; conversations persist server-side and resume.

### 4. Matters
Search by client name (first/last, with the ambiguity behavior: multiple matches are always shown as cards to pick from, never auto-chosen). Filters: practice area, status, attorney. A matter page with:
- Header: client, number, practice area, jurisdiction, stage, **statute banner** (date + source, always visible for PI/med-mal).
- Tabs: **Overview** (upcoming events, open tasks, latest note), **Notes** (verbatim memos with author + last-edited — Jeff's source of truth, rendered prominently), **Tasks**, **Calendar**, **Files** (folder tree), and for PI matters a **Settlement** tab (below).

### 5. Settlements — the headline feature (Jeff's "one thing")
- **The Board**: one row per active PI/med-mal matter that is settlement-relevant. Columns: client · injuries · date of loss · insurer · adjuster (name/phone/email, tap-to-call on phone) · claim # · policy limits · **liens** · demand · current offer · last contact + who · statute date · next follow-up · **status pill** (Package sent ✓verified / Prepared, sending unverified / In negotiation / Awaiting response / Follow-up overdue / Ready — in suit). Sortable, filterable, exportable. Conflicting data (Keller's two policy limits) shows a warning chip, both values, both sources.
- **Per-matter Settlement tab**: the evidence-backed timeline (prepared → sent → acknowledged → calls → offers), every entry citing its memo/email/file/task; the negotiation history with who spoke to whom; "sending could not be verified" shown honestly when that's the truth.
- **Who's negotiating**: firm-wide view of which staffer last touched settlement notes on which matter — the thing Jeff has wanted for years.

### 6. Courts
Next week's Mon–Fri list (the Wednesday deliverable) plus a simple month view filterable by attorney and matter type ("criminal court dates in August").

### 7. Activity (audit)
Human-readable feed: every question asked, every tool call, and — once writes exist — every proposed/confirmed/executed change with its confirmation trail. This is the trust surface.

### Friendliness principles applied everywhere
Plain language ("I could not verify" not "null"); empty states that explain ("No settlement packages found in this matter's Settlement Package folder"); skeleton loaders, no spinners-forever; every AI statement one tap from its source; overdue presented calmly (it's Jeff's normal); big tap targets and readable type on phone; light/dark from the approved mockup palette (gold #B3925A, burgundy #6E2228, Marcellus + Public Sans, self-hosted).

## Technical build

### Frontend (new)
- **Vite + React + TypeScript SPA** in `src/web/`, built to static assets served by the existing Fastify server (one deployable on Render, no SSR). React Router; TanStack Query for data; hand-rolled design system from the mockup tokens (no component library). Fonts self-hosted in the repo.
- **Streaming chat over SSE**: extend the agent loop with a streaming variant (Anthropic SDK `stream`); server relays text deltas + citation events.

### Backend additions
- **Chat persistence**: `chat_sessions` + `chat_messages` tables (drizzle migration); resume on reload; "new conversation" closes server-side.
- **Cookie-session auth**: login endpoint + session store, replacing the Basic-auth hook (`src/server/main.ts` gate).
- **Settlement intelligence engine** (`src/server/settlement/`): background job per relevant matter —
  1. Parse memos into structured facts (regex-first for the patterns Jeff actually writes — "Demand:", "Offer:", "Policy limits:", adjuster contacts — with Haiku fallback for fuzzy cases; every extracted fact stores its source memo id and a confidence).
  2. Package detection from the standard `Settlement Package` folder; sent-verification from Emails-folder files (attachment markers, **Dropbox/file-link detection**, recipient match); mail-only ⇒ "could not verify" status, never a guess.
  3. Liens from `Liens` folder + `lien` filename/content search; injuries from bill of particulars (Pleadings) or the package via the file-search endpoint.
  4. Derived tables: `settlement_summaries`, `settlement_events` (timeline entries with evidence record ids). Refreshed when sync touches a matter; manual refresh button.
  5. New read tools: `get_settlement_board`, `get_settlement_timeline` — chat and UI share them.
- **Write framework** (Sprint 4, per docs/03): propose → confirm → execute → **verify** endpoints; single-use confirmation tokens bound to payload hash; hard-deadline guard reuses `isStatuteReminder` (`src/core/dates.ts`); write tools: `reschedule_task` (single + batch triage), `create_task` (assign to Jeff + assignee, matter-tagged, "front desk" resolvable), `create_event` (Jeff + Office default, `JTM/FJP` shared-diary parsing, initials-prefix titles); verification via the existing webhook receiver + polling; enhanced typed confirmation for anything statute-adjacent. Confirmation cards render in chat AND as one-tap actions on Today.
- **Jobs**: existing incremental sync; add nightly cache-integrity sample check and settlement refresh.
- **Real-Smokeball cutover kit** (Milestone R): capability-verification script (the Sprint 0 checklist as code), staging golden-data seeder, env-based switch already in place.

### What gets reused
Everything: date engine, golden data, mock server, sync worker, tool registry (`READ_TOOLS` grows), citation validator, eval harness (new cases per milestone), system prompt.

## Milestones — each ends deployed to Render, testable by you and Jeff

- **M1 — The app** (~biggest chunk): SPA shell + design system + login page, Today dashboard live on real cache data, streaming chat with linked citations, matter search + basic matter page. Desktop + phone layouts. *You can hand Jeff the URL after M1.*
- **M2 — Read-only complete**: full matter page (Notes verbatim, Files tree), Courts view, staff calendars, chat persistence, expanded evals. Exit = read-only acceptance criteria (docs/01) on mock data.
- **M3 — Settlement intelligence**: engine + Board + timeline + who's-negotiating. Gate: zero false "sent" claims on golden data (incl. Dropbox and mail-only cases).
- **M4 — Write actions**: confirmation framework + reschedule/batch triage + create task/event + Activity feed. Gate: eval suite proves no write without confirmation, no statute moves.
- **M5 — Proactive polish**: watchlist flags on Today, matter-health statuses with stated reasons, Wednesday court-list automation, stale-matter nudges (suggest, never act).
- **M R — Real data** (slots in whenever Smokeball credentials arrive, interleaving with the above): run capability verification against staging, correct the mock where reality differs, seed staging golden data, repoint, then the shadow-validation gate (10 straight clean briefs vs. Smokeball) before Jeff relies on it.

## Verification
- Existing 53 tests grow with each milestone (settlement engine gets the heaviest suite — every golden trap case).
- **Playwright E2E** (Chromium is preinstalled here): boot server with mock + scripted LLM, walk sign-in → Today → chat round-trip → board, screenshot each state; runs in CI.
- Eval suite runs scored once `ANTHROPIC_API_KEY` is present (it's on Render now — I'll also run evals in CI-with-key or via the Render shell and fix failures as part of M1).
- Each milestone: deployed to Render, and you click through it on your phone + desktop before I start the next.

## What I need from you
- Keep chasing the Smokeball account manager (Milestone R is ready whenever they are).
- 15 minutes of Jeff's reactions after M1 and again after M3 — his corrections are worth more than any eval.
- Nothing else; costs stay as-is (Render free tier is fine through M3; ~$7/mo Starter recommended once Jeff uses it daily so it never sleeps).
