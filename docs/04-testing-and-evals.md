# 04 — Testing and Evals

The original plan listed ~30 example commands as a "command library." That list is the seed of something more important: an **automated eval suite** that tells us, before Jeff trusts PAM and before every release after that, whether the assistant is accurate. An assistant that confidently misreads a statute deadline is worse than no assistant.

## Layers

### 1. Deterministic unit tests (no LLM)

The date/status logic is where legal risk concentrates, and none of it needs a model:

- Overdue / due-today / upcoming / completed / no-due-date classification, computed from due date + completion status against the current date in the **firm's local timezone** — never from Smokeball display colors, never in UTC. Test the boundaries: task due today at 11:59 PM, task completed late, all-day events, DST transitions.
- Calendar conflict detection (overlapping intervals, multi-calendar events).
- "Hard deadline" detection rules (category names, statute flags) that gate task rescheduling.
- Confirmation-token binding: payload drift invalidates the token.
- Permission filtering of cache queries (when multi-user arrives).

### 2. Tool-layer integration tests (staging Smokeball, no LLM)

Against the Smokeball staging/test account with **seeded golden data** (see below): each tool function returns correctly shaped, correctly filtered data. Sync worker tests: create/modify/delete a record in staging, assert the cache converges.

### 3. End-to-end evals (LLM in the loop)

Run the command library as an eval set against golden data with known correct answers. Score with a mix of programmatic checks (did the response mention all 3 overdue tasks? did it cite sources? did it NOT mention the unrelated matter?) and LLM-as-judge for fuzzier qualities. Track pass rates per release; a regression blocks deploy.

Critical eval categories, each with explicit **negative cases**:

| Category | Example positive | Example negative (must-not) |
|---|---|---|
| Daily brief | Lists all overdue tasks, oldest first | Does not omit any overdue task; does not list completed ones |
| Calendar | Frank's Tuesday events with times, matters, courts | Does not show events from the wrong week/person |
| Matter search | All active PI matters | Does not include closed matters or wrong practice areas |
| Settlement | "Package sent May 6 to Jane Smith" with email cited | **Never claims "sent" when only the document exists in the folder** |
| Grounding | Every material claim has a source | No fabricated matters, adjusters, amounts, or dates |
| Uncertainty | "I could not verify whether the adjuster responded" | No confident guess when data is absent |
| Ambiguity | Presents 2 candidate matters, asks user to choose | Does not silently pick one |
| Writes (Phase 2) | Confirmation card shown before creation | No write without confirmation; no auto-move of statute tasks |

### 4. Shadow validation on real data (before Jeff relies on it)

For 1–2 weeks, Jeff (or you) spot-checks PAM's morning brief and a few matter summaries against Smokeball directly, logging every discrepancy as a bug. Exit criterion: e.g. 10 consecutive briefs with zero factual errors. This gate sits between "read-only assistant works in staging" and "Jeff uses it daily," and again before enabling writes.

## Golden data

Seed the staging Smokeball account with a small, fully known fictional dataset (~10 matters) that covers the tricky cases:

- PI matter with settlement package prepared AND sent (email exists)
- PI matter with package prepared but NOT sent (the trap case)
- Matter with an overdue statute-related task
- Matter with no future task or event (stalled)
- Two matters with confusingly similar client names (ambiguity case)
- Closed matter (must be excluded from "active" queries)
- Criminal matter with an August court date
- Matter with conflicting policy-limit info in two places (conflict-surfacing case)
- Calendar day with an event overlap between two attorneys

Golden data + eval suite is what makes iterating on prompts and models safe: change anything, re-run, compare.

## Continuous checks in production

- Nightly sync-integrity job: sample N records, compare cache vs. live API, alert on drift.
- Every response's citations are validated server-side: any cited record ID that doesn't exist in the cache flags the response for review (hallucination canary).
- Feedback button on every answer ("wrong/incomplete") that files the conversation into a review queue.
