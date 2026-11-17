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
    const real = client.listMatters.bind(client);
    let inFlight = 0;
    let maxInFlight = 0;
    client.listMatters = async (p = {}) => {
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
