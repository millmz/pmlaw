import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb, type Db } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import { buildApp } from './app.js';
import type { LlmClient } from './agent/loop.js';
import type { FastifyInstance } from 'fastify';

/** Chat persistence through the real HTTP app with a scripted LLM. */

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

const scriptedLlm: LlmClient = {
  async create(params) {
    // Reply deterministically, proving history length grows across turns.
    const userTurns = params.messages.filter((m) => m.role === 'user').length;
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: `reply #${userTurns} — adjuster line (555) 201-4433` }],
    };
  },
};

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 200 });
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
  const worker = new SyncWorker(db, client);
  await worker.fullSync();
  app = buildApp({
    ctx: { db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO },
    worker,
    llm: scriptedLlm,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mock.close();
  await closeDb();
});

const chat = async (message: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message } });
  expect(res.statusCode).toBe(200);
  const frames = res.body
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; text?: string; sessionId?: string });
  return frames.find((f) => f.type === 'done')!;
};

describe('chat persistence', () => {
  it('persists turns into one resumable session', async () => {
    const first = await chat('What does my day look like?');
    expect(first.text).toContain('reply #1');
    const second = await chat('And tomorrow?');
    expect(second.text).toContain('reply #2'); // history carried: model saw 2 user turns
    expect(second.sessionId).toBe(first.sessionId);

    const history = await app.inject({ method: 'GET', url: '/api/chat/history' });
    const h = history.json() as { sessionId: string; messages: { role: string; text: string }[] };
    expect(h.sessionId).toBe(first.sessionId);
    expect(h.messages).toHaveLength(4); // 2 user + 2 assistant
    expect(h.messages[0]!.role).toBe('user');
    expect(h.messages[3]!.text).toContain('reply #2');
  });

  it('new conversation closes ALL open sessions server-side', async () => {
    await app.inject({ method: 'POST', url: '/api/chat/new' });
    const history = await app.inject({ method: 'GET', url: '/api/chat/history' });
    expect((history.json() as { sessionId: string | null }).sessionId).toBeNull();
    // Next message starts a fresh session with clean history.
    const next = await chat('Fresh start');
    expect(next.text).toContain('reply #1');
  });
});
