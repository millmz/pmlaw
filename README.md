# PAM — Phillips & Millman AI Assistant

An AI assistant for Phillips & Millman, LLP that sits on top of [Smokeball](https://www.smokeball.com) and lets attorneys manage their daily work through natural-language conversation: calendars, tasks, matters, documents, emails, deadlines, and (later) approved write actions like creating events and tasks.

**Smokeball is the system of record. PAM retrieves, organizes, summarizes, and — only with explicit confirmation — acts.**

## Status

Planning. No code yet. Start here:

| Doc | Purpose |
|---|---|
| [docs/00-project-brief.md](docs/00-project-brief.md) | Vision, users, product principles, scope boundaries |
| [docs/01-build-plan.md](docs/01-build-plan.md) | Architecture, tech stack, phased milestones, acceptance criteria |
| [docs/02-smokeball-api.md](docs/02-smokeball-api.md) | What the Smokeball API actually supports; feasibility risks; Sprint 0 checklist |
| [docs/03-safety-and-permissions.md](docs/03-safety-and-permissions.md) | Hard rules, confirmation flows, audit logging, confidentiality |
| [docs/04-testing-and-evals.md](docs/04-testing-and-evals.md) | How we know PAM is accurate before trusting it |
| [docs/05-ask-pam-voice-companion.md](docs/05-ask-pam-voice-companion.md) | Saved build prompt for the "Ask Pam" voice companion — build after the core platform works |
| [docs/06-roadmap.md](docs/06-roadmap.md) | The working checklist: who does what, in what order, starting today |

## The one-paragraph plan

Prove the Smokeball API can do what we need (Sprint 0) → ship a tiny read-only "walking skeleton" (Jeff's calendar + tasks in chat, with source citations) → add matter search and reporting on top of a synced local cache → build Personal Injury settlement intelligence → enable confirmed write actions → add proactive morning briefs and matter health checks. Every phase has a go/no-go gate; write access to Smokeball comes last, after read accuracy is validated on real data.
