# 08 — Jeff's Interview Answers

Recorded 2026-07-27, full 25-minute session covering all 11 sections. Substance is Jeff's; lightly condensed from the transcript.

**Redactions:** client and adjuster names appear as `[Client]` / `[Adjuster]` — this planning repo is not the system of record and shouldn't hold client specifics ([docs/03](03-safety-and-permissions.md)). Staff names are kept (needed for the build); judge and court names are kept (public record, and they're examples of event naming).

---

## 1. His morning

**Email first, in Outlook.** Clears junk, reads what matters. Client emails get **attached to the Smokeball matter from inside Outlook**: types the client's first name at the bottom of the email, Outlook populates matches, he picks the right matter, email is linked.

**Then Smokeball, in this order:**
1. Schedule for **today**
2. Schedule for the **week**
3. **Tasks due today** (shown in black = not overdue)

**Then he triages tasks.** Opens a task he knows he won't get to and reassigns the due date — "that's a Wednesday thing, move it to Wednesday the 29th."

**Then overdue — typically 10–15.**
- Some are **statute-of-limitations reminders. He leaves those alone deliberately.**
- The rest he moves to today or pushes out.
- He keeps the box clean on purpose. "Some of the employees in my office have 100, 200 things in overdue" — he tells them to update, move, or delete.

**Completed tasks** disappear from his view into a completed subfolder he rarely opens.

**Then he opens the matter he's working on** — to see what his last negotiation discussion was.

### Inside a matter (critical)

Right side of the matter: **case details**, **upcoming events**, **notes**.

**The notes are where his settlement intelligence lives.** He keeps there: the insurance company, his **demand**, the current **offer**, **the date it was made**, and **who made it**.

> "If Pam has the ability to read my notes, then that would be great… what my demand is, what the current offer is, and who I spoke to is a very important part of what I would like to be able to look at."

**She can.** Smokeball's API exposes memos/notes with full read access including `createdBy`/`updatedBy` ([docs/02](02-smokeball-api.md)). No workflow change needed.

## 2. Calendars

**Conflict detection: he explicitly does not want it.**

> "I wouldn't worry about any of that… oftentimes I will have several courts on the same date, same time, and I just go to one, then I'm done, and I go to the other. That's just part of being a trial attorney."

Scheduling logistics are handled by his secretaries.

## 3. Tasks and deadlines

- **Task categories: not used.** Nobody bothers with them.
- **Task titles carry the structure.** Convention is an initials prefix — `JTM` for Jeff (Jeffrey T. Millman), `FJP` for Frank J. Phillips — then the action and the client: *"JTM – Follow up on the [Client] matter."* He puts the detail in the **title**, not the details field: *"Call the adjuster [Adjuster] to discuss this case"* plus her phone number.
- **Assignment:** defaults to the creator; assignees are checkboxes, so he can add Anthony, Frank, or anyone. He mostly self-assigns; paralegal Isabel sometimes assigns to him and tags the matter so he sees it. Several employees often share one task.
- **Due dates:** always given. **Priority:** optional, available.
- **Statute of limitations tasks are never moved.** > "Those are never allowed to be moved, because that's how you screw up a case."
- **NY vs NJ must be distinguished at intake** so the statute is recorded correctly. NY PI 3 years; NJ 2 years. NY med-mal 2.5 years; NJ 2 years. Reminders fire at **6 months, 3 months, and 1 month** before, to the whole office, defaulted from the date of the accident, set on every matter at intake.

## 4. Matters

- **"Hundreds and hundreds" of open matters.**
- His day-to-day: **personal injury, medical malpractice, criminal.** Occasionally condominium work. Also "debtor hub" — a miscellaneous-type matter he sometimes needs (⚠️ *verify what this is and its exact matter-type name*).
- **Matter stages/statuses: yes, used.**
- **He refers to matters by client name — never caption, never matter number.** "The [Client] matter," first-name-first as spoken. Search by first name usually works; **for common first names he searches by last name**, and occasionally a first-name search unexpectedly returns nothing and he retries with the surname.
- Matter header format: `[Client] 23-1234 Personal Injury Plaintiff` (year-sequence number + practice area).
- **Closed promptly** — when checks are disbursed, flagged closed at the top of the matter, usually by paralegals.

## 5. Settlement workflow (the heart of it)

- **Folder is always named `Settlement Package`.** Standard, auto-created, consistent for the last several years. > "Don't worry about older matters."
- **Process:** he assigns preparation out → package goes to the adjuster **by regular mail *and* email** → the email asks the adjuster to confirm receipt → **he sets a two-week follow-up task** → he calls: confirms receipt, asks their review turnaround, agrees a diary date ("I'll diary August 15 for follow-up, is that good?"), asks whether they need anything else → **creates a task for that agreed date**. The call itself is deliberate: it "puts me on top of their to-do list."
- ⚠️ **Packages are frequently sent as Dropbox links, not attachments** — medical records are too large for insurer mail systems. The email is saved to the matter via Outlook.
- **Adjuster info — name, email, phone, claim number, policy limits — is all in the matter notes.**
- **Follow-up rhythm:** two weeks after sending, then whatever cadence the adjuster's stated turnaround implies.
- **LIENS are first-class and were missing from every prior plan.** There is a standard **`Liens` folder**, and "lien" reliably appears in lien-related file and email names (`workers comp lien`, `lien NYSIF`, `NYSIF lien`), so a keyword search finds them. Liens drive settlement value: > "the lien is $97,000. If I made a demand of $250,000 because that's what the value of the injury is… there is the special damages, which is the liens, and that's another 97… settlement value on that case should be no less than $350,000."
- **Injuries** come from the **bill of particulars** (Pleadings folder) if in suit, otherwise from the settlement package.

### The settlement status board he wants (verbatim wish list)

Injuries · date of accident · insurance company · adjuster name, email, phone · claim number · policy limits · liens · **all prior negotiations and who he spoke to** · statute of limitations.

Adjusters change hands mid-case (he named a three-person chain on one matter), so the negotiation history must record *who* at each step.

## 6. Emails and documents

- **Emails are saved to matters reliably**, by him and by staff. Both he and staff email adjusters.
- **Naming conventions:** none strong, except `Settlement Package` and the `lien` keyword.
- **Standard folders auto-generated per matter type:** Correspondence, Pleadings, Medicals, Settlement Package, Liens. Structure does **not** vary by who opened the matter.
- Ad-hoc folders are occasionally added, e.g. `Expert Joe Smith Reconstruction`.

## 7. People

- **Attorneys:** Frank Phillips (FJP), Jeff Millman (JTM), Anthony Burgandy, Armin Mealy, Joanne Cacavo, Jean Hurley. *(⚠️ verify spellings — dictated, not written.)*
- **Paralegals:** Michelle Treyback, Isabel Topel.
- **Front desk:** Jaylinne Duarte — `office@pmlawny.com`; has no individual task assignment, tasks go to **"front desk."**
- **Permissions are not a concern right now.** > "This is going to be my assistant, so that doesn't really matter." Later: Anthony and Frank.

## 8. Priorities — how PAM should think

1. **His schedule wins** — court appearances for the day above all.
2. **Then tasks.**
3. **Statutes of limitation always win** in principle, but they're never a surprise: they're on the dashboard daily and multiple employees oversee them.
4. Then settlement follow-ups, then client return calls.
5. New intakes arrive as calendar events (client meetings), so they're covered by the schedule.

## 9. When PAM can act — his own words

**Calendaring (use verbatim as the eval case):**

> "Pam, place in my calendar tomorrow 9 o'clock to 11 o'clock, JTM – Town of Clarkstown Justice Court, Judge George Kafinas, and put that all in for the [Client] matter."

Resulting event title: `JTM [Client] Town of Clarkstown Justice Court Judge George Kafinas`, blocking the stated time.

- **Every event he diaries goes to him *and* the Office calendar, 100% of the time.**
- Sometimes shared: > "diary for JTM slash FJP" — meaning he or Frank will attend, not yet decided. Then: "click off that person, click off Office, and click off FJP."
- **Tasks for staff must be assigned to both him and the assignee** so both can see it, and tagged to the matter.

**Reminders:** court dates **one week ahead minimum**. He wants the **full Monday–Friday list for next week on his dashboard no later than the Wednesday before**, and the dashboard must keep reflecting changes as things move, cancel, or get added.

## 10. Smokeball account

- **Plan: Prosper Plus** ✅ — this is the tier that unblocks firm API access.
- **Account manager / admin: Jeff himself.** He approves the API connection.
- **They have already spoken to Smokeball** — awaiting the credentials/info.
- **Windows**, uses both desktop and web app.

## 11. Wish list

**The one thing, done perfectly:**

> "It should track my PI cases for settlement purposes — when they're ready to be settled."

Ready = settlement package sent, **or** in suit with depositions and the client's medical exam done. For each, he wants: defense attorney name (if in suit) so he can call them, the parameters of previous discussions, demand, offers, policy limits, adjuster name and phone, and **a list of the injuries** so he knows what he's negotiating on.

**What he's always wanted to know:**

> "What cases are being negotiated on in the office… if I had a list of 30 cases ready for settlement, I'd like to know who's negotiating on them" — who entered the settlement memos or notes, and whether it was Frank, Anthony, Isabel, etc.

---

# What this changes in the build

## Unblocked

**Prosper Plus is confirmed, Jeff is the Smokeball admin and approves the API connection himself, and the firm has already contacted Smokeball.** The single biggest risk in [docs/02](02-smokeball-api.md) is resolved.

## Cut from scope

- **Calendar conflict detection — removed.** He explicitly doesn't want it; double-booked courts are normal trial practice.
- **AI Matter Summary / custom-field write-back — mostly retired.** He already maintains the summary in notes. PAM reads what exists rather than asking him to duplicate it.
- **Per-user permission enforcement — deprioritized further.** "That doesn't really matter" for v1.

## Added or promoted

1. **The Settlement Status Board is the product's headline feature**, not a chat answer — it's his "one thing." Columns: client · injuries · date of accident · insurer · adjuster (name/email/phone) · claim number · policy limits · **liens** · demand · current offer · last negotiation + who · statute date · next follow-up. Sortable, one screen, all active PI matters.
2. **Liens are a first-class concept** — new to the plan entirely. Standard `Liens` folder plus the reliable `lien` keyword. Settlement value ≈ injury value + liens, so a board without liens is misleading.
3. **"Who's negotiating what"** — a cross-matter view of who last touched settlement notes, straight from memo `createdBy`/`updatedBy`. He's wanted this for years and it's nearly free given the memo API.
4. **Settlement readiness detection** — two paths: package sent, or in-suit with depositions + IME complete.
5. **Next-week court list, delivered by Wednesday** — a concrete proactive trigger with a real deadline, and it must stay live as events move.
6. **Injuries extraction** — bill of particulars (Pleadings) when in suit, settlement package otherwise.

## Changed in the design

7. **Notes/memos are the primary settlement source**, ahead of documents and emails. Sync memos from day one; parse them for insurer, demand, offer, offer date, who, adjuster contact, claim number, policy limits.
8. **Hard-deadline detection cannot use task categories** (unused). It must key off **title text** — the statute reminder pattern (6/3/1 month before a date-of-accident-derived date) plus keywords. The 6/3/1 signature is distinctive enough to detect reliably.
9. **Statute reminders get their own section, out of the actionable overdue list.** They are *expected* to sit there; he already ignores them. Burying real overdue work among them is exactly the noise that makes the list useless.
10. **Overdue is normal (10–15), not an alarm.** Triage and prioritize; never present as crisis.
11. **Task rescheduling is the #1 write feature** — it's his single most frequent daily action, and a batch triage view is worth building.
12. **Morning brief order mirrors his routine:** today's calendar → the week ahead → tasks due today → overdue (split: statute reminders vs. needs a decision). *The week view was missing from the original spec.*
13. **Sent-verification must handle Dropbox links, not just attachments** — a large share of packages go out as links because medicals are too big to attach. Detecting "sent" by attachment alone would produce false negatives on the most important matters. Also: mail-only sends may have **no** email evidence at all, which is a legitimate "could not verify" outcome.
14. **Matter resolution is by client name**, first or last, with last-name fallback for common first names — mirroring how he already searches, including the retry behavior.
15. **Event creation defaults: always Jeff + Office.** Support `JTM/FJP` shared-diary phrasing and the initials-prefix title convention.
16. **Task creation defaults: assign to both Jeff and the assignee**, tagged to the matter. Recognize "front desk" as an assignee.
17. **Priority ordering for the brief:** court appearances today → tasks → settlement follow-ups → client return calls. Statutes are always-visible context, not an interruption.
18. **Sync sizing is comfortable.** Hundreds of matters at 5 req/s means a first full sync in roughly **20–60 minutes**, not the "may take hours" earlier estimated against an unknown matter count. Incremental syncs are minutes.

## Open questions for Jeff (low priority, non-blocking)

- What exactly is **"debtor hub"**, and what is that matter type called in Smokeball?
- Confirm **staff name spellings** (dictated).
- Do the **6/3/1 statute reminders share a consistent title format**? A screenshot of one real example would let us detect them exactly rather than heuristically.
- For the settlement board: is **defense counsel** recorded in a Smokeball field/role, or only in notes?
