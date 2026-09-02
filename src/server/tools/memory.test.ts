import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { memoryLines, privilegeGuard, saveMemory } from './memory-tools.js';
import { runTool } from './registry.js';
import type { ToolContext } from './types.js';

const NOW = '2026-08-01T12:00:00Z';

async function ctxWithMatter() {
  const { db, close } = await openDb();
  await db.insert(schema.matters).values({
    id: 'm-grasso', number: '24-1200', status: 'Open', matterTypeId: 'mt', clientFirstName: 'Peter', clientLastName: 'Grasso',
    description: 'MVA', createdAt: NOW, updatedAt: NOW,
  });
  const ctx: ToolContext = { db, currentStaffId: 's-jeff', confirmations: new Map() };
  return { db, close, ctx };
}

describe('privilege guard (the hard rule, enforced in code)', () => {
  it('refuses client names, matter numbers, dollar figures, and case facts', async () => {
    const { db, close } = await ctxWithMatter();
    expect((await privilegeGuard(db, 'Call Grasso on Fridays')).ok).toBe(false);
    expect((await privilegeGuard(db, 'the peter file is messy')).ok).toBe(false);
    expect((await privilegeGuard(db, 'remember 24-1200 needs work')).ok).toBe(false);
    expect((await privilegeGuard(db, 'they offered $110,000')).ok).toBe(false);
    expect((await privilegeGuard(db, 'demand of two fifty; plaintiff injured')).ok).toBe(false);
    expect((await privilegeGuard(db, 'Prefers dates spoken as weekday plus day')).ok).toBe(true);
    expect((await privilegeGuard(db, 'Says "diary it" to mean create a calendar entry')).ok).toBe(true);
    await close();
  });
});

describe('memory tools', () => {
  it('remember → recall → forget round-trip, with refusals audited', async () => {
    const { db, close, ctx } = await ctxWithMatter();
    const saved = await runTool(ctx, 'remember', { type: 'preference', hook: 'Weekday-first dates', body: 'Say the weekday before the date.' });
    expect((saved.data as { saved: boolean }).saved).toBe(true);

    const refused = await runTool(ctx, 'remember', { type: 'process', hook: 'Grasso handling', body: 'Grasso wants calls after 3.' });
    expect((refused.data as { refused: boolean }).refused).toBe(true);
    expect((refused.data as { reason: string }).reason).toMatch(/names a client/);
    const audit = await db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === 'memory:save:REFUSED_PRIVILEGE')).toBe(true);

    const lines = await memoryLines(db);
    expect(lines).toEqual(['[preference] Weekday-first dates — Say the weekday before the date.']);

    const recall = await runTool(ctx, 'recall_memories', { query: 'weekday' });
    const list = (recall.data as { memories: { id: string }[] }).memories;
    expect(list).toHaveLength(1);

    const forgot = await runTool(ctx, 'forget_memory', { memoryId: list[0]!.id });
    expect((forgot.data as { forgotten: boolean }).forgotten).toBe(true);
    expect(await memoryLines(db)).toEqual([]);
    await close();
  });

  it('saveMemory returns an explanation the model can speak', async () => {
    const { db, close } = await ctxWithMatter();
    const r = await saveMemory(db, { type: 'pointer', hook: 'Lien letters', body: 'Lien letters live in the Liens folder; the total was $97,000', taughtBy: 'x' });
    expect('refused' in r && r.refused).toMatch(/dollar figure/);
    await close();
  });
});
