# PAM M2 — The Conversation-First Redesign (Jeff's feedback applied)

## Context

Jeff reviewed M1 (docs/10). His verdict reshapes the product without changing its foundations: the dashboard should be **quieter and much bigger-typed** (just his day), the conversation should be **the product** ("I want the interactive with the AI — chat really would be my main page"), static browsing tabs duplicate Smokeball and don't earn their place, and his two unprompted wishes are **rescheduling tasks by talking to PAM** and the **settlement negotiation conversation** ("what are the top five cases I've been negotiating on?" → offers, adjusters, follow-up status, a suggestion, and "would you like me to dial it for you?"). Everything below reuses the M1 machinery — tools, agent loop, sync, evals — and mostly *rearranges the surface* while pulling the settlement engine and the first write action forward.

## The reshaped app

**Navigation (before → after):** Today · Chat · Matters · Settlements · Courts · Activity → **Today · Chat · Tasks · Settlements** — with Matters and Activity demoted to a "More" overflow (matter pages stay reachable from citation links and search; Activity gets a plain-words explainer: "PAM's on-the-record log — every question asked and, later, every change made. This is how you audit your assistant."). Courts is deleted as a concept: courts are just schedule items, per Jeff.

### 1. Type + visual identity pass (his #1 and #3 asks)
- Base font 14px → **16.5px**, key content (event/task titles) 18–19px, tighter line lengths, stronger contrast. An **A / A+ text-size toggle** in the top bar (persisted in localStorage) that scales the whole app another 15%.
- Richer look, still law-firm dignified: burgundy header band with the bracket wordmark, gold rules, serif section headers at real display sizes, warmer cards with more air. The current design's bones stay; the volume knob goes up. New E2E screenshots at each size for review.

### 2. Today — quiet, big, one day at a time
- **Date-tab day switcher**: "Today" plus the next ~10 weekdays as tabs ("Aug 5", "Aug 6"); tap → that day's calendar, titled "August 5 calendar." (Jeff's own design, verbatim.) Backend: existing `get_calendar_events` range scope — no new tool needed.
- Selected day's calendar as a **large timeline** + **today's tasks** (sized for his real 10–12).
- **Removed from Today**: Up-next strip, Rest of week, Overdue, Statute reminders, Watchlist.
- Golden data grows to his real density (10–12 tasks/day, 15–20 events/week) so we design and screenshot at truth (`src/core/golden.ts`).

### 3. Tasks — the new home for everything task-shaped
Sections: **Due today · Upcoming · Overdue (needs a decision, oldest first) · Statute reminders (tracked — leave as-is, collapsed)**. Reuses `get_tasks` buckets and the statute split from `src/core/dates.ts` unchanged. Each row: matter link, days-late pill, and a **"Move to…" button that opens chat pre-filled** ("Move '[task]' to …") — so rescheduling flows through the conversation and its confirmation card from day one of writes.

### 4. Chat — elevated to co-equal main surface
- **Desktop**: Today and Chat side-by-side as a split view (chat permanently docked, not a drawer). **Mobile**: Chat tab (unchanged) + the docked suggestions.
- **Server-side persistence** (new `chat_sessions`/`chat_messages` tables in `src/server/db/schema.ts`): conversations survive reloads; "New conversation" closes server-side (the Ask Pam lesson).
- **Phone numbers in PAM's replies become tap-to-call links** (`tel:`) — the "dial it for you" moment. Contact info renders as a tappable card when PAM cites an adjuster.
- System prompt tuned for **dialogue**: shorter answers, follow-up questions, suggestions with stated reasons ("the Grunwald call was due Aug 1 and hasn't happened — I'd call today").
- Suggested prompts updated to Jeff's own phrasings from docs/08 + docs/10.

### 5. Settlements — the engine, built conversation-first (was M3, pulled in)
The full settlement intelligence engine from the approved plan (docs/09 §backend): memo parsing (regex-first + Haiku fallback, every fact with source + confidence), package detection, sent-verification (attachments, **Dropbox links**, mail-only ⇒ "could not verify"), liens, injuries, derived `settlement_summaries` + `settlement_events` tables, refreshed on sync. Exposed as **two new read tools** (`get_settlement_board`, `get_settlement_timeline`) so **chat answers Jeff's "top five negotiating" scenario** — ranked by negotiation recency, with offer, adjuster + phone, follow-up-task status, and a reasoned suggestion. The Settlements page renders the same data as a big-type board (his "dynamite" list) — the page and the conversation can never disagree because they share tools.
Golden data gains negotiation-rich matters to make "top five" meaningfully rankable; the near-verbatim scenario becomes the flagship eval case.

### 6. First write action — task rescheduling (pulled forward from M4)
Jeff asked for it unprompted; it ships behind the full safety framework from docs/03, scoped to this one verb: `propose_task_reschedule` / `execute_task_reschedule` with single-use payload-hash confirmation tokens, **statute guard** (`isStatuteReminder` — refuses, explains, never moves), confirmation card in chat + on Tasks rows, execute → **verify** via webhook/poll before "done," full audit entries. Event/task *creation* stays in M4.

## Build order (one milestone, shipped in three reviewable chunks)

1. **Chunk A — the reshape**: type scale + toggle, nav change, Today day-tabs, Tasks page, golden-data density, updated E2E + screenshots for Adam/Jeff.
2. **Chunk B — chat elevation**: split view, persistence tables + endpoints, tel: links, dialogue-tuned prompt, new suggested prompts.
3. **Chunk C — settlement engine + reschedule write**: engine + tools + board page + "top five" eval; reschedule write path with confirmation + statute-guard evals.

Each chunk: tests green (unit + E2E), committed, pushed, Render-deployed, screenshots posted for reaction before the next.

## What doesn't change
Sync worker, mock Smokeball, date engine, citation system, audit log, eval harness, Render setup, docs/03 safety rules (the reschedule write implements them, not bypasses them). Matter pages remain (reachable via links) — they're where citations land.

## Verification
- Unit: settlement engine gets the heaviest new suite — every golden trap (Dropbox-sent, mail-only, prepared-not-sent, lien math, conflicting limits, negotiation ranking). Reschedule: token binding, statute refusal, verify-before-done.
- E2E additions: day-tab switching, Tasks page sections, text-size toggle, chat persistence across reload, reschedule confirmation flow (mock LLM), board rendering at density.
- Evals: "top five negotiating" scenario (must include offer + adjuster + task status + suggestion with reason; must NOT claim unverified sends), "move the Smith task to Friday" (must show confirmation card, must refuse statute tasks), plus all existing cases re-run.
- Ship each chunk to Render; Jeff's next reaction round happens on the real URL with his glasses off — that's the true acceptance test for the type scale.
