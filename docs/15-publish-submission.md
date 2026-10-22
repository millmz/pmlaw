# Smokeball "Publish" submission — answer sheet

For promoting PAM from staging to production in the Developer Console.
Every statement below is true of the build as deployed; paste as-is, trim
to fit their fields. Where a field needs something we don't have yet, it's
flagged **[NEEDS]**.

## App identity

- **App name:** PAM
- **Short description:** Day-to-day business assistant for Phillips & Millman, LLP.
- **Long description:** PAM is a private, single-firm assistant that sits on
  top of Smokeball for Phillips & Millman, LLP (Stony Point, NY). It gives the
  firm's founding partner a quiet daily docket (calendar, tasks, overdue
  triage, statute-of-limitations reminders), a settlement-negotiation board
  derived from matter notes and document metadata, and a voice/chat
  assistant that answers questions from the same data with citations to the
  underlying Smokeball records. Smokeball remains the system of record. PAM
  reads and caches; it writes only three things (task reschedule, task
  creation, calendar-event creation), each behind an explicit in-app
  confirmation by the user and a full audit log. Nothing filed with a court,
  sent to a client or opposing counsel, or touching money is ever automated.
- **Audience / distribution:** Private app — restricted to the account
  "Partner – Phillips & Millman, LLP". Not listed, not available to other
  firms. One user (the account admin, Jeff Millman); administered by Adam
  Millman.
- **Website / support contact:** **[NEEDS]** a support email (suggest
  Adam's) and, if they require a URL, the firm site https://www.pmlawny.com/.
- **Privacy policy URL:** **[NEEDS]** — if required for a private app, a
  one-page policy on the firm site (or a Google Doc link) stating: data read
  from Smokeball is processed solely to assist firm staff; stored on the
  app's own server in the US; not sold or shared; snippets sent to
  Anthropic's API to generate answers under Anthropic's API terms (no
  training on customer data); deletable on request.

## Technical

- **Grant type:** Client Credentials (machine-to-machine). No end-user OAuth
  login; the app has its own access-code login for the firm.
- **Redirect URI:** not used (client credentials). If the form insists:
  `https://pam-odwo.onrender.com/oauth/callback` (unused placeholder).
- **Webhook notification URL:** `https://pam-odwo.onrender.com/webhooks/smokeball`
  — HTTPS, HMAC-SHA256 signature verified on every delivery
  (`timestamp|requestId|clientId` with the subscription key).
- **Hosting:** Render (US), single web service with a persistent disk; TLS
  terminated by Render; credentials held only in Render's environment store.
- **Rate limiting:** client self-limits to ~4 requests/second with retry on
  429; incremental sync once per minute using `LastUpdated` cursors plus
  webhook triggers; full sync only at first connection or source change.
- **Environments tested:** fully exercised in staging (auth, scopes,
  sync, webhooks, async writes verified by read-back). Production will run
  in a read-only "shadow" mode (all writes disabled by configuration) for the
  first weeks.

## Scopes requested (least privilege) and why

| Scope | Why PAM needs it |
|---|---|
| `firm/read` | firm identity / time zone |
| `staff/read` | map the user and assignees; resolve note authors |
| `mattertypes/read` | practice-area classification (PI / med-mal / criminal) |
| `matters/read` | matter list, status, client refs, custom fields (statute date, date of loss) |
| `contacts/read` | client names on matters (display only) |
| `tasks/read` | daily task list, overdue triage, statute reminders |
| `tasks/write` | reschedule a task's due date / create a task — only after the user confirms a preview card in the app |
| `events/read` | calendar, court list, conflict checks |
| `events/write` | create a calendar entry — only after the user confirms |
| `memos/read` | matter notes: the firm's settlement-negotiation source of truth |
| `documents/read` | folder/file inventory; settlement-package detection; reading settlement-related email bodies to verify a package was actually sent |
| `webhooks/read`, `webhooks/write` | keep the cache fresh in near real time instead of polling hard |

Not requested: anything billing, trust accounting, invoicing, contacts
write, documents write, matter write, staff write.

## Data handling / security (typical questionnaire answers)

- **What data is stored?** A mirror (cache) of the records above for the one
  connected firm, in the app's own database on an encrypted Render disk;
  plus PAM's own data (chat history, user preferences, audit log).
- **Where?** United States (Render).
- **Who can access it?** The firm's user via an access-code login (sessions
  are HMAC-signed, timing-safe compared). Adam Millman as administrator. No
  third-party users.
- **Encryption:** TLS in transit everywhere (Smokeball API, Anthropic API,
  ElevenLabs API, browser). At rest: Render disk encryption.
- **Secrets:** API keys and client secrets live only in Render's environment
  store; never in source, logs, or the browser. The app's diagnostics
  deliberately expose only key *shape* (prefix/length), never values.
- **Sub-processors:** Anthropic (Claude API — generates answers from
  snippets of matter data; API data is not used for model training per
  Anthropic's terms); ElevenLabs (text-to-speech of PAM's replies — the
  spoken text only); Render (hosting).
- **Writes:** three verbs only; each requires an explicit confirmation by the
  user in the same conversation; single-use payload-bound tokens; every
  write is verified against the API and recorded in an audit log. A
  configuration switch disables all writes (used for the production trial).
- **Deletion / revocation:** disconnecting the app (revoking credentials)
  stops all access immediately; the cache can be wiped on request; chat
  history is purgeable.
- **Logging:** application logs contain record ids and counts, not note or
  document contents. Rejected writes and auth failures are logged by reason
  code only.
- **Incident contact:** **[NEEDS]** Adam's email/phone.

## If they ask for a demo or screenshots

Login → Today (docket) → Tasks (overdue split, statute reminders quarantined)
→ Settle (board with "sending could not be verified" honesty) → the orb
(voice) → Settings (voice ID, memory list) → Activity (the audit log).
Screenshots exist in the repo under `e2e/screenshots/`.
