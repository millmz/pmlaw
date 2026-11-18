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

## 1. The switch (Render → pam → Environment) — in SHADOW MODE

Change exactly these; leave everything else. The sixth line is the point:
with `PAM_WRITES=off` PAM reads the firm's real account but refuses every
write (cards still show what would happen), so the first week carries zero
risk of touching Smokeball. Remove it after the shadow gate.

| Key | Production value |
|---|---|
| `SMOKEBALL_BASE_URL` | `https://api.smokeball.com` |
| `SMOKEBALL_AUTH_URL` | production auth domain (see 0.) |
| `SMOKEBALL_API_KEY` | Production tab API key |
| `SMOKEBALL_CLIENT_ID` | Production tab Client ID |
| `SMOKEBALL_CLIENT_SECRET` | Production tab Client Secret |
| `PAM_WRITES` | `off` (shadow mode; delete the variable to enable writes later) |

Save → redeploy (~4 min). On boot PAM detects the **source change**
(`stagingapi…` → `api.smokeball.com`) and **wipes the staging mirror** before
the first sync — chat history, settings, memories, audit log all survive.

## 2. Watch it come up (`/healthz`, then `/api/smokeball/verify`)

- `/healthz` → `"web":"built"`, `"storage":"persistent"`, `"mode":"real"`,
  `"writes":"off (shadow)"`, `"brain":"ok"`. The app shows a **Trial · read
  only** badge in the top bar while writes are off.
- **The app itself tells you where it is.** A banner reads *"PAM is reading
  your Smokeball for the first time"* with a progress bar; the header pill
  goes First sync… → Synced. The order is deliberate: staff → matter types →
  matters → **tasks and calendar (usable within a minute or two)** → client
  names → each open matter's notes, files, and folders. Allow 5–15 minutes
  for the whole walk at 4 requests/second; the docket does not wait for it.
- `/api/smokeball/verify`:
  - `allOk: true` and real counts: staff = the firm's roster, matters in the
    hundreds. `lastSync` shows `kind: "full"` with counts when the first read
    finishes; incremental passes run every minute after.
  - `lastSync.warnings` lists anything PAM could not read (e.g. `files: 3
    matter(s) could not be read … likely a missing scope`). A warning never
    stops the sync — the rest of the firm still loads.
  - `webhooks.subscriptions` has one entry pointing at
    `pam-odwo.onrender.com/webhooks/smokeball`. (Appears after the first full
    sync completes.)
- **Restarts are cheap.** A redeploy resumes from where the mirror left off
  (log: `mirror present — catching up incrementally`); the firm is re-read in
  full only on first run or a source change. To force one:
  `POST /api/sync?full=1` (runs in the background; watch the header pill).
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

The adapter now also *searches* `matter.items` by key name (anything like
"statute", "limitation", "SOL", "date of loss/accident/incident", "index
number", "in suit"), so these may simply work — the inspect paste confirms it.

### The Settle board on real data

A matter gets a settlement analysis when **any one** of these is true: its
matter type reads like injury work (personal injury, negligence, malpractice,
MVA, slip and fall, wrongful death… by the firm's own wording), it has a
Settlement Package folder or document, or its notes talk settlement money.
Criminal, real-estate, and estate matters stay off.

Notes are read two ways:

1. **Labelled lines** (`Insurance:`, `Claim No.`, `Policy limits:`,
   `Adjuster:`, `Demand:` / `Demand of`, `Offer:` / `offered $X on <date> by
   <name>`) are parsed directly.
2. **Free-form notes** ("Boland came up to 45k on June 9, we're holding at
   120") go to a small model (`PAM_NOTES_MODEL`, default Haiku; set to `off`
   to disable). Every figure, name, and date it returns must appear
   word-for-word in the notes or it is discarded. Rows read this way carry a
   **Read from notes** tag.

"Sent" still requires email evidence from a firm address. PAM learns the
firm's domains from the staff list; add others with
`PAM_FIRM_EMAIL_DOMAINS=pmlawny.com,otherdomain.com`. Outlook `.msg` emails
are read; scanned PDFs and Word files are listed but not read.

The first time the board is opened after the first sync it may say *"PAM is
still reading the firm's matters — N of M reviewed"* and fill in as it goes;
after that it is instant, including across restarts.

### Checking the live system without reading a file (`/api/diag`)

`/settings?admin=1` → **Health check** → *Open the health report*. The page
is counts and coverage only — how many open matters carry a statute date,
whether tasks and calendar entries resolve to people on the staff list, how
many notes are in a shape the Settle board can read, what the board found,
and how long the last answer took. No client name, matter number, note, or
figure appears in it, so it can be pasted to Adam's assistant as-is.

The same card shows a **diagnostics key**. Sent as an `x-pam-key` header it
opens only the health pages (`/api/diag`, `/api/status`,
`/api/smokeball/verify`, `/api/smokeball/inspect`) — never Today, tasks,
matters, settlements, or chat.

### The orb room

- **Speed.** Her first words should come about a second after a question
  ends; a full answer in two to three. *System check* in the orb room shows
  the last answer's timing; the Render log has a `[pam] turn (voice): …`
  line per question with where the time went.
- **Models.** The orb room runs `PAM_VOICE_MODEL` (default Claude Haiku 5.5:
  fastest to first word, and it passes the same safety evals); typed chat
  runs `PAM_MODEL` (default Claude Sonnet 5.5). If the voice model is not
  available to the API key, PAM answers with the main model and says so in
  the log.
- **Voice.** With an ElevenLabs key she speaks in the chosen voice, streamed
  as it is generated; without one (or if the key fails) the browser's voice
  takes over — *System check* names which, and why.
- **Listening.** Chrome, Edge, and Safari use the browser's recognizer. Other
  browsers record the question and transcribe it through ElevenLabs (the
  key needs speech-to-text permission); the recording is not kept.
- **Keys.** Tap the orb or press Space to talk; tap or press Space again to
  interrupt her; Escape quiets everything.

## 4. Shadow week (the gate from docs/06)

Jeff uses PAM alongside Smokeball for 5–10 working days:

- **Morning**: Today page vs his Smokeball calendar + tasks. Any difference is
  filed (screenshot + what Smokeball shows).
- **Settle tab** vs his own knowledge of each negotiation — especially any
  "sent" claim: PAM must never say sent without email evidence.
- **Voice**: "what's on my calendar", "what's overdue", "where do we stand on
  <client>", one reschedule and one task creation — each confirms before acting.
- **Memory**: "remember that…" once, then check Settings → *What PAM remembers*.

- **Flag** (top bar, or `[ flag that answer ]` in the orb room): anything
  wrong or awkward, in a sentence, the moment he sees it. Flags collect under
  Activity → *Flagged for review* — that list is the week's punch list.

**Gate: 10 consecutive clean morning briefs.** Until then PAM is advisory.

### The first showing (15 minutes, in this order)

1. **Today** on the big screen — his real day. Tap a later day tab.
2. **Brief me** — PAM reads him the day out loud.
3. Orb room: tap the orb and ask *"What am I negotiating?"*, then *"Where do
   we stand on <a client he names>?"*
4. **Settle** — his cases in play; tap an adjuster's number.
5. Ask her to move a task: she shows the card and explains she is read-only
   for the trial. That is the trust moment — nothing changes without him.
6. Show him **Flag**. Hand him the phone and let him try the orb himself.

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
