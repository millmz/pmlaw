import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { extractMemoriesFromSession, pendingExtractions } from './extractor.js';
import type { LlmClient } from './loop.js';

const NOW = '2026-08-01T12:00:00Z';

const fakeLlm = (reply: string): LlmClient => ({
  create: async () => ({ content: [{ type: 'text', text: reply }], stopReason: 'end_turn' }),
});

async function seedSession(db: Awaited<ReturnType<typeof openDb>>['db'], id: string, texts: string[]) {
  await db.insert(schema.chatSessions).values({ id, staffId: 's-jeff', closed: true });
  for (const [i, t] of texts.entries()) {
    await db.insert(schema.chatMessages).values({ sessionId: id, role: i % 2 === 0 ? 'user' : 'assistant', displayText: t, llmJson: null, citations: [] });
  }
}

describe('quiet memory extractor', () => {
  it('saves durable preferences, refuses privileged items, marks the session', async () => {
    const { db, close } = await openDb();
    await db.insert(schema.matters).values({
      id: 'm1', number: '24-1200', status: 'Open', matterTypeId: 'mt', clientFirstName: 'Peter', clientLastName: 'Grasso', description: 'x', createdAt: NOW, updatedAt: NOW,
    });
    await seedSession(db, 'sess-1', ['say dates weekday first', 'Noted.', 'and diary it means calendar', 'Got it.']);
    expect(await pendingExtractions(db, 's-jeff')).toEqual(['sess-1']);

    const llm = fakeLlm(`Here you go:
[{"type":"preference","hook":"Weekday-first dates","body":"Say the weekday before the date."},
 {"type":"process","hook":"Grasso offer","body":"Grasso will take $150,000"},
 {"type":"pointer","hook":"diary it","body":"'Diary it' means create a calendar entry."},
 {"type":"nonsense","hook":"x","body":"y"}]`);
    const r = await extractMemoriesFromSession(db, llm, 'sess-1');
    expect(r).toEqual({ sessionId: 'sess-1', proposed: 3, saved: 2, refused: 1 });
    const mem = await db.select().from(schema.memories);
    expect(mem.map((m) => m.hook).sort()).toEqual(['Weekday-first dates', 'diary it']);
    expect(mem.every((m) => m.taughtBy === 'extractor')).toBe(true);
    expect(await pendingExtractions(db, 's-jeff')).toEqual([]);
    await close();
  });

  it('short sessions are marked without calling the model; model failure leaves it pending', async () => {
    const { db, close } = await openDb();
    await seedSession(db, 'short', ['hi', 'hello']);
    let called = 0;
    const llm: LlmClient = { create: async () => { called++; throw new Error('boom'); } };
    await extractMemoriesFromSession(db, llm, 'short');
    expect(called).toBe(0);
    await seedSession(db, 'long', ['a', 'b', 'c', 'd']);
    await extractMemoriesFromSession(db, llm, 'long');
    expect(called).toBe(1);
    expect(await pendingExtractions(db, 's-jeff')).toEqual(['long']); // retryable
    await close();
  });
});
