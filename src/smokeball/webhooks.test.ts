import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildGoldenDataset } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from './mock/server.js';
import { SmokeballClient } from './client.js';
import { ensureWebhookSubscription, PAM_EVENT_TYPES } from './webhooks.js';
import { openDb, schema, type Db } from '../server/db/index.js';
import { SyncWorker } from '../server/sync/worker.js';

describe('webhook subscription + delivery handling', () => {
  let mock: MockSmokeball;
  let client: SmokeballClient;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    mock = createMockSmokeball(buildGoldenDataset());
    const baseUrl = await mock.listen();
    client = new SmokeballClient({ baseUrl, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 50 });
    ({ db, close } = await openDb());
  });
  afterAll(async () => {
    await close();
    await mock.close();
  });

  it('ensureWebhookSubscription creates once and reuses after', async () => {
    const a = await ensureWebhookSubscription(client, 'https://pam.example/webhooks/smokeball', 'k1');
    expect(a.created).toBe(true);
    const b = await ensureWebhookSubscription(client, 'https://pam.example/webhooks/smokeball', 'k1');
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const subs = (await client.listWebhooks()).value;
    expect(subs.filter((s) => String(s['callbackUrl'] ?? s['eventNotificationUrl']) === 'https://pam.example/webhooks/smokeball')).toHaveLength(1);
    expect(PAM_EVENT_TYPES).toContain('error');
    expect(await client.listWebhookTypes()).toContain('task.created');
  });

  it('handleWebhook: deletions apply by id, everything else triggers a prompt sync', async () => {
    const worker = new SyncWorker(db, client);
    await worker.fullSync();
    const before = await db.select().from(schema.tasks);
    expect(before.length).toBeGreaterThan(0);

    // A new task appears in the API; a webhook (any payload shape) triggers the sync.
    await client.createTask({ subject: 'Webhook-triggered task', assigneeIds: ['s-jeff'], dueDate: '2026-08-01' }, 's-jeff');
    await new Promise((r) => setTimeout(r, 80)); // let the mock apply the async write
    await worker.handleWebhook('task.created', { someUnknownShape: true });
    await new Promise((r) => setTimeout(r, 900));
    const after = await db.select().from(schema.tasks);
    expect(after.some((t) => t.subject === 'Webhook-triggered task')).toBe(true);

    // Deletion by id.
    const victim = before[0]!;
    await worker.handleWebhook('task.deleted', { id: victim.id });
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.id, victim.id))).toHaveLength(0);
    expect(worker.lastWebhook?.type).toBe('task.deleted');
  });
});
