import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildGoldenDataset } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, schema, type Db } from '../db/index.js';
import { SyncWorker } from './worker.js';

let mock: MockSmokeball;
let base: string;
let db: Db;
let closeDb: () => Promise<void>;

const newClient = () => new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 500 });

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  base = await mock.listen();
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
});

afterAll(async () => {
  await mock.close();
  await closeDb();
});

describe('sync hardening (production scale)', () => {
  it('a resource the app cannot read never aborts the sync — it is skipped and reported', async () => {
    const client = newClient();
    let fileCalls = 0;
    client.listFiles = async () => {
      fileCalls++;
      throw new Error('403 Forbidden: not authorized (documents/read)');
    };
    const worker = new SyncWorker(db, client);
    const counts = await worker.fullSync();
    expect(counts['matters']).toBe(14);
    expect(counts['memos']).toBe(5); // notes still mirrored
    expect(fileCalls).toBe(3); // three strikes, then skipped for the run
    expect(worker.lastSync?.ok).toBe(true);
    expect(worker.lastSync?.warnings?.[0]).toMatch(/files: 3 matter\(s\).*missing scope/);
    expect(worker.lastOkAt).toBeTruthy();
  });

  it('one bad matter does not take the others down', async () => {
    const client = newClient();
    const real = client.listMemos.bind(client);
    const open = mock.data.matters.filter((m) => m.status === 'Open');
    const bad = open[1]!.id;
    client.listMemos = async (id: string) => {
      if (id === bad) throw new Error('500 upstream');
      return real(id);
    };
    const worker = new SyncWorker(db, client);
    await worker.fullSync();
    expect(worker.lastSync?.ok).toBe(true);
    expect(worker.lastSync?.warnings?.[0]).toMatch(/memos: 1 matter/);
  });

  it('a rejected list filter falls back to the unfiltered call', async () => {
    const client = newClient();
    const real = client.listTasks.bind(client);
    const seen: unknown[] = [];
    client.listTasks = async (p = {}) => {
      seen.push(p);
      if (p.isCompleted !== undefined) throw new Error('400 IsCompleted is not a valid filter');
      return real(p);
    };
    const worker = new SyncWorker(db, client);
    const counts = await worker.fullSync();
    expect(seen).toEqual([{ isCompleted: false }, {}]);
    expect(counts['tasks']).toBeGreaterThanOrEqual(11);
  });

  it('never runs two syncs at once: an incremental during a full is skipped; a second full waits', async () => {
    const client = newClient();
    const real = client.listMattersAdapted.bind(client);
    let inFlight = 0;
    let maxInFlight = 0;
    client.listMattersAdapted = async (p = {}) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await real(p);
      } finally {
        inFlight--;
      }
    };
    const worker = new SyncWorker(db, client);
    const full = worker.fullSync();
    await new Promise((r) => setTimeout(r, 5));
    expect(worker.busy).toBe(true);
    expect(worker.progress?.kind).toBe('full');
    expect(await worker.incrementalSync()).toEqual({ skipped: 1 });
    const second = worker.fullSync();
    await Promise.all([full, second]);
    expect(maxInFlight).toBe(1);
    expect(worker.busy).toBe(false);
    expect(worker.progress).toBeNull();
  });

  it('the matter-type catalog is read once, not on every full sync', async () => {
    const client = newClient();
    const real = client.listMatterTypes.bind(client);
    let calls = 0;
    client.listMatterTypes = async () => {
      calls++;
      return real();
    };
    const worker = new SyncWorker(db, client);
    await db.delete(schema.syncState).where(eq(schema.syncState.recordType, 'mattertypes'));
    await worker.fullSync();
    await worker.fullSync();
    expect(calls).toBe(1);
  });

  it('a note-webhook naming a matter refreshes that matter\'s notes on the next pass', async () => {
    const client = newClient();
    const worker = new SyncWorker(db, client);
    await worker.fullSync();
    const seen: string[] = [];
    const real = client.listMemos.bind(client);
    client.listMemos = async (id: string) => {
      seen.push(id);
      return real(id);
    };
    const closed = mock.data.matters.find((m) => m.status !== 'Open')!;
    await worker.handleWebhook('memo.created', { id: 'memo-x', matterId: closed.id });
    await worker.incrementalSync();
    expect(seen).toContain(closed.id); // webhook-targeted, even though not "open"
    // …and the rolling refresh touched a few open matters too.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThanOrEqual(5);
  });
});

describe('first sync at firm scale: the docket never waits on client names', () => {
  it('matters land under their title first; names fill in after tasks and calendar; resolved names survive a re-sync', async () => {
    const opened = await openDb();
    const client = newClient();
    const order: string[] = [];
    const raw = [
      { id: 'mx-1', number: '25-0001', status: 'Open', title: 'Abbott v. Acme', clientContactIds: ['c-1'], clientFirstName: '', clientLastName: 'Abbott v. Acme', matterTypeId: '', description: '', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
      { id: 'mx-2', number: '25-0002', status: 'Closed', title: 'Old matter', clientContactIds: ['c-2'], clientFirstName: '', clientLastName: 'Old matter', matterTypeId: '', description: '', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    ];
    client.listMattersAdapted = async () => {
      order.push('matters');
      return structuredClone(raw) as never;
    };
    const tasks = client.listTasks.bind(client);
    client.listTasks = async (p = {}) => {
      order.push('tasks');
      return tasks(p);
    };
    let lookups = 0;
    client.clientNameFor = async (id: string) => {
      order.push(`name:${id}`);
      lookups++;
      return id === 'c-1' ? { firstName: 'Alan', lastName: 'Abbott' } : null;
    };
    const worker = new SyncWorker(opened.db, client);
    const counts = await worker.fullSync();
    expect(order.indexOf('matters')).toBeLessThan(order.indexOf('tasks'));
    expect(order.indexOf('tasks')).toBeLessThan(order.indexOf('name:c-1'));
    expect(order.indexOf('name:c-1')).toBeLessThan(order.indexOf('name:c-2')); // open matters first
    expect(counts['clientNames']).toBe(1);
    const row = async (id: string) => (await opened.db.select().from(schema.matters).where(eq(schema.matters.id, id)))[0]!;
    expect((await row('mx-1')).clientLastName).toBe('Abbott');
    expect((await row('mx-2')).clientLastName).toBe('Old matter'); // unreadable contact → title stands in
    // A later full sync keeps the resolved name and does not ask again for it.
    lookups = 0;
    await worker.fullSync();
    expect((await row('mx-1')).clientFirstName).toBe('Alan');
    expect(lookups).toBe(1); // only the still-unnamed one
    await opened.close();
  });
});

describe('custom fields (statute date, date of loss, in suit) come from layouts', () => {
  it('a mirror built before layouts were read catches up on the next passes, and a list sync never blanks what was found', async () => {
    const opened = await openDb();
    const worker = new SyncWorker(opened.db, newClient());
    await worker.fullSync();
    const grasso = async () => (await opened.db.select().from(schema.matters).where(eq(schema.matters.id, 'm-grasso')))[0]!;
    const statute = (await grasso()).statuteDate;
    expect(statute).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The live mirror as it was: no custom fields, no catch-up recorded.
    await opened.db.update(schema.matters).set({ statuteDate: null, dateOfLoss: null, isInSuit: null });
    await opened.db.delete(schema.syncState).where(eq(schema.syncState.recordType, 'layouts'));
    expect(worker.factsBackfill).toBeNull();
    await worker.incrementalSync();
    expect((await grasso()).statuteDate).toBe(statute);
    expect((await grasso()).dateOfLoss).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 14 matters fit one pass, so the catch-up is recorded as finished.
    expect((await opened.db.select().from(schema.syncState).where(eq(schema.syncState.recordType, 'layouts'))).length).toBe(1);

    // The matter list carries no custom fields: re-reading it keeps them.
    await opened.db.delete(schema.syncState).where(eq(schema.syncState.recordType, 'matters'));
    await worker.incrementalSync();
    expect((await grasso()).statuteDate).toBe(statute);
    await opened.close();
  });

  it('a firm whose app cannot read layouts still syncs; the gap is reported, not fatal', async () => {
    const opened = await openDb();
    const client = newClient();
    let asked = 0;
    client.matterFacts = async () => {
      asked++;
      throw new Error('smokeball GET /matters/x/layouts -> 403: {"Message":"User is not authorized to access this resource with an explicit deny"}');
    };
    const worker = new SyncWorker(opened.db, client);
    const counts = await worker.fullSync();
    expect(counts['matters']).toBe(14);
    expect(String(worker.factsBackfill)).toMatch(/^blocked: Smokeball refuses/);
    expect(JSON.stringify(worker.lastSync)).toMatch(/layouts/);
    expect(asked).toBe(3); // three refusals and it stops asking
    // …and it stays off the endpoint on later passes instead of re-trying every minute.
    await worker.incrementalSync();
    await worker.incrementalSync();
    expect(asked).toBe(3);
    expect((await opened.db.select().from(schema.syncState).where(eq(schema.syncState.recordType, 'layouts'))).length).toBe(0); // not recorded as done
    await opened.close();
  });
});
