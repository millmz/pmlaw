import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { analyzeMatter, buildSettlementBoard, parseMemoFacts } from './engine.js';
import { runTool, validateCitations } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let client: SmokeballClient;
let ctx: ToolContext;

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 200 });
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

describe('memo fact parsing (Jeff’s real note patterns)', () => {
  it('extracts insurer, claim, limits, adjuster, demand, offer with attribution', () => {
    const facts = parseMemoFacts([
      {
        id: 'm1',
        text:
          'Insurance: Apex Mutual. Claim No. AM-2024-88213. Policy limits: $300,000. ' +
          'Adjuster: Kevin Boland, k.boland@apexmutual-ins.example, (555) 201-4433. ' +
          'Demand: $250,000 (sent with package). Offer: $110,000 made 2026-07-15 by Kevin Boland.',
      },
    ]);
    expect(facts.insurer).toBe('Apex Mutual');
    expect(facts.claimNumber).toBe('AM-2024-88213');
    expect(facts.policyLimits).toBe('$300,000');
    expect(facts.adjusterName).toContain('Kevin Boland');
    expect(facts.adjusterPhone).toBe('(555) 201-4433');
    expect(facts.demand).toBe('$250,000');
    expect(facts.offer).toBe('$110,000');
    expect(facts.offerBy).toContain('Kevin Boland');
    expect(facts.sourceMemoIds).toEqual(['m1']);
  });
});

describe('settlement engine — every golden trap', () => {
  it('Grasso: in negotiation, facts from notes, adjuster acknowledged', async () => {
    const s = (await analyzeMatter(db, client, 'm-grasso', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('in_negotiation');
    expect(s.facts.offer).toBe('$110,000');
    expect(s.facts.demand).toBe('$250,000');
    expect(s.packageSentDate).toBeTruthy(); // attachment evidence
    expect(s.timeline.some((t) => /adjuster replied/i.test(t.label))).toBe(true);
    expect(s.followUp?.state).toBe('overdue'); // the 22-days-late call
    expect((await validateCitations(db, s.citations)).valid).toBe(true);
  });

  it('Fontana: Dropbox-link email COUNTS as sent', async () => {
    const s = (await analyzeMatter(db, client, 'm-fontana', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('sent_verified');
    expect(s.packageSentTo).toContain('granitestate');
    expect(s.timeline.some((t) => /file link/.test(t.label))).toBe(true);
  });

  it('Ricci: mailed only — sending honestly unverified', async () => {
    const s = (await analyzeMatter(db, client, 'm-ricci', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('prepared_unverified');
    expect(s.statusReason).toContain('could not be verified');
    expect(s.packageSentDate).toBeUndefined();
  });

  it('Bailey (the trap): prepared draft is NEVER reported as sent', async () => {
    const s = (await analyzeMatter(db, client, 'm-bailey', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('prepared_unverified');
    expect(s.packageSentDate).toBeUndefined();
    expect(s.statusReason).not.toMatch(/was sent|has been sent/i);
  });

  it('Okafor: lien surfaces with amount', async () => {
    const s = (await analyzeMatter(db, client, 'm-okafor', GOLDEN_ANCHOR_ISO))!;
    expect(s.facts.lienTotal).toBe('$97,000.00');
    expect(s.facts.demand).toBe('$250,000');
  });

  it('Tran: in suit with depos + IME complete = ready to negotiate; injuries from bill of particulars', async () => {
    const s = (await analyzeMatter(db, client, 'm-tran', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('ready_in_suit');
    expect(s.facts.defenseCounsel).toContain('Calloway');
    expect(s.facts.injuries).toContain('fracture');
  });

  it('board ranks by negotiation recency and Hughes credits Isabel', async () => {
    const board = await buildSettlementBoard(db, client, GOLDEN_ANCHOR_ISO);
    expect(board.length).toBeGreaterThanOrEqual(5); // enough for a "top five"
    expect(board[0]!.matterLabel).toContain('Hughes'); // most recent negotiation touch (5 days ago)
    const hughes = board.find((s) => s.matterLabel.includes('Hughes'))!;
    expect(hughes.lastNegotiationBy).toContain('Isabel');
  });

  it('the board tool returns ranked rows with valid citations', async () => {
    const r = await runTool(ctx, 'get_settlement_board', { limit: 5 });
    const d = r.data as { count: number; matters: { matter: string; status: string }[] };
    expect(d.count).toBe(5);
    expect((await validateCitations(db, r.citations)).valid).toBe(true);
  });
});

describe('task reschedule — the first write action', () => {
  it('happy path: propose → confirm token → execute → verified in mock and cache', async () => {
    const proposal = await runTool(ctx, 'propose_task_reschedule', {
      taskQuery: 'Call adjuster Kevin Boland',
      newDueDate: '2026-08-07',
      reason: 'not ready to settle yet',
    });
    const pd = proposal.data as { confirmationRequired: boolean; confirmationToken: string; card: { from: string; to: string } };
    expect(pd.confirmationRequired).toBe(true);
    expect(pd.card.to).toBe('2026-08-07');

    const exec = await runTool(ctx, 'execute_task_reschedule', { confirmationToken: pd.confirmationToken });
    const ed = exec.data as { done: boolean; summary: string };
    expect(ed.done).toBe(true);
    expect(ed.summary).toContain('verified in Smokeball');
    // Landed in the mock (system of record):
    expect(mock.data.tasks.find((t) => t.id === 'task-1')!.dueDate).toBe('2026-08-07');
  });

  it('statute reminders are refused with an explanation, never moved', async () => {
    const r = await runTool(ctx, 'propose_task_reschedule', {
      taskQuery: 'Statute of Limitations - 6 Month Reminder - Petrov',
      newDueDate: '2026-09-01',
    });
    const d = r.data as { refused: boolean; reason: string };
    expect(d.refused).toBe(true);
    expect(d.reason).toContain('never rescheduled');
    const petrov = mock.data.tasks.find((t) => t.subject.includes('6 Month Reminder'))!;
    expect(petrov.dueDate).not.toBe('2026-09-01');
  });

  it('tokens are single-use and expire; ambiguous queries return candidates', async () => {
    const proposal = await runTool(ctx, 'propose_task_reschedule', {
      taskQuery: 'Review Fontana medicals',
      newDueDate: '2026-08-05',
    });
    const token = (proposal.data as { confirmationToken: string }).confirmationToken;
    await runTool(ctx, 'execute_task_reschedule', { confirmationToken: token });
    const replay = await runTool(ctx, 'execute_task_reschedule', { confirmationToken: token });
    expect((replay.data as { error: string }).error).toContain('expired or was already used');

    const ambiguous = await runTool(ctx, 'propose_task_reschedule', {
      taskQuery: 'Vasquez',
      newDueDate: '2026-08-06',
    });
    expect((ambiguous.data as { ambiguous: boolean }).ambiguous).toBe(true);
  });
});
