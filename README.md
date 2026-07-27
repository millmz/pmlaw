# PAM — Phillips & Millman AI Assistant

An AI assistant for Phillips & Millman, LLP that sits on top of [Smokeball](https://www.smokeball.com) and lets attorneys manage their daily work through natural-language conversation: calendars, tasks, matters, documents, emails, deadlines, and (later) approved write actions like creating events and tasks.

**Smokeball is the system of record. PAM retrieves, organizes, summarizes, and — only with explicit confirmation — acts.**

## Status

**Phase A built** — the full walking skeleton runs against a mock Smokeball generated from the vendored OpenAPI spec (`vendor/smokeball-openapi.json`), with golden test data covering every trap case. Swapping the mock for the real staging API is a config change (`SMOKEBALL_BASE_URL` + credentials), pending API access.

```bash
pnpm install
pnpm test        # 53 tests: date engine, golden data, mock API, sync, tools, agent loop
pnpm demo        # prints Jeff's morning brief end-to-end (mock → sync → cache → tools)
pnpm dev         # serves the chat UI + brief at :8787 (chat needs ANTHROPIC_API_KEY)
pnpm eval        # eval harness — scored with a key, lists cases without one
```

Layout: `src/core` (types, date/status engine, golden dataset) · `src/smokeball` (typed client + mock server) · `src/server` (Postgres cache via PGlite, sync worker, tool layer, agent loop, UI) · `src/evals`.

Plan docs:

| Doc | Purpose |
|---|---|
| [docs/00-project-brief.md](docs/00-project-brief.md) | Vision, users, product principles, scope boundaries |
| [docs/01-build-plan.md](docs/01-build-plan.md) | Architecture, tech stack, phased milestones, acceptance criteria |
| [docs/02-smokeball-api.md](docs/02-smokeball-api.md) | What the Smokeball API actually supports; feasibility risks; Sprint 0 checklist |
| [docs/03-safety-and-permissions.md](docs/03-safety-and-permissions.md) | Hard rules, confirmation flows, audit logging, confidentiality |
| [docs/04-testing-and-evals.md](docs/04-testing-and-evals.md) | How we know PAM is accurate before trusting it |
| [docs/05-ask-pam-voice-companion.md](docs/05-ask-pam-voice-companion.md) | Saved build prompt for the "Ask Pam" voice companion — build after the core platform works |
| [docs/06-roadmap.md](docs/06-roadmap.md) | The working checklist: who does what, in what order, starting today |
| [docs/07-jeff-interview.md](docs/07-jeff-interview.md) | The interview questions put to Jeff |
| [docs/08-jeff-answers.md](docs/08-jeff-answers.md) | **Jeff's answers and what they changed in the build** — read before writing code |

## The one-paragraph plan

Prove the Smokeball API can do what we need (Sprint 0) → ship a tiny read-only "walking skeleton" (Jeff's calendar + tasks in chat, with source citations) → add matter search and reporting on top of a synced local cache → build Personal Injury settlement intelligence → enable confirmed write actions → add proactive morning briefs and matter health checks. Every phase has a go/no-go gate; write access to Smokeball comes last, after read accuracy is validated on real data.
