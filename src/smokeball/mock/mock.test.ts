import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildGoldenDataset } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from './server.js';
import { SmokeballClient } from '../client.js';

let mock: MockSmokeball;
let client: SmokeballClient;

// A tiny webhook receiver so we can assert deliveries.
let receiver: FastifyInstance;
let received: { type: string; payload: unknown; signature: string }[] = [];
let receiverUrl = '';

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  client = new SmokeballClient({
    baseUrl: base,
    apiKey: 'mock-api-key',
    accessToken: 'mock-token',
    rps: 100, // don't slow tests down
  });

  receiver = Fastify({ logger: false });
  receiver.post('/hook', async (req) => {
    const body = req.body as { type: string; payload: unknown };
    received.push({ ...body, signature: String(req.headers['signature'] ?? '') });
    return {};
  });
  receiverUrl = `${await receiver.listen({ port: 0, host: '127.0.0.1' })}/hook`;
});

afterAll(async () => {
  await mock.close();
  await receiver.close();
});

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('mock smokeball + client', () => {
  it('rejects missing auth', async () => {
    const addr = mock.app.server.address() as { port: number };
    const noKey = await fetch(`http://127.0.0.1:${addr.port}/staff`);
    expect(noKey.status).toBe(403);
    const noBearer = await fetch(`http://127.0.0.1:${addr.port}/staff`, {
      headers: { 'x-api-key': 'mock-api-key' },
    });
    expect(noBearer.status).toBe(401);
  });

  it('lists staff, matters, tasks, events through the client', async () => {
    const staff = await client.listStaff();
    expect(staff.map((s) => s.initials)).toContain('JTM');
    const matters = await client.listMatters();
    expect(matters.length).toBeGreaterThanOrEqual(14);
    const open = await client.listMatters({ status: 'Open' });
    expect(open.every((m) => m.status === 'Open')).toBe(true);
    const grassoTasks = await client.listTasks({ matterId: 'm-grasso' });
    expect(grassoTasks.length).toBeGreaterThanOrEqual(2);
  });

  it('UpdatedSince filters work after touching a record', async () => {
    const cut = new Date().toISOString();
    await mock.touch('matter', 'm-grasso', { description: 'Peter Grasso (updated)' });
    const changed = await client.listMatters({ updatedSince: cut });
    expect(changed.map((m) => m.id)).toEqual(['m-grasso']);
  });

  it('downloads file content via the presigned indirection', async () => {
    const files = await client.listFiles('m-fontana');
    const email = files.find((f) => f.from !== undefined);
    expect(email).toBeDefined();
    expect((email as { content?: string }).content).toBeUndefined(); // listing never leaks content
    const body = await client.downloadFile('m-fontana', email!.id);
    expect(body).toMatch(/dropbox\.com/);
  });

  it('full-text file search hits names and content', async () => {
    const byName = await client.searchFiles('settlement package');
    expect(byName.value.length).toBeGreaterThanOrEqual(4);
    const byContent = await client.searchFiles('97,000');
    expect(byContent.value.some((f) => f.name.includes('NYSIF'))).toBe(true);
  });

  it('async write: task creation returns 202 then lands + webhook fires with HMAC signature', async () => {
    received = [];
    await client.createWebhook(['task.created', 'task.updated', 'error'], receiverUrl);
    const before = (await client.listTasks()).length;
    const { requestId } = await client.createTask(
      {
        subject: 'JTM - test task from api',
        assigneeIds: ['s-jeff'],
        dueDate: '2026-08-01',
      },
      's-jeff',
    );
    expect(requestId).toBeTruthy();
    await waitFor(() => received.some((r) => r.type === 'task.created'));
    expect((await client.listTasks()).length).toBe(before + 1);
    const hook = received.find((r) => r.type === 'task.created')!;
    expect(hook.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('async write failure emits an error webhook, not an HTTP error', async () => {
    received = [];
    const { requestId } = await client.createTask({ subject: '' }, 's-jeff'); // invalid: no assignees
    expect(requestId).toBeTruthy(); // still 202 — this is the trap docs/02 warns about
    await waitFor(() => received.some((r) => r.type === 'error'));
  });

  it('enforces 5 rps when enabled', async () => {
    const limited = createMockSmokeball(buildGoldenDataset(), { rateLimit: true });
    const base = await limited.listen();
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${base}/staff`, {
          headers: { 'x-api-key': 'mock-api-key', authorization: 'Bearer mock-token' },
        }),
      ),
    );
    expect(burst.some((r) => r.status === 429)).toBe(true);
    // The client's limiter stays under budget: all succeed.
    const politeClient = new SmokeballClient({
      baseUrl: base,
      apiKey: 'mock-api-key',
      accessToken: 'mock-token',
      rps: 4,
    });
    const results = await Promise.all(Array.from({ length: 9 }, () => politeClient.listStaff()));
    expect(results.every((r) => r.length === 6)).toBe(true);
    await limited.close();
  }, 15_000);
});
