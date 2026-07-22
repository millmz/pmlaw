# 03 — Safety, Permissions, and Confidentiality

## Hard rules (enforced in code, not just in the prompt)

The system prompt states these, but **every one must also be enforced mechanically** — a rule that exists only in the prompt is a suggestion, not a control.

| Rule | Mechanical enforcement |
|---|---|
| No write action without confirmation | Write tools require a `confirmation_token` minted only when the UI confirmation card is accepted; the token is single-use, short-lived, and bound to the exact payload hash |
| No deletes in early releases | Delete endpoints are simply not implemented in the tool layer |
| Hard-deadline tasks never moved without enhanced confirmation | `update_task_due_date` checks the task's category/linked-deadline flags server-side and requires a second, distinct confirmation token |
| Claude never sees API credentials | Tokens live only in the backend; Claude calls named tools, the backend makes API requests |
| Claude can't invent API calls | Closed tool registry — Claude can only invoke the defined tool functions with validated (Zod/JSON-schema) parameters |
| No cross-matter data merging | Tool responses tag every record with its matter ID; retrieval is always matter- or user-scoped, never "search everything" |
| No model training on firm data | Use the Anthropic API (standard API data usage: not used for training). Confirm current terms during vendor review; document the data-processing posture for the firm |

## Confirmation flow for writes (Phase 2+)

1. User asks for an action in chat.
2. Claude calls `propose_<action>(payload)`. The backend validates the payload, resolves ambiguities (or returns candidates for the user to pick), checks for conflicts (e.g. calendar overlap), and returns a **confirmation card** rendered in the UI: exactly what will be created/changed, on which calendars, linked to which matter.
3. User clicks Confirm (or says "confirm" — but the card is always shown). Backend mints a single-use confirmation token bound to the payload hash.
4. Claude (or the UI directly) calls `execute_<action>(confirmation_token)`. Any payload drift invalidates the token.
5. Backend performs the Smokeball API call, writes an audit log entry, and returns the created record's ID/link.
6. **Enhanced confirmation** (deadline-related changes): the card displays the deadline's source record and requires typed confirmation ("move it anyway"), not just a click.

## Audit log

Every tool invocation (read and write) is logged: timestamp, user, tool name, parameters, matter IDs touched, result summary, and for writes: before/after values, confirmation token ID, and free-text reason when given. Retained indefinitely; exportable. This is also the debugging record for "why did LawMan say that?"

## Permissions model

- **v1 (single user):** The app authenticates Jeff via the firm's Smokeball OAuth grant. All data access runs under that grant. App-level login (the chat UI itself) still required — do not expose an unauthenticated UI that holds firm-wide data.
- **Multi-user (later):** Determine in Sprint 0 whether the Smokeball API enforces per-user matter permissions or grants firm-wide access to the integration. If firm-wide (likely), LawMan must mirror Smokeball's permission model in its own authorization layer before adding a second user — mapping app users to Smokeball staff IDs and filtering every query and every cache read by that staff member's matter access. **Do not add user #2 until this exists.** The cache/database must store matter-level ACLs so cached data is filtered identically to live data.

## Confidentiality and privileged data

Everything in this system is client-confidential and much of it privileged. Consequences:

- **Hosting:** Backend + database in a reputable US-region cloud; encryption at rest and in transit; no public database endpoints. Prefer a single-tenant deployment the firm controls.
- **Logging:** Application logs must not ship document contents or email bodies to third-party log services. Log record IDs and metadata, not content. The audit log lives in the firm's own database.
- **LLM data flow:** Matter content is sent to the Anthropic API to be processed (that's the product). Document this clearly for the firm's vendor/confidentiality review before production use: what is sent, when, retention, and the no-training posture. Add redaction controls only if that review demands them.
- **Secrets:** OAuth client secrets and tokens in the platform secret store (never in the repo, never in Claude's context). Refresh tokens encrypted at rest.
- **Data retention:** Cached Smokeball data is deletable and re-syncable at any time (the cache is disposable by design). Chat history retention is a firm decision — default to retaining (it's useful context) with an easy purge.
- **Backups:** Daily encrypted database backups; the Smokeball data itself is recoverable by re-sync, so backups mainly protect the audit log and chat history.

## System prompt principles (summary — full prompt lives in code)

- You are LawMan, an internal case-management assistant for Phillips & Millman, LLP. Smokeball is the system of record.
- Never invent records. Clearly distinguish retrieved facts from inferences. Cite sources for material statements ("Smokeball shows…", "I found an email dated…", "I could not verify…").
- Never take a write action without presenting the proposed action and receiving confirmation.
- Treat statutes of limitations, filing deadlines, and court dates as high-risk: show the source, warn on incomplete or conflicting information.
- Never assume a document was sent because it exists in a folder.
- When a request is ambiguous, retrieve likely matches and ask the user to choose.
- Do not provide legal advice to clients or make strategic legal decisions.
