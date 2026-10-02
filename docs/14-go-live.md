# Go-live runbook — PAM on the firm's production Smokeball

Written for Adam. Staging is proven (auth, scopes, sync, webhooks, writes).
Production is the same recipe with real consequences, so each step has a
check you can see before taking the next.

## 0. Before touching Render (Developer Console, Production tab)

- [ ] **Production credentials exist**: Client ID, Client Secret, API key on the
      *Production* tab (they differ from staging). If "Publish" was required
      to unlock production, it has been approved — scopes must have been
      proven in staging first (done).
- [ ] **Production scopes** match staging: `documents/read events/read
      events/write firm/read matters/read mattertypes/read memos/read
      staff/read tasks/read tasks/write webhooks/read webhooks/write` — plus
      **`contacts/read`** if offered (client names come from contacts; without
      it matters show their title instead).
- [ ] **Production auth domain.** The token endpoint for production is shown
      on the Production tab or in Smokeball's API docs. Staging was
      `datastaging-auth.smokeball.com`; production is most likely
      `auth.smokeball.com` — PAM's verify page names the exact failure if the
      domain is wrong (`could not reach the token endpoint` / `400 invalid_…`).
- [ ] **Jeff knows what is about to happen**: PAM will read the firm's live
      matters, tasks, calendar, notes, and document metadata (plus the bodies
      of settlement-related emails); snippets go to Anthropic's API to answer
      questions; writes (task/event creation, rescheduling) only happen after
      he confirms a card, and never anything court-filed/client-facing/money.

## 1. The switch (Render → pam → Environment)

Change exactly these; leave everything else:

| Key | Production value |
|---|---|
| `SMOKEBALL_BASE_URL` | `https://api.smokeball.com` |
| `SMOKEBALL_AUTH_URL` | production auth domain (see 0.) |
| `SMOKEBALL_API_KEY` | Production tab API key |
| `SMOKEBALL_CLIENT_ID` | Production tab Client ID |
| `SMOKEBALL_CLIENT_SECRET` | Production tab Client Secret |

Save → redeploy (~4 min). On boot PAM detects the **source change**
(`stagingapi…` → `api.smokeball.com`) and **wipes the staging mirror** before
the first sync — chat history, settings, memories, audit log all survive.

## 2. Watch it come up (`/healthz`, then `/api/smokeball/verify`)

- `/healthz` → `"web":"built"`, `"storage":"persistent"`, `"mode":"real"`.
- `/api/smokeball/verify`:
  - `allOk: true` and real counts: staff = the firm's roster, matters in the
    hundreds. **The first full sync walks every open matter's folders, files,
    and memos at 4 requests/second — allow 5–15 minutes.** `lastSync` shows
    `kind: "full"` with counts when it finishes; the incremental passes every
    minute after.
  - `webhooks.subscriptions` has one entry pointing at
    `pam-odwo.onrender.com/webhooks/smokeball`. (Appears after the first full
    sync completes.)
- Render log: `[pam] current staff resolved to <uuid>` — PAM found Jeff in the
  real staff list (matched on "Millman"; set `PAM_STAFF_NAME` if the match is
  wrong).

## 3. Map the custom fields (`/api/smokeball/inspect`)

Paste the output to Adam's assistant. It is **field names and types only —
no values** — and it answers the two unknowns that only real data can:

- Which keys under `matter.items` hold the **statute date** and **date of
  loss** (the adapter currently guesses `statuteDate` / `StatuteOfLimitations`
  and `dateOfLoss` / `DateOfLoss`).
- What a real **statute-reminder task title** looks like, so the never-move
  guard matches the firm's 6/3/1-month reminders exactly (it currently matches
  "statute", "SOL", "limitations").

Also worth a glance: `/api/settlements` — the board on real notes. Parsing
expects Jeff's dictated labels (`Insurance:`, `Claim No.`, `Policy limits:`,
`Adjuster:`, `Demand:`, `Offer: $X made <date> by <name>`); dates may be
`7/21/26`, `July 21, 2026`, etc. Matters whose notes use other wording simply
won't appear until a note is written in that shape.

## 4. Shadow week (the gate from docs/06)

Jeff uses PAM alongside Smokeball for 5–10 working days:

- **Morning**: Today page vs his Smokeball calendar + tasks. Any difference is
  filed (screenshot + what Smokeball shows).
- **Settle tab** vs his own knowledge of each negotiation — especially any
  "sent" claim: PAM must never say sent without email evidence.
- **Voice**: "what's on my calendar", "what's overdue", "where do we stand on
  <client>", one reschedule and one task creation — each confirms before acting.
- **Memory**: "remember that…" once, then check Settings → *What PAM remembers*.

**Gate: 10 consecutive clean morning briefs.** Until then PAM is advisory.

## 5. Things that are deliberately NOT automatic

- Writes always need Jeff's spoken/typed yes on a card. Statute reminders
  never move. Nothing is filed, sent to clients/counsel, or money-related.
- Memory refuses client names, matter numbers, dollar figures, case facts —
  in code, audited.
- If the persistent disk ever goes missing, PAM boots **in memory** and says
  so loudly in the verify page and log (settings/chat would then be ephemeral).

## 6. Rollback

Set the five env values back to staging (or clear `SMOKEBALL_BASE_URL` for the
demo) and redeploy. The source-change guard wipes the production mirror from
the disk on the next boot; PAM's own data stays.

## 7. Still open after go-live

- Subdomain (e.g. `pam.pmlawny.com`) and who controls the firm's DNS.
- Chat-history retention policy (default: keep, purgeable).
- Smokeball security review / production-app promotion paperwork, if their
  Publish flow asks for it.
- Office-calendar / court list: the real API has no flag; PAM reads court
  appearances from the event title/location (court, judge, hearing, trial,
  conference, Part N). Tune after a week of real titles.
