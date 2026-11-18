/**
 * Latency bench: PAM at firm scale (in-process mock, in-memory DB).
 *   pnpm bench            → data-path timings only (no API calls)
 *   pnpm bench llm        → also real turns against the model (costs a few cents)
 */
import { DateTime } from 'luxon';
import { buildGoldenDataset } from '../core/golden.js';
import { FIRM_TZ } from '../core/dates.js';
import { createMockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from '../server/db/index.js';
import { SyncWorker } from '../server/sync/worker.js';
import { buildSnapshot } from '../server/agent/snapshot.js';
import { runTool } from '../server/tools/registry.js';
import type { ToolContext } from '../server/tools/types.js';

const anchor = DateTime.now().setZone(FIRM_TZ).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
const data = buildGoldenDataset(anchor.toISO()!);
const N = Number(process.env['BENCH_MATTERS'] ?? 600);
for (let i = 0; i < 20000; i++) data.matterTypes.push({ id: `mt-cat-${i}`, name: `Catalog type ${i}`, category: 'Other', location: 'NY' });
for (let i = 0; i < N; i++) {
  const id = `m-x${i}`;
  data.matters.push({ id, number: `25-${2000 + i}`, status: i % 7 ? 'Open' : 'Closed', matterTypeId: 'mt-pi-ny', clientFirstName: 'Test', clientLastName: `Client-${i}`, description: '', createdAt: anchor.minus({ days: 300 }).toISO()!, updatedAt: anchor.minus({ days: 10 }).toISO()! });
  for (let k = 0; k < 6; k++) data.memos.push({ id: `memo-x${i}-${k}`, matterId: id, text: `Note ${k}. ${'Called client re treatment status and records. '.repeat(12)}${k === 0 && i % 3 === 0 ? 'Demand: $150,000. Offer: $40,000 made 7/1 by Pat Adjuster.' : ''}`, createdById: 's-jeff', updatedById: 's-jeff', createdAt: anchor.minus({ days: 60 }).toISO()!, updatedAt: anchor.minus({ days: 5 + k }).toISO()! });
  for (let k = 0; k < 8; k++) data.events.push({ id: `ev-x${i}-${k}`, matterId: id, subject: `Conference ${k}`, startTime: anchor.plus({ days: (i % 300) - 150 + k, hours: 2 }).toISO()!, endTime: anchor.plus({ days: (i % 300) - 150 + k, hours: 3 }).toISO()!, timeZone: FIRM_TZ, allDay: false, attendeeIds: ['s-frank'], onOfficeCalendar: false, createdAt: anchor.toISO()!, updatedAt: anchor.toISO()! } as never);
  for (let k = 0; k < 3; k++) data.tasks.push({ id: `tk-x${i}-${k}`, matterId: id, subject: `Follow up ${k}`, assigneeIds: ['s-isabel'], dueDate: anchor.plus({ days: k * 7 }).toISODate()!, isCompleted: false, createdById: 's-jeff', createdAt: anchor.toISO()!, updatedAt: anchor.toISO()! } as never);
}

const mock = createMockSmokeball(data);
const base = await mock.listen();
const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 2000 });
const { db, close } = await openDb();
let t = Date.now();
await new SyncWorker(db, client).fullSync();
console.log(`sync: ${Date.now() - t}ms — ${data.matters.length} matters, ${data.matterTypes.length} types, ${data.memos.length} notes, ${data.events.length} events, ${data.tasks.length} tasks`);
const ctx: ToolContext = { db, currentStaffId: 's-jeff', smokeball: client, confirmations: new Map(), writesEnabled: false };

const time = async (label: string, fn: () => Promise<unknown>, reps = 3) => {
  const ms: number[] = [];
  for (let i = 0; i < reps; i++) {
    const s = performance.now();
    await fn();
    ms.push(performance.now() - s);
  }
  console.log(`${label.padEnd(34)} ${ms.map((m) => `${Math.round(m)}ms`).join('  ')}`);
};
await time('buildSnapshot', () => buildSnapshot(ctx));
await time('get_calendar_events today', () => runTool(ctx, 'get_calendar_events', { scope: 'today' }));
await time('get_tasks all_open', () => runTool(ctx, 'get_tasks', { status: 'all_open' }));
await time('search_matters Grasso', () => runTool(ctx, 'search_matters', { clientName: 'Grasso' }));
await time('get_matter_overview', () => runTool(ctx, 'get_matter_overview', { matterId: 'm-grasso' }));
await time('get_settlement_board', () => runTool(ctx, 'get_settlement_board', { limit: 5 }));

if (process.argv[2] === 'llm') {
  const { runAgentTurn, anthropicLlm } = await import('../server/agent/loop.js');
  const variants = (process.env['BENCH_VARIANTS'] ?? 'default').split(',');
  const prompts = ['Brief me on today.', 'Where do we stand on Grasso?', 'What are the top five cases I am negotiating?', "What's in court this week?"];
  for (const v of variants) {
    const [model, effort, thinking] = v === 'default' ? [undefined, undefined, undefined] : v.split(':');
    const llm = await (anthropicLlm as (m?: string, o?: unknown) => Promise<import('../server/agent/loop.js').LlmClient>)(model || undefined, { effort, thinking });
    for (const q of prompts) {
      const s = performance.now();
      let first = 0;
      let note = 0;
      const r = await runAgentTurn(ctx, llm, [], q, {
        onText: () => (first ||= performance.now() - s),
        onNote: () => (note ||= performance.now() - s),
      } as never);
      const tm = (r as { timing?: unknown }).timing;
      console.log(`[${v}] ${q.padEnd(46)} first-sound ${Math.round(Math.min(first || 1e9, note || 1e9))}ms  first-answer ${Math.round(first)}ms  total ${Math.round(performance.now() - s)}ms  tools ${r.toolCalls.map((c) => c.name).join(',') || '-'}  chars ${r.text.length}${tm ? `  ${JSON.stringify(tm)}` : ''}`);
    }
  }
}
await mock.close();
await close();
