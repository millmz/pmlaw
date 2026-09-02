import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, schema, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { runTool } from './registry.js';
import type { ToolContext } from './types.js';

/** Create-by-conversation: propose → confirm token → execute → verified in the (mock) API. */

describe('create task / event tools', () => {
  let mock: MockSmokeball;
  let db: Db;
  let close: () => Promise<void>;
  let ctx: ToolContext;

  beforeAll(async () => {
    mock = createMockSmokeball(buildGoldenDataset());
    const baseUrl = await mock.listen();
    const client = new SmokeballClient({ baseUrl, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 50 });
    ({ db, close } = await openDb());
    await new SyncWorker(db, client).fullSync();
    ctx = { db, currentStaffId: 's-jeff', smokeball: client, confirmations: new Map(), fixedNowIso: GOLDEN_ANCHOR_ISO };
  });
  afterAll(async () => {
    await close();
    await mock.close();
  });

  it('task: proposes with a matter, executes on confirmation, verifies, caches, audits', async () => {
    const prop = await runTool(ctx, 'propose_task_create', { subject: 'Call adjuster re Grasso offer', dueDate: '2026-07-29', matterQuery: 'Grasso' });
    const d = prop.data as { confirmationRequired: boolean; confirmationToken: string; card: { matter: string } };
    expect(d.confirmationRequired).toBe(true);
    expect(d.card.matter).toMatch(/Grasso/);

    const exec = await runTool(ctx, 'execute_task_create', { confirmationToken: d.confirmationToken });
    const r = exec.data as { done: boolean; taskId: string; summary: string };
    expect(r.done).toBe(true);
    expect(r.summary).toMatch(/verified/);
    const cached = await db.select().from(schema.tasks).where((await import('drizzle-orm')).eq(schema.tasks.id, r.taskId));
    expect(cached[0]?.dueDate).toBe('2026-07-29');
    expect(cached[0]?.assigneeIds).toEqual(['s-jeff']);

    // Single-use token.
    const again = await runTool(ctx, 'execute_task_create', { confirmationToken: d.confirmationToken });
    expect((again.data as { error: string }).error).toMatch(/expired|already used/);
    const audit = await db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === 'write:task_create' && a.result === 'executed and verified')).toBe(true);
  });

  it('task: ambiguous client name returns candidates instead of guessing', async () => {
    const prop = await runTool(ctx, 'propose_task_create', { subject: 'Follow up', matterQuery: 'Juan' });
    const d = prop.data as { ambiguous: boolean; candidates: unknown[] };
    expect(d.ambiguous).toBe(true);
    expect(d.candidates.length).toBeGreaterThan(1);
  });

  it('event: flags a conflict, then creates and verifies on confirmation', async () => {
    // Tran deposition runs 11:30–1:00 on the anchor day.
    const prop = await runTool(ctx, 'propose_event_create', { subject: 'Call with Frank re Tran posture', start: '2026-07-27T11:45', durationMinutes: 30, matterQuery: 'Tran' });
    const d = prop.data as { confirmationToken: string; card: { conflicts?: string[]; when: string } };
    expect(d.card.conflicts?.some((c) => /Deposition/.test(c))).toBe(true);
    expect(d.card.when).toMatch(/Monday, July 27 11:45 AM/);

    const exec = await runTool(ctx, 'execute_event_create', { confirmationToken: d.confirmationToken });
    const r = exec.data as { done: boolean; eventId: string };
    expect(r.done).toBe(true);
    const cached = await db.select().from(schema.events).where((await import('drizzle-orm')).eq(schema.events.id, r.eventId));
    expect(cached[0]?.subject).toBe('Call with Frank re Tran posture');
    expect(cached[0]?.attendeeIds).toEqual(['s-jeff']);
  });

  it('tokens are bound to their action: a task token cannot execute an event', async () => {
    const prop = await runTool(ctx, 'propose_task_create', { subject: 'Diary something' });
    const token = (prop.data as { confirmationToken: string }).confirmationToken;
    const wrong = await runTool(ctx, 'execute_event_create', { confirmationToken: token });
    expect((wrong.data as { error: string }).error).toMatch(/expired|already used/);
  });

  it('rejects bad dates and past-end events plainly', async () => {
    const bad = await runTool(ctx, 'propose_task_create', { subject: 'Diary it', dueDate: 'next tuesday' });
    expect((bad.data as { error: string }).error).toMatch(/not a valid date/);
    const back = await runTool(ctx, 'propose_event_create', { subject: 'Backwards', start: '2026-07-28T10:00', end: '2026-07-28T09:00' });
    expect((back.data as { error: string }).error).toMatch(/end must be after/);
  });
});
