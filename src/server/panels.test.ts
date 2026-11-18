import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import { runTool } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import { panelFor } from './panels.js';

let mock: MockSmokeball;
let close: () => Promise<void>;
let ctx: ToolContext;
const panel = async (tool: string, params: Record<string, unknown>) => panelFor(tool, params, (await runTool(ctx, tool, params)).data);

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const client = new SmokeballClient({ baseUrl: await mock.listen(), apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 500 });
  const opened = await openDb();
  close = opened.close;
  await new SyncWorker(opened.db, client).fullSync();
  ctx = { db: opened.db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO, smokeball: client, confirmations: new Map(), writesEnabled: false };
});
afterAll(async () => {
  await mock.close();
  await close();
});

describe('orb room panels are built from the same tool results the model reads', () => {
  it('today’s schedule: times, court first, matter linked', async () => {
    const p = (await panel('get_calendar_events', { scope: 'today' }))!;
    expect(p.kind).toBe('schedule');
    expect(p.title).toBe('Today');
    expect(p.caption).toMatch(/^6 events/);
    expect(p.items![0]).toMatchObject({ lead: '9:00 AM', matterId: 'm-vasquez' });
    expect(p.items![0]!.sub).toContain('Clarkstown');
  });
  it('tasks: counts in the caption, late items flagged, statute reminders noted not listed as chores', async () => {
    const p = (await panel('get_tasks', { status: 'all_open' }))!;
    expect(p.caption).toMatch(/11 due today/);
    expect(p.items!.length).toBe(7);
    expect(p.more).toBeGreaterThan(0);
    const od = (await panel('get_tasks', { status: 'overdue' }))!;
    expect(od.items!.every((i) => i.tone === 'alert')).toBe(true);
    expect(od.note).toMatch(/statute reminder/);
    expect(od.items!.some((i) => /statute of limitations/i.test(i.title))).toBe(false);
  });
  it('one matter: the facts a lawyer glances for', async () => {
    const p = (await panel('get_matter_overview', { matterId: 'm-grasso' }))!;
    expect(p.title).toBe('Peter Grasso');
    expect(p.facts!.map((f) => f.k)).toEqual(expect.arrayContaining(['Matter', 'Type', 'Statute']));
  });
  it('settlement: figures, adjuster with a dialable number, last steps', async () => {
    const p = (await panel('get_settlement_timeline', { matterId: 'm-grasso' }))!;
    expect(p.facts!.find((f) => f.k === 'Offer')!.v).toContain('$110,000');
    expect(p.facts!.find((f) => f.k === 'Adjuster')!.tel).toBe('5552014433');
    expect(p.items!.length).toBeGreaterThan(0);
    const board = (await panel('get_settlement_board', { limit: 5 }))!;
    expect(board.items![0]!.title).toContain('Hughes');
    expect(board.items![0]!.sub).toContain('Offer $85,000');
  });
  it('a proposed change shows exactly what would change; a lone search hit and errors show nothing', async () => {
    const p = (await panel('propose_task_create', { subject: 'Call Dr. Patel', dueDate: '2026-08-04' }))!;
    expect(p.kind).toBe('confirm');
    expect(p.facts!.find((f) => f.k === 'Task')!.v).toBe('Call Dr. Patel');
    expect(p.note).toMatch(/TRIAL PERIOD/);
    expect(await panel('search_matters', { clientName: 'Grasso' })).toBeNull();
    expect(panelFor('get_matter_overview', {}, { error: 'No matter' })).toBeNull();
  });
});
