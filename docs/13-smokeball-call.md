# Smokeball API discovery call — briefing sheet

Prepared for Adam. Smokeball's stated agenda: the use case, how it's handled
today, what data the API will pull, "and so on." Twenty minutes booked as
thirty. Everything below is true of the build as it exists — nothing
aspirational except where marked.

## The one-paragraph pitch

We've built an internal assistant called PAM for Phillips & Millman, LLP — a
six-attorney trial firm in Stony Point, NY, on the Prosper+ plan (Jeff
Millman is the account admin). PAM sits **on top of** Smokeball: a quiet
daily-docket dashboard and a conversational (voice-capable) assistant that
answers questions like "what are the top five cases I'm negotiating on?"
from the firm's own matter data. Smokeball stays the system of record — PAM
reads, caches, and cites; it writes almost nothing. The app is fully built
and running today against a mock of the Smokeball API that we generated from
the public OpenAPI spec; we're here to swap the mock for the real thing.

## Their likely questions, answered

**What are you trying to accomplish?**
Give the firm's founding partner a faster way to consume what's already in
Smokeball: his day's calendar, tasks due, overdue triage, statute-of-
limitations reminders, and a settlement-negotiation board parsed from matter
memos (insurer, adjuster, demand, offers, package-sent verification from the
emails on the matter). Plus an assistant he can talk to that answers from
that same data with citations. Think "senior legal secretary who has read
every file," not a replacement for any Smokeball screen.

**How is this handled today?**
Manually, in Smokeball's own screens — which works, but the partner is in
court most days. Settlement status lives in matter memos in a consistent
dictated format; packages go out by email (files on the matter) and by
mail. Today someone reads through matters one at a time to reconstruct "what's
in negotiation." PAM assembles that view automatically and keeps it current.

**What data will the API pull?** (read-heavy, narrow writes)
Reads, on an incremental sync loop:
- `GET /staff`, `GET /mattertypes` — reference data
- `GET /matters` (with UpdatedSince) — matter list, status, type, client
- `GET /tasks`, `GET /events` (with UpdatedSince) — the docket and task load
- `GET /matters/{id}/folders`, `/files`, `/memos` — documents, emails-as-files,
  and notes for the settlement engine
- `GET /matters/{id}/files/{id}/download` — file/email content via the
  presigned-URL flow, used sparingly (settlement-package verification, liens)
- `POST /search/files` — targeted lookups from chat
- `POST /webhooks` — subscribe to update events so the cache stays fresh
  without polling hard

Writes — deliberately minimal, each behind an explicit human confirmation in
the UI and a full audit log:
- `PUT /tasks/{id}` — reschedule a task's due date (live today)
- `POST /tasks`, `POST /events` — creating a task/calendar entry (next on the
  roadmap, same confirmation pattern)
Nothing court-filed, client-facing, or money-moving is ever automated.

**Volume / rate expectations?**
One firm, single tenant. Full sync on boot, then an incremental pass every
minute using UpdatedSince plus webhooks. Our client is rate-limited to ~4
requests/second with retry-on-429 — under the 5 rps we saw referenced. File
downloads are on-demand and cached. This is small: hundreds of open matters,
a handful of users.

**Architecture / where does the data live?**
A single server (Render, US region) with its own database acting as a read
cache of the Smokeball data, plus an append-only audit log of every question
asked and every write proposed/executed. API credentials live server-side
only. The web app is access-code gated for the firm. One honest disclosure:
the assistant uses Anthropic's Claude API, so relevant snippets of matter
data are sent to Anthropic to generate answers (standard API terms — not
used for training). If Smokeball has a data-processing position on that, we
want to hear it on this call.

**Auth?**
Whatever their standard is — the spec suggests OAuth2 bearer plus an API-key
header, which is what our client already implements. We'd like: (1) how app
registration works, (2) whether there's a sandbox/staging tenant for
integration testing before we point at production, (3) webhook signing
details (we've implemented HMAC-SHA256 verification against the spec).

**Timeline?**
The cutover kit is ready — the app runs against a spec-faithful mock today.
Given credentials, the swap is a config change (base URL + auth), then a
verification pass. Days, not months.

## Our questions for them (get these answered)

1. Sandbox or staging environment available? Test tenant?
2. App registration / credential issuance process and turnaround.
3. Confirm auth flow (OAuth2 grant type, token lifetime, refresh).
4. Webhook signing scheme + retry policy; can we register multiple event types
   on one endpoint?
5. Rate limits per endpoint — is 5 rps global or per-resource?
6. Emails on matters: confirmed they surface as files? Any separate
   correspondence endpoint we should prefer?
7. Any per-seat or API pricing implications on Prosper+?
8. UpdatedSince semantics: server clock or version cursor? Deletes visible?
9. Deep links: any way to link from PAM into a specific Smokeball matter/task
   (desktop app or web) — the spec didn't show one.
10. Who's our technical contact once credentials are issued?

## If they ask "who's building this"

Adam Millman (Jeff's son) is running the project; the implementation is a
TypeScript service, developed against their published OpenAPI spec, with a
full test suite including a mock of their API. Jeff is the firm sponsor and
account admin — optional on this call, per their note.
