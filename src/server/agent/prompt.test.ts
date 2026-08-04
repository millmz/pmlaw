import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { DEFAULT_IDENTITY, getIdentity, putSetting } from '../identity.js';
import { buildDynamicBlock, buildStableBlock, capabilityList } from './system-prompt.js';
import { buildSnapshot } from './snapshot.js';
import { runAgentTurn, type LlmClient, type SystemBlockCapture } from './loop.js';
import type { ToolContext } from '../tools/types.js';

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let ctx: ToolContext;

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 200 });
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
  await new SyncWorker(db, client).fullSync();
  ctx = { db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO, smokeball: client, confirmations: new Map() };
});

afterAll(async () => {
  await mock.close();
  await closeDb();
});

describe('two-block prompt', () => {
  it('capability list is derived from the live registry, never hand-written', () => {
    const caps = capabilityList();
    for (const name of ['get_settlement_board', 'propose_task_reschedule', 'get_calendar_events']) {
      expect(caps).toContain(name);
    }
  });

  it('stable block = identity + rules + capabilities + knowledge; dynamic carries date/snapshot/checkpoint', () => {
    const stable = buildStableBlock('IDENTITY_SENTINEL', 'KNOWLEDGE_SENTINEL');
    expect(stable).toContain('IDENTITY_SENTINEL');
    expect(stable).toContain('non-negotiable');
    expect(stable).toContain('get_settlement_board');
    expect(stable).toContain('KNOWLEDGE_SENTINEL');
    expect(stable).not.toMatch(/Current date/);

    const dyn = buildDynamicBlock({
      now: DateTime.fromISO(GOLDEN_ANCHOR_ISO, { zone: 'America/New_York' }),
      snapshot: '{"x":1}',
      longConversation: true,
    });
    expect(dyn).toContain('Current date and time: Monday, July 27, 2026');
    expect(dyn).toContain('{"x":1}');
    expect(dyn).toContain('Checkpoint');
  });

  it('the agent sends exactly two blocks with cache on the first only — and edits land next turn', async () => {
    await putSetting(db, 'identity.md', 'You are PAM. EDITED_SENTINEL voice.');
    const captured: SystemBlockCapture[] = [];
    const llm: LlmClient = {
      async create(params) {
        captured.push(params.system.map((b) => ({ cache: Boolean(b.cache), length: b.text.length, text: b.text })));
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    };
    await runAgentTurn(ctx, llm, [], 'hello');
    expect(captured[0]).toHaveLength(2);
    expect(captured[0]![0]!.cache).toBe(true);
    expect(captured[0]![1]!.cache).toBe(false);
    expect(captured[0]![0]!.text).toContain('EDITED_SENTINEL'); // edit took effect immediately
    expect(captured[0]![1]!.text).toContain('"openMatters"'); // snapshot rides block 2
    expect(captured[0]![1]!.text).not.toContain('cache'); // sanity
    await putSetting(db, 'identity.md', DEFAULT_IDENTITY); // restore
  });

  it('identity seeds defaults on first run', async () => {
    const identity = await getIdentity(db);
    expect(identity).toContain('You are PAM');
  });
});

describe('the live snapshot', () => {
  it('summarizes the whole practice with computed alerts', async () => {
    const snap = JSON.parse(await buildSnapshot(ctx)) as {
      openMatters: number;
      practiceMix: Record<string, number>;
      statutesNearest: { matter: string; daysOut: number }[];
      today: { events: unknown[]; tasksDueToday: number; overdueNeedingDecision: number };
      settlementNegotiations: { matter: string; offer?: string }[];
      alerts: string[];
    };
    expect(snap.openMatters).toBe(13);
    expect(snap.practiceMix['Personal Injury']).toBeGreaterThanOrEqual(9);
    expect(snap.statutesNearest[0]!.matter).toContain('Petrov'); // nearest statute first
    expect(snap.today.events.length).toBe(6);
    expect(snap.today.tasksDueToday).toBe(11);
    expect(snap.today.overdueNeedingDecision).toBe(2);
    expect(snap.settlementNegotiations.some((s) => s.matter.includes('Hughes') && s.offer === '$85,000')).toBe(true);
    expect(snap.alerts.some((a) => a.includes('days late'))).toBe(true);
    expect(snap.alerts.some((a) => a.includes('No next step'))).toBe(true);
  });

  it('stays compact enough to ride every turn', async () => {
    expect((await buildSnapshot(ctx)).length).toBeLessThan(4000);
  });
});
