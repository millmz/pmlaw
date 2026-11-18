import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import type { ToolContext } from './tools/types.js';
import { buildGreeting, spokenTime } from './greeting.js';

let mock: MockSmokeball;
let close: () => Promise<void>;
let ctx: ToolContext;
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

describe('the greeting when Jeff walks in', () => {
  it('8 AM: names him, the next thing on the calendar, and the task count — statute reminders not counted as chores', async () => {
    const g = await buildGreeting(ctx);
    expect(g.text).toMatch(/^Good morning, Jeff\./);
    expect(g.text).toContain('You have court at Town of Clarkstown Justice Court, on Vasquez, at nine.');
    expect(g.text).toMatch(/Eleven tasks due today and two overdue\./);
    expect(g.ambient.nextEvent).toMatchObject({ time: '9:00 AM', court: true });
    expect(g.ambient.eventsLeft).toBe(6);
  });
  it('late in the day: says what is left, or that the calendar is clear', async () => {
    const late = await buildGreeting({ ...ctx, fixedNowIso: '2026-07-27T16:40:00-04:00' });
    expect(late.text).toMatch(/^Good afternoon, Jeff\. One thing left on the calendar: .*in 20 minutes\./);
    const night = await buildGreeting({ ...ctx, fixedNowIso: '2026-07-27T21:00:00-04:00' });
    expect(night.text).toMatch(/^Good evening, Jeff\. Nothing left on the calendar today\./);
  });
  it('times are said the way a person says them', () => {
    const at = (h: number, m: number) => spokenTime(DateTime.fromObject({ hour: h, minute: m }));
    expect(at(9, 0)).toBe('nine');
    expect(at(9, 30)).toBe('nine 30');
    expect(at(14, 5)).toBe('two oh five');
    expect(at(12, 15)).toBe('twelve 15');
  });
});
