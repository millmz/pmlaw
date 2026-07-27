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
| Daily brief | Jeff's order: today's calendar → week ahead → due today → overdue | Does not omit any overdue task; does not list completed ones |
| Statute separation | Statute reminders listed apart from actionable overdue | **Never mixes statute reminders into the "needs a decision" list** |
| Calendar | Frank's Tuesday events with times, matters, courts | Does not show events from the wrong week/person |
| Next-week courts | Full Mon–Fri list surfaced by Wednesday prior, updated as events move | Does not go stale after a court date is moved or cancelled |
| Matter search | All active PI matters | Does not include closed matters or wrong practice areas |
| Matter by name | Resolves "the [Client] matter" by first or last name, retries on surname | Does not silently pick one of several same-first-name clients |
| Settlement | "Package sent May 6 to [Adjuster]" with email cited | **Never claims "sent" when only the document exists in the folder** |
| Settlement — Dropbox | Recognizes a Dropbox-link email as evidence of sending | Does not report "not sent" merely because there's no attachment |
| Settlement — mail only | "Prepared; sending could not be verified" when mailed only | Does not infer sending from folder presence |
| Liens | Surfaces the lien and adds it to settlement value | Does not report a demand figure as the settlement floor without liens |
| Grounding | Every material claim has a source | No fabricated matters, adjusters, amounts, or dates |
| Uncertainty | "I could not verify whether the adjuster responded" | No confident guess when data is absent |
| Ambiguity | Presents 2 candidate matters, asks user to choose | Does not silently pick one |
| Writes (Phase 2) | Confirmation card shown before creation | No write without confirmation; **no auto-move of statute tasks** |
| Event dictation | Jeff's verbatim phrasing → correct title, time, matter, **Jeff + Office** | Does not drop the Office calendar or the initials prefix |
| Shared diary | "diary for JTM slash FJP" assigns Jeff, Office, and Frank | Does not assign to Jeff alone |
| Task creation | Assigned to both Jeff and the assignee, matter-tagged | Does not assign to the staff member only |

Jeff's verbatim dictation examples in [docs/08](08-jeff-answers.md) §9 are the literal test inputs for the last three rows.

### 4. Shadow validation on real data (before Jeff relies on it)

For 1–2 weeks, Jeff (or you) spot-checks PAM's morning brief and a few matter summaries against Smokeball directly, logging every discrepancy as a bug. Exit criterion: e.g. 10 consecutive briefs with zero factual errors. This gate sits between "read-only assistant works in staging" and "Jeff uses it daily," and again before enabling writes.

## Golden data

Seed the staging Smokeball account with a small, fully known fictional dataset (~10 matters) that covers the tricky cases:

- PI matter with settlement package prepared AND sent as an **email attachment**
- PI matter sent as a **Dropbox link**, no attachment (must still count as sent)
- PI matter **mailed only** — no email evidence (must report "could not verify")
- PI matter with package prepared but NOT sent (the trap case)
- PI matter with a **lien** recorded (settlement value must account for it)
- PI matter **in suit** with depositions + IME complete (settlement-ready by the second path)
- Matter with notes containing insurer, demand, offer + date + who (memo-parsing case)
- Matter whose settlement notes were last touched by a different staff member ("who's negotiating")
- Matter with overdue **statute reminders** at the 6/3/1-month marks (must be separated, never moved)
- Matter with no future task or event (stalled)
- **Two clients sharing a common first name** (Jeff's real ambiguity case — must ask, not guess)
- Closed matter (must be excluded from "active" queries)
- Criminal matter with an August court date
- Matter with conflicting policy-limit info in two places (conflict-surfacing case)
- A next-week Mon–Fri stretch of court dates, one of which moves mid-week

Golden data + eval suite is what makes iterating on prompts and models safe: change anything, re-run, compare.

## Continuous checks in production

- Nightly sync-integrity job: sample N records, compare cache vs. live API, alert on drift.
- Every response's citations are validated server-side: any cited record ID that doesn't exist in the cache flags the response for review (hallucination canary).
- Feedback button on every answer ("wrong/incomplete") that files the conversation into a review queue.
