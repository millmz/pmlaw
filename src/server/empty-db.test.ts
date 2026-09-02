import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db/index.js';
import { buildApp } from './app.js';
import { SyncWorker } from './sync/worker.js';
import { resolveCurrentStaffId } from './staff.js';
import type { SmokeballClient } from '../smokeball/client.js';
import type { ToolContext } from './tools/types.js';

/**
 * Regression for the blank-site incident: a fresh real-tenant cutover leaves
 * the mirror empty and the golden staff id unmatched. Every page-backing API
 * must answer 200 with empty lists — never 500 (which blanked the SPA).
 */

describe('page APIs degrade gracefully on an empty mirror', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    ({ db, close } = await openDb());
    const ctx: ToolContext = {
      db,
      currentStaffId: 's-jeff', // golden id; matches nothing in an empty mirror
      smokeball: undefined as unknown as SmokeballClient,
      confirmations: new Map(),
    };
    app = buildApp({ ctx, worker: new SyncWorker(db, undefined as unknown as SmokeballClient) });
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  it('/api/today answers 200 with empty lists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/today' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { todayEvents: unknown[]; dueToday: unknown[]; overdue: { needsDecision: unknown[] } };
    expect(body.todayEvents).toEqual([]);
    expect(body.dueToday).toEqual([]);
    expect(body.overdue.needsDecision).toEqual([]);
  });

  it('/api/day answers 200 with empty lists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/day?date=2026-09-01' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[]; tasksDue: unknown[] };
    expect(body.events).toEqual([]);
    expect(body.tasksDue).toEqual([]);
  });

  it('/api/tasks answers 200 with empty buckets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dueToday: unknown[]; needsDecision: unknown[]; statuteReminders: { tasks: unknown[] } };
    expect(body.dueToday).toEqual([]);
    expect(body.needsDecision).toEqual([]);
    expect(body.statuteReminders.tasks).toEqual([]);
  });
});

describe('resolveCurrentStaffId', () => {
  it('keeps the id when present, matches by name when not, first-row fallback', async () => {
    const { db, close } = await openDb();
    const { schema } = await import('./db/index.js');
    // Empty mirror: keep whatever we had.
    expect(await resolveCurrentStaffId(db, 's-jeff')).toBe('s-jeff');
    await db.insert(schema.staff).values([
      { id: 'u-frank', firstName: 'Frank', lastName: 'Phillips', initials: 'FJP', email: 'f@x.c', role: 'attorney', updatedAt: 'now' },
      { id: 'u-jeff', firstName: 'Jeffrey', lastName: 'Millman', initials: 'JM', email: 'j@x.c', role: 'attorney', updatedAt: 'now' },
    ]);
    // Golden id absent → name match wins over first row.
    expect(await resolveCurrentStaffId(db, 's-jeff')).toBe('u-jeff');
    // A real id that exists is kept.
    expect(await resolveCurrentStaffId(db, 'u-frank')).toBe('u-frank');
    await close();
  });
});
