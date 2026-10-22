import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, schema, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { runTool } from './registry.js';
import type { ToolContext } from './types.js';

/** Shadow mode (PAM_WRITES=off): cards still show what WOULD happen; every
 *  execute refuses, audits the refusal, and Smokeball is never touched. */
describe('writes off (shadow trial)', () => {
  let mock: MockSmokeball;
  let db: Db;
  let close: () => Promise<void>;
  let ctx: ToolContext;
  let client: SmokeballClient;

  beforeAll(async () => {
    mock = createMockSmokeball(buildGoldenDataset());
    const baseUrl = await mock.listen();
    client = new SmokeballClient({ baseUrl, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 50 });
    ({ db, close } = await openDb());
    await new SyncWorker(db, client).fullSync();
    ctx = { db, currentStaffId: 's-jeff', smokeball: client, confirmations: new Map(), fixedNowIso: GOLDEN_ANCHOR_ISO, writesEnabled: false };
  });
  afterAll(async () => {
    await close();
    await mock.close();
  });

  it('propose still returns a card (flagged TRIAL), execute refuses and nothing is written', async () => {
    const before = (await client.listTasks()).length;
    const prop = await runTool(ctx, 'propose_task_create', { subject: 'Shadow test task', dueDate: '2026-07-30' });
    const d = prop.data as { confirmationToken: string; card: { note: string } };
    expect(d.card.note).toMatch(/TRIAL PERIOD/);
    const exec = await runTool(ctx, 'execute_task_create', { confirmationToken: d.confirmationToken });
    const r = exec.data as { refused: boolean; writesOff: boolean; reason: string };
    expect(r.refused).toBe(true);
    expect(r.writesOff).toBe(true);
    expect(r.reason).toMatch(/switched off during the trial/);
    expect((await client.listTasks()).length).toBe(before);
    const audit = await db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === 'write:task_create:REFUSED_WRITES_OFF')).toBe(true);
  });

  it('reschedule and event creation refuse the same way', async () => {
    const p1 = await runTool(ctx, 'propose_task_reschedule', { taskQuery: 'Boland', newDueDate: '2026-08-07' });
    const t1 = (p1.data as { confirmationToken: string }).confirmationToken;
    expect(((await runTool(ctx, 'execute_task_reschedule', { confirmationToken: t1 })).data as { writesOff: boolean }).writesOff).toBe(true);
    const p2 = await runTool(ctx, 'propose_event_create', { subject: 'Shadow call', start: '2026-07-29T10:00' });
    const t2 = (p2.data as { confirmationToken: string }).confirmationToken;
    expect(((await runTool(ctx, 'execute_event_create', { confirmationToken: t2 })).data as { writesOff: boolean }).writesOff).toBe(true);
  });

  it('with writes on (default), the same flow executes', async () => {
    const on: ToolContext = { ...ctx, writesEnabled: true, confirmations: new Map() };
    const prop = await runTool(on, 'propose_task_create', { subject: 'Live test task', dueDate: '2026-07-30' });
    const exec = await runTool(on, 'execute_task_create', { confirmationToken: (prop.data as { confirmationToken: string }).confirmationToken });
    expect((exec.data as { done: boolean }).done).toBe(true);
  });
});
