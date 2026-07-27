# 06 — Roadmap and Working Checklist

The living checklist for the build. Split by **who does it**: Adam (firm-side, decisions, testing with Jeff) and Claude (all code). Detailed specs live in docs/01–04; this is the order of operations.

## Phase A — Now, while waiting on Smokeball (no API key needed)

### Adam: firm-side groundwork

- [x] ~~**Interview Jeff.**~~ Done 2026-07-27 — answers and their impact on the build in [docs/08](08-jeff-answers.md).
- [x] ~~**Confirm the plan tier.**~~ Prosper Plus ✅; Jeff is the firm's Smokeball admin and approves the API connection himself.
- [ ] **Chase API access.** The conversation with Smokeball is already open — push it to credentials. Still to ask: what access costs, how long until credentials, and the **security-review questionnaire** (get it early). Request Developer Console access + a **staging test account**, and scopes for: staff, matters, matter types, contacts, tasks, events, files (+ file search), **memos**, layouts, webhooks. *(Memos are now critical — they're Jeff's settlement source of truth.)*
- [ ] **Four quick follow-ups with Jeff** (non-blocking, from [docs/08](08-jeff-answers.md)): what "debtor hub" is and its matter-type name; confirm staff name spellings; a screenshot of one real statute reminder task so we can detect the 6/3/1 pattern exactly; whether defense counsel is a Smokeball field/role or only in notes.
- [ ] **Create an Anthropic Console account** (console.anthropic.com) and an API key — needed the moment the chat loop exists.
- [ ] **Pick hosting** (recommendation: Fly.io or Railway, US region — ~$20–50/mo) and create the account.
- [ ] **Ask about a subdomain** — e.g. `pam.pmlawny.com` — who controls the firm's DNS.
- [ ] **Firm decisions:** chat-history retention (default: keep, purgeable), and who besides Jeff may see PAM's output in v1 (default: nobody — single user).

### Claude: build against a mock (real code, no key required)

Smokeball's full OpenAPI spec is public — so the entire platform can be built and tested against a **mock Smokeball server** generated from it, then repointed at staging when credentials arrive. Nothing here is throwaway: the mock becomes the permanent test fixture for the eval suite.

- [ ] Scaffold the TypeScript monorepo: Fastify server, Postgres + Drizzle schema (staff, matters, matter types, tasks, events, files, sync state, audit log, sessions), Next.js chat UI shell styled from the approved PAM mockup.
- [ ] Generate a typed Smokeball API client from `smokeballdev/docs` `openapi.json`.
- [ ] Build the **mock Smokeball server** implementing the endpoints we use, seeded with the golden dataset from [docs/04](04-testing-and-evals.md) (~10 fictional matters incl. the settlement trap case).
- [ ] Sync worker v1 against the mock: full sync → incremental `UpdatedSince` → webhook receiver (HMAC verification, dedupe, out-of-order tolerance).
- [ ] Deterministic date/status engine (overdue / due today / upcoming, firm timezone `America/New_York`, DST boundaries) with the full unit-test suite — this is the legal-risk core, done first.
- [ ] Agent loop with the first ~6 read tools reading from Postgres; source-citation plumbing end to end.
- [ ] Eval harness skeleton: golden data in, command library as test cases, programmatic scoring.

**Exit:** the walking skeleton answers "what does my day look like?" correctly against mock data, with citations, evals green.

## Phase B — Key arrives: Sprint 0 verification (days, not weeks)

- [ ] Wire real credentials (staging first). Run the capability-verification script: auth + refresh, staff, matters, today's events/tasks, one matter's folder tree + an email file downloaded and parsed, `/search/files` for "settlement", webhook round-trip, `UserId` permission check, rate-limit behavior, deep-link URL probing.
- [ ] Update [docs/02](02-smokeball-api.md) with every delta between the spec and reality; decide workarounds for any surprise.
- [ ] Seed the golden dataset into the staging account (Adam: ~an hour of clicking in the staging web app, or via API where writable).
- **Gate:** capability matrix confirmed; mock's behavior corrected to match reality where they differ.

## Phase C — Sprints 1–2: read-only assistant on real data (~2–3 weeks)

- [ ] Repoint sync at staging → then production account (read-only scopes).
- [ ] Full matter search/reporting from cache; colleague + office calendars; conflict detection; daily brief with priority ordering.
- [ ] Deploy to hosting under the subdomain, app login for Jeff (passkey/OTP).
- [ ] **Adam + Jeff: shadow validation** — 1–2 weeks of Jeff comparing PAM's morning brief against Smokeball; every discrepancy filed and fixed. **Gate: 10 consecutive clean briefs.**

## Phase D — Sprint 3: settlement intelligence (~1–2 weeks)

- [ ] Folder/package detection (fuzzy naming from Jeff's interview data), email-file parsing, sent-verification, timelines with evidence, follow-up gap detection.
- [ ] **Gate:** zero false "sent" claims on golden data; Jeff spot-checks real PI matters.

## Phase E — Sprint 4: confirmed writes (~1–2 weeks)

- [ ] Propose → confirm → execute → verify framework; event + task creation, task rescheduling with hard-deadline guard; audit trail UI.
- [ ] **Gate:** a week of real use, zero unintended writes; Smokeball security review passed (required for production app promotion — start the paperwork in Phase B).

## Phase F — Sprint 5: proactive PAM (~1 week)

- [ ] Scheduled morning brief, matter health checks with explained statuses, stale-matter and settlement follow-up flags.

## Phase G — Later, by demand

Multi-user + permissions ([docs/03](03-safety-and-permissions.md)), **Ask Pam voice companion** ([docs/05](05-ask-pam-voice-companion.md), after Phase E), Outlook add-in, mobile, AI Matter Summary write-back.

---

*Time is dominated by two things we don't control — Smokeball's access approval and the shadow-validation calendar time. Everything in Phase A exists to make the waiting free.*
