import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import { MEMORY_TYPES, saveMemory, type MemoryType } from '../tools/memory-tools.js';
import type { LlmClient } from './loop.js';

/**
 * The quiet extractor: when a conversation closes, a background pass reads
 * the transcript and proposes durable working memories — preferences,
 * corrections, process, pointers. Every proposal still goes through the
 * privilege guard, so the extractor cannot leak a client fact into memory
 * even if the model tries.
 */

const EXTRACT_SYSTEM = `You extract durable working memories from a conversation between a trial lawyer (the user) and his assistant, PAM.

Output ONLY a JSON array, no prose. Each item: {"type": "preference"|"process"|"correction"|"pointer", "hook": "one-line summary", "body": "the memory in plain words"}.

Keep ONLY things that will still be true next month and are about HOW the user likes things done, how the firm works, a correction of something PAM got wrong, or where something lives. Examples: "prefers dates spoken as weekday plus day", "wants the settlement board ranked by offer size", "says 'diary it' to mean create a calendar entry".

NEVER include client names, matter numbers, dollar figures, offers, demands, injuries, diagnoses, deadlines, or any fact about a specific case — those live in the firm's system, not in memory. Output [] if nothing durable was taught.`;

export interface ExtractResult {
  sessionId: string;
  proposed: number;
  saved: number;
  refused: number;
}

export async function extractMemoriesFromSession(
  db: Db,
  llm: LlmClient,
  sessionId: string,
): Promise<ExtractResult> {
  const msgs = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(schema.chatMessages.id);
  const result: ExtractResult = { sessionId, proposed: 0, saved: 0, refused: 0 };
  const mark = () => db.update(schema.chatSessions).set({ extractedAt: new Date() }).where(eq(schema.chatSessions.id, sessionId));
  if (msgs.length < 4) {
    await mark();
    return result;
  }
  const transcript = msgs.map((m) => `${m.role === 'user' ? 'USER' : 'PAM'}: ${m.displayText}`).join('\n');
  let text = '';
  try {
    const res = await llm.create(
      {
        system: [{ text: EXTRACT_SYSTEM }],
        messages: [{ role: 'user', content: `Transcript:\n${transcript.slice(0, 20_000)}\n\nJSON array:` }],
        tools: [],
      },
      {},
    );
    text = res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (e) {
    console.error('[pam] memory extractor failed:', e instanceof Error ? e.message : e);
    return result; // leave unmarked so a later pass can retry
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  let items: { type?: string; hook?: string; body?: string }[] = [];
  if (start >= 0 && end > start) {
    try {
      items = JSON.parse(text.slice(start, end + 1)) as typeof items;
    } catch {
      items = [];
    }
  }
  for (const it of items.slice(0, 8)) {
    if (!it.hook || !it.body || !MEMORY_TYPES.includes(it.type as MemoryType)) continue;
    result.proposed++;
    const r = await saveMemory(db, { type: it.type as MemoryType, hook: it.hook.slice(0, 120), body: it.body.slice(0, 600), taughtBy: 'extractor' });
    if ('refused' in r) result.refused++;
    else result.saved++;
  }
  await mark();
  return result;
}

/** Sessions for a user that are closed and not yet extracted. */
export async function pendingExtractions(db: Db, staffId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.chatSessions.id })
    .from(schema.chatSessions)
    .where(and(eq(schema.chatSessions.staffId, staffId), eq(schema.chatSessions.closed, true), isNull(schema.chatSessions.extractedAt)));
  return rows.map((r) => r.id);
}
