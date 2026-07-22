# 02 — Smokeball API: What It Actually Supports

Researched 2026-07-22, primarily from Smokeball's own public GitHub repos, which contain the source of docs.smokeball.com and the full OpenAPI spec (updated 2026-07-17): [`smokeballdev/api-docs`](https://github.com/smokeballdev/api-docs), [`smokeballdev/docs`](https://github.com/smokeballdev/docs), [`smokeballdev/sdk-docs`](https://github.com/smokeballdev/sdk-docs). Items marked ⚠️ are inferred from secondary sources or couldn't be verified; Sprint 0 confirms them.

## Bottom line for LawMan

**The core product is feasible.** Matters, tasks (with subtasks), calendar events, files/folders (including download and full-text content search), memos, contacts, staff, and custom-field layouts are all readable; tasks and events are writable; webhooks cover the records we care about. The settlement-intelligence feature is feasible too — matter-linked **emails are exposed as files** (with to/from metadata and downloadable full content), which is exactly the evidence trail we need. The real constraints are operational: a **5 requests/second rate limit** (validates the sync/cache architecture), **asynchronous writes** (affects the confirmation UX), no documented deep links, and an access-approval process that starts with the firm's account manager.

## Getting access (start this immediately — it gates everything)

- Access is not self-serve. For a firm building its own internal integration: request API access through the firm's **Smokeball account manager**, or the "Smokeball Firm API Access Request Form" on marketplace.smokeball.com. Build as a **Private App** (single firm).
- ⚠️ Firm API access reportedly requires the **Prosper+ plan** — confirm what plan Phillips & Millman is on with the account manager. This could be a hard blocker or an upsell conversation.
- Approval unlocks the **Developer Console** (console.smokeball.com): app credentials, API keys, and **staging environment** with test accounts (`stagingapi.smokeball.com` / `datastaging-auth.smokeball.com` / `rc-app.smokeball.com` for US).
- **Scopes are granted by Smokeball per app** (there's a scope-request form) — request everything LawMan needs up front: staff, matters, matter types, contacts, tasks, events, files/folders, file search, memos, layouts, webhooks.
- Production requires passing Smokeball's **security review** (questionnaire + data-handling review). Budget time for it; our single-tenant, encrypted, no-training posture ([docs/03](03-safety-and-permissions.md)) is the answer sheet.
- ⚠️ Cost and approval timeline are undocumented. Ask directly.

## Auth (confirmed)

- OAuth 2.0 (AWS Cognito): **Authorization Code** (per-user) and **Client Credentials** (machine-to-machine) grants. Private apps may use either.
- Access token: **60 min**; refresh token: **30 days** (longer negotiable). Every request needs `x-api-key` + `Authorization: Bearer`.
- **Recommended for LawMan:** Client Credentials with the **`UserId` header** set to Jeff's user ID — the API then enforces Smokeball's per-user matter/file permissions, and this is also the path to multi-user later (one header swap per app-user). Paths are prefixed with the accountId.
- Operational trap: **webhook subscriptions are auto-deleted when the refresh token expires or access is revoked** — the sync worker must verify/recreate subscriptions on every auth refresh cycle.

## Capability matrix

| LawMan requirement | API reality | Status |
|---|---|---|
| Staff list, user identity | `/staff`, `/firmusers` (staffId↔userId mapping) | ✅ Full |
| Matter search/filter | `/matters` with search, MatterTypeId, Status, ContactId, UpdatedSince filters; AND-only search syntax | ✅ Full (practice area via matter types) |
| Matter types / practice areas | `/mattertypes` (Smokeball-curated, read-only) | ✅ Read |
| Tasks incl. subtasks | Full CRUD; multiple assignees, due dates, categories, completion; filter by MatterId/IsCompleted/UpdatedSince | ✅ Full |
| Calendar events | `/events` CRUD; matter-linked; staff attendees; IANA timezones. **No group-calendar resource** — the "office calendar" is derived by querying events and filtering by attendees. **Recurring events are read-only** (can't create/update them) | ✅ Read; ⚠️ writes limited to non-recurring |
| Files/folders | Folder tree CRUD, file list, **download via presigned URL**, upload, versions, history | ✅ Full |
| Full-text document search | **`POST /search/files`** (added May 2026): account-wide search over file **name and content**, filterable by extension/author/contact/date | ✅ Huge win for settlement-package detection |
| Matter-linked emails | **No email API** — but emails are exposed **as files** (Emails folder) with `to`/`from` metadata and downloadable full content. No send capability | ✅ Readable (via file download + parsing); ❌ no send (fine — sending is out of scope anyway) |
| Memos/notes | Full CRUD (RTF + plain text) | ✅ Full |
| Custom fields | Layouts API: read layout designs, read/write per-matter layout data | ✅ Full (AI Matter Summary could live here) |
| Activity history | **No matter activity/audit endpoint.** Substitute: webhooks + `UpdatedSince` polling + our own cache timestamps | ⚠️ Derived, not native — "last activity" = max(updated) across cached record types |
| Webhooks | CRUD + test endpoint; events for matter/task/event/memo/contact/staff/files.updated/stage/layout + special **`error`** event for failed async writes; HMAC-SHA256 signed; no ordering, duplicates possible | ✅ Good coverage |
| Rate limits | **5 req/s, burst 5**, 429 on excess; higher negotiable | ⚠️ Low — sync/cache layer is mandatory, sync worker must queue + backoff |
| Write semantics | **All POST/PUT are async** — success response ≠ committed; failures arrive via the `error` webhook; `RequestId` header correlates | ⚠️ Confirmation UX must wait for webhook/poll confirmation before reporting "created" |
| Deep links into Smokeball | **Undocumented.** No public URL scheme for matter/task/event. (In-app navigation exists only via the desktop Plugins SDK, which is partner-gated and desktop-only) | ❌ Assume unavailable: citations show matter number/name + record identifiers instead. Test `app.smokeball.com` URL patterns empirically in Sprint 0 |
| Billing (out of scope) | Fees/expenses R/W, invoices read-only, trust transactions | n/a |

## Consequences for the design

1. **Sync worker is confirmed as mandatory** (5 rps). Initial full sync of a firm's matters/tasks/events/file-metadata must be throttled and may take hours — fine, it runs once, then webhooks + incremental `UpdatedSince` pulls keep it fresh.
2. **Settlement pipeline shape:** find `Settlement Package` folders (fuzzy match) via folder tree → identify package docs by metadata + `/search/files` content search → list Emails-folder files, match by filename/attachment/date/`to` field → download candidate email files (.eml/.msg) → parse (headers, recipients, dates, attachment names) with Haiku assist for fuzzy cases → store conclusions + evidence IDs. Email bodies are only fetched for matters under analysis, cached encrypted, never bulk-indexed unrestricted.
3. **Write confirmation flow gets a fourth step:** propose → confirm → execute → **verify** (await the record's webhook or poll until visible; surface the `error` webhook if the async write failed). The UI says "Creating…" until verified.
4. **"Office calendar" and conflict detection** are computed in our cache across all staff attendees — actually easier than a group-calendar API.
5. **No deep links (probably):** citations render as "Matter 2024-0117 · Millman v. — Email: 'Settlement demand', May 6" with copyable identifiers. If Sprint 0 discovers working web-app URL patterns, upgrade to links.
6. **Recurring events:** LawMan reads them but declines to create/modify them (tells the user to do it in Smokeball).

## Archie overlap (Smokeball's own AI)

Smokeball ships "Archie", and its May 2026 "Next Generation" release is agentic: matter Q&A with citations, document review/comparison, drafting in Word/Outlook, chronologies, transcription. **Don't compete with Archie on single-matter Q&A and drafting.** LawMan's differentiated ground, which Archie doesn't occupy: **cross-matter reporting** (stalled matters, missing next tasks, court-date rollups), **the PI settlement follow-up workflow**, **conversational task/calendar writes with confirmation**, and **the proactive morning brief**. Revisit this boundary each phase — if Archie ships a feature, drop ours.

## Sprint 0 checklist (updated with research findings)

1. Ask the account manager: API access for a private firm app, plan requirements (Prosper+?), cost, timeline; submit the Firm API Access Request Form.
2. Request scopes: staff, firmusers, matters, mattertypes, contacts, tasks, events, files (+search), memos, layouts, webhooks.
3. Developer Console: create Private App (Client Credentials), staging test account.
4. Throwaway script against staging proving: token flow (+ refresh) → current user via `UserId` header → staff → open matters → today's events → today's tasks → one matter's folder tree, file list, an email file's `to`/`from` metadata, and a **downloaded + parsed email file**.
5. Test `/search/files` content search for "settlement".
6. Register a webhook, mutate a record in the staging web app, verify delivery + signature; test the `error` event with an invalid write.
7. Empirically probe `app.smokeball.com` URL patterns for matter deep links.
8. Verify per-user permission enforcement: `UserId` header with a restricted test user vs. without.
9. Measure real rate-limit behavior and full-sync duration estimate for the firm's matter count.
10. Write the final capability matrix deltas back into this doc; every ❌/⚠️ gets a decided workaround.
