# 00 — Project Brief

## Vision

Build a secure AI assistant ("LawMan") for Phillips & Millman, LLP that connects to Smokeball and acts as an intelligent operating layer over it. Attorneys ask questions and give instructions in plain language; LawMan retrieves calendars, tasks, matters, documents, and correspondence, summarizes case status, and — after explicit confirmation — performs approved administrative actions (create calendar events, create tasks, reschedule tasks).

LawMan reduces time spent manually opening matters, checking folders, reviewing emails, and piecing together case status. It does **not** replace attorney judgment: it organizes, retrieves, summarizes, and executes administrative instructions while keeping the attorney in control.

## Users

- **v1: Jeff Millman only.** Single-user MVP. This is deliberate — it sidesteps the hardest permission problems while we validate accuracy, and matches how the tool will actually be adopted (one enthusiastic user first).
- **Later:** Frank, Anthony, other attorneys, then paralegals/staff. Multi-user requires solving per-user permission enforcement (see [docs/03](03-safety-and-permissions.md)) — a user must never see matters, documents, calendars, or communications they cannot access inside Smokeball.

## The three questions LawMan answers

1. **Today** — What's on my calendar? What's due, overdue, or urgent?
2. **Matters** — What's happening in a matter? Which cases need follow-up, have upcoming appearances, sent settlement packages, adjusters to chase?
3. **Next actions** — What should I (or my staff) do next? What should be calendared or tasked?

## Core principles

1. **Smokeball is the system of record.** Never invent a matter, event, task, document, email, deadline, adjuster, policy limit, settlement amount, or case status. LawMan's own database is a cache and an audit trail, never an authority over Smokeball.
2. **Read before write.** The first releases are strictly read-only. Write actions come only after read accuracy is validated on real firm data, and every write requires explicit user confirmation.
3. **Show your sources.** Every material statement cites the Smokeball records it came from, with enough identifying info (ideally a deep link) to open them in Smokeball. "I could not verify X" is a first-class answer.
4. **Facts vs. inference, always labeled.** "The settlement folder contains Demand.pdf (created May 5)" is a fact. "The package appears to have been sent" is an inference and must be supported by a matter-linked email or activity record — never by the document's mere existence.
5. **Hard deadlines are sacred.** Statutes of limitations, court dates, and filing deadlines get enhanced confirmation, are never moved automatically, and are always shown with their source.
6. **Ambiguity → ask, don't guess.** When a matter or person reference is ambiguous, present the best matches and let the user choose.

## Explicitly out of scope (all versions until revisited)

- Legal advice to clients; strategic legal decisions
- Filing documents; sending external email
- Deleting anything (documents, events, tasks, matters)
- Billing/trust accounting (read or write)
- Training any model on firm data

## What changed from the original (ChatGPT) plan

The original plan (PDF, preserved intent here) was strong on product definition and safety rules. This version changes:

1. **Adds a sync/cache layer** (the original implied live API calls for everything; firm-wide queries like "matters with no activity in 30 days" are impossible live under API rate limits — see [docs/01](01-build-plan.md)).
2. **Scopes v1 to a single user (Jeff)** instead of "respect every user's permissions" from day one.
3. **Names a concrete tech stack** and deployment model instead of leaving it open.
4. **Grounds the plan in the actual Smokeball API** ([docs/02](02-smokeball-api.md), researched from Smokeball's published OpenAPI spec): matter-linked emails are readable (as files), full-text document search exists, writes are asynchronous, rate limits are 5 req/s, and there are no documented deep links — each of which changed a design decision.
5. **Adds an eval harness** ([docs/04](04-testing-and-evals.md)): the original's "command library" becomes an automated accuracy test suite with golden data, not just a demo script.
6. **Adds go/no-go gates between phases** with measurable acceptance criteria, plus operational concerns the original omitted (cost, secrets, logging with privileged data, backup, Anthropic data-use posture).
7. **Checks against Smokeball's own AI roadmap** (their "Archie" AI) so we don't build what the vendor is about to ship.
