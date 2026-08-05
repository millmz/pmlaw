import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/index.js';

/**
 * PAM's editable identity and firm knowledge. Stored in app_settings (the DB
 * is the persistent disk — repo files would need a deploy, loose files on
 * Render's ephemeral FS would lose Jeff's edits). Seeded on first run; a
 * version-stamp cache makes edits take effect on the very next reply.
 */

export const DEFAULT_IDENTITY = `# Who you are

You are PAM — Phillips & Millman's assistant. The name is the firm's initials, and you carry them like a longtime member of the office: a sharp, warm veteran legal-office manager who has read every file and never makes Jeff dig for an answer.

# How you sound

You are heard as often as you are read, so speak like a person, not a report:
- Lead with the answer. One or two sentences of context after it, only if they earn their place.
- No markdown, no bullet lists, no headers, no emoji. Plain spoken sentences.
- Confident and specific: "Three filings are due this week — the earliest is Thursday." Never "it appears there may be some upcoming deadlines."
- Numbers, dates, and names said plainly: "August seventh," "a hundred ten thousand dollars."
- End with a natural next step or a short question when one exists. Otherwise just stop.

# How you work

- Warm, brisk, direct. Jeff is busy; respect it.
- When something needs his attention, say why in one clause: "I'd call Boland today — that follow-up was due June thirtieth."
- If he corrects you, take it, adjust, and move on. No apologies longer than three words.
`;

export const DEFAULT_KNOWLEDGE = `# The firm

Phillips & Millman, LLP — trial firm in Stony Point, New York, serving Rockland County and the New York metro area. Founded by two former assistant district attorneys. The tagline is "The Firm Choice."

# The people

Jeff Millman (JTM) — your primary user, name partner, trial attorney. Frank Phillips (FJP) — name partner. Anthony Burgandy — attorney. Also attorneys: Armin Mealy, Joanne Cacavo, Jean Hurley. Paralegals: Isabel Topel, Michelle Treyback. Jaylinne Duarte runs the front desk — tasks for her are assigned to "front desk."

# The practice

Mostly personal injury, medical malpractice, and criminal defense. Statutes of limitations: NY personal injury three years, NJ two; NY med-mal two and a half, NJ two. Statute reminders fire firm-wide at six months, three months, and one month — they sit in the overdue list on purpose and are never rescheduled.

# How Jeff works

He starts with his calendar, then today's tasks, then triages overdue. Ten to fifteen overdue items is normal, not a crisis. He refers to matters by client name, diaries every event to himself AND the office calendar, and tracks settlement negotiations in the matter notes: insurer, claim number, policy limits, adjuster contact, demand, offers. Settlement packages go out by email and by mail — mail leaves no electronic trace, so an unverified send is often just a mailed one.

# Where you stop

Billing, invoices, and trust accounting live in Smokeball's own screens — point there. Anything filed with a court, sent to a client or opposing counsel, or moving money is human work, always.

# Personal

Jeff is a University of Miami School of Law graduate and a devoted Hurricanes fan — a proud Cane. When he lands a real win — a settlement finalized, a strong offer, a case dismissed — an occasional "Go Canes" is welcome. Keep it rare and natural, like a colleague who knows him, and never in anything formal or court-facing.
`;

/**
 * One-shot upgrade: appends the "# Personal" section to an already-seeded
 * knowledge file that predates it. Runs once (flagged), appends only if the
 * section is absent, and never touches anything Jeff wrote — so his edits
 * survive, and if he later deletes the section it stays deleted.
 */
export async function ensureKnowledgeAdditions(db: Db): Promise<void> {
  const FLAG = 'migration.knowledge-personal-v1';
  const done = await db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, FLAG))
    .limit(1);
  if (done.length > 0) return;
  const current = await getKnowledge(db);
  if (!/University of Miami/i.test(current)) {
    const section = DEFAULT_KNOWLEDGE.slice(DEFAULT_KNOWLEDGE.indexOf('# Personal'));
    await putSetting(db, 'knowledge.md', `${current.trimEnd()}\n\n${section.trim()}\n`);
  }
  await db.insert(schema.appSettings).values({ key: FLAG, value: 'done' }).onConflictDoNothing();
}

interface CacheEntry {
  value: string;
  stamp: string;
}
const cache = new Map<string, CacheEntry>();

async function getSetting(db: Db, key: string, fallback: string): Promise<string> {
  const row = await db
    .select({ value: schema.appSettings.value, updatedAt: schema.appSettings.updatedAt })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .limit(1);
  if (row.length === 0) {
    await db.insert(schema.appSettings).values({ key, value: fallback }).onConflictDoNothing();
    return fallback;
  }
  const stamp = row[0]!.updatedAt.toISOString();
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  cache.set(key, { value: row[0]!.value, stamp });
  return row[0]!.value;
}

export const getIdentity = (db: Db) => getSetting(db, 'identity.md', DEFAULT_IDENTITY);
export const getKnowledge = (db: Db) => getSetting(db, 'knowledge.md', DEFAULT_KNOWLEDGE);

export async function putSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(schema.appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: new Date() } });
  cache.delete(key);
}
