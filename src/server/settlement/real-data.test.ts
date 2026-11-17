import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, schema, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import {
  analyzeMatter,
  buildSettlementBoard,
  clearSettlementCache,
  configureSettlement,
  getSettlementBoard,
  isSettlementCandidate,
  normalizeMemoDate,
  parseMemoFacts,
} from './engine.js';
import { amountAppears, guardModelFacts, parseAmount, type NoteInput } from './note-reader.js';

/** What a real tenant will throw at the engine that the golden data does not. */

describe('which matters get a settlement analysis', () => {
  const base = { typeName: '', typeCategory: '', noteTexts: [], folderNames: [], fileNames: [] };
  it('injury-type matters by the tenant\'s own wording, not an exact category', () => {
    for (const typeName of ['Motor Vehicle Accident - Plaintiff', 'Negligence | Plaintiff', 'Medical Malpractice', 'Slip and Fall', 'PI - Auto', 'Wrongful Death']) {
      expect(isSettlementCandidate({ ...base, typeName, typeCategory: 'Litigation' }), typeName).toBe(true);
    }
  });
  it('a package on file or settlement talk in the notes qualifies any other matter', () => {
    expect(isSettlementCandidate({ ...base, typeName: 'General', folderNames: ['Settlement Package'] })).toBe(true);
    expect(isSettlementCandidate({ ...base, typeName: 'General Litigation', noteTexts: ['Adjuster offered 45k, we are at $120,000'] })).toBe(true);
  });
  it('criminal, real-estate and other non-settlement work stays off', () => {
    expect(isSettlementCandidate({ ...base, typeName: 'Criminal Defense', typeCategory: 'Criminal', noteTexts: ['DA plea offer; fine of $500'] })).toBe(false);
    expect(isSettlementCandidate({ ...base, typeName: 'Residential Purchase', typeCategory: 'Real Estate', noteTexts: ['Offer accepted at $450,000'] })).toBe(false);
    expect(isSettlementCandidate({ ...base, typeName: 'General', noteTexts: ['Called client back.'] })).toBe(false);
  });
});

describe('labelled notes, written less carefully', () => {
  it('reads "Demand of", "offered", k-notation, and never mistakes a deadline for a person', () => {
    const f = parseMemoFacts([
      { id: 'a', text: 'Carrier: Northline Casualty\nDemand of $250k sent.\nAdjuster: Dana Whitcomb (555) 452-8801' },
      { id: 'b', text: 'Whitcomb offered $85,000 on 7/22/26 — wants an answer by Friday.' },
    ]);
    expect(f.demand).toBe('$250,000');
    expect(f.offer).toBe('$85,000');
    expect(f.offerDate).toBe('2026-07-22');
    expect(f.offerBy).toBeUndefined();
    expect(f.insurer).toBe('Northline Casualty');
    expect(f.sourceMemoIds).toEqual(['a', 'b']);
  });
  it('"no demand conveyed" and "offer pending" are not figures', () => {
    const f = parseMemoFacts([{ id: 'a', text: 'No demand conveyed since depositions. Offer pending review of the $12,400 medical bill.' }]);
    expect(f.demand).toBeUndefined();
    expect(f.offer).toBeUndefined();
  });
});

describe('the model may only point at what the notes say', () => {
  const notes: NoteInput[] = [
    { id: 'n1', date: '2026-03-04T15:00:00.000Z', text: 'Spoke with Kevin Boland at Apex Mutual. We are holding at 120k.' },
    { id: 'n2', date: '2026-06-10T15:00:00.000Z', text: 'Boland came up to 45k on June 9. Told him not close. Limits are $300,000.' },
  ];
  it('amounts are matched the way an office writes them — and never by substring', () => {
    expect(parseAmount('45k')).toBe(45_000);
    expect(parseAmount('$1.5 million')).toBe(1_500_000);
    expect(amountAppears(45_000, 'came up to 45k today')).toBe(true);
    expect(amountAppears(45_000, 'offer of $45,000.00')).toBe(true);
    expect(amountAppears(45_000, 'paid $145,000')).toBe(false);
    expect(amountAppears(45_000, 'claim 9945000')).toBe(false);
    expect(amountAppears(1_500_000, 'they have 1.5 million in coverage')).toBe(true);
  });
  it('keeps verified values, normalizes them, and dates a yearless date from its note', () => {
    const g = guardModelFacts(
      { demand: '120k', offer: '45k', offerDateText: 'June 9', offerBy: 'Kevin Boland', insurer: 'Apex Mutual', policyLimits: '$300,000', sourceNoteIds: ['n2', 'bogus'] },
      notes,
      normalizeMemoDate,
    );
    expect(g.facts).toEqual({
      demand: '$120,000',
      offer: '$45,000',
      offerDate: '2026-06-09',
      offerBy: 'Kevin Boland',
      insurer: 'Apex Mutual',
      policyLimits: '$300,000',
    });
    expect(g.sourceMemoIds.sort()).toEqual(['n1', 'n2']);
    expect(g.rejected).toEqual([]);
  });
  it('discards anything invented: a rounded figure, a name not in the file, a date not written', () => {
    const g = guardModelFacts(
      { demand: '$125,000', offer: '$50,000', offerDateText: 'June 12', offerBy: 'Dana Whitcomb', adjusterName: 'Kevin Boland' },
      notes,
      normalizeMemoDate,
    );
    expect(g.facts).toEqual({ adjusterName: 'Kevin Boland' });
    expect(g.rejected.sort()).toEqual(['demand', 'offer', 'offerBy']);
  });
});

describe('the board on a tenant that looks nothing like the demo', () => {
  let mock: MockSmokeball;
  let db: Db;
  let closeDb: () => Promise<void>;
  let client: SmokeballClient;
  let downloads = 0;
  let reads = 0;

  beforeAll(async () => {
    const data = buildGoldenDataset();
    // The tenant's own matter-type vocabulary: no "Personal Injury" category anywhere.
    for (const t of data.matterTypes) {
      if (t.category === 'Personal Injury') Object.assign(t, { name: 'MVA - Plaintiff', category: 'Litigation' });
      if (t.category === 'Medical Malpractice') Object.assign(t, { name: 'Med Mal', category: 'Litigation' });
    }
    // A matter whose only settlement trail is a free-form note.
    data.memos.push({
      id: 'memo-petrov-free',
      matterId: 'm-petrov',
      text: 'Spoke w/ adjuster Lena Ortiz (Harbor Mutual). She came up to 60k on 7/20, we are holding at $185,000. Wants updated meds.',
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: '2026-07-20T15:00:00.000Z',
      updatedAt: '2026-07-20T15:00:00.000Z',
    });
    mock = createMockSmokeball(data);
    const base = await mock.listen();
    const real = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 500 });
    client = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'downloadFile') {
          return async (...args: [string, string]) => {
            downloads++;
            return target.downloadFile(...args);
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    }) as SmokeballClient;
    const opened = await openDb();
    db = opened.db;
    closeDb = opened.close;
    await new SyncWorker(db, real).fullSync();
    clearSettlementCache();
    configureSettlement({
      noteReader: async (notes) => {
        reads++;
        if (!notes.some((n) => n.text.includes('Lena Ortiz'))) return {};
        // One true reading, plus an invented limit the guard must drop.
        return { demand: '$185,000', offer: '60k', offerDateText: '7/20', offerBy: 'Lena Ortiz', insurer: 'Harbor Mutual', policyLimits: '$500,000' };
      },
    });
  });

  afterAll(async () => {
    configureSettlement({ noteReader: undefined });
    clearSettlementCache();
    await mock.close();
    await closeDb();
  });

  it('finds the same cases under the tenant\'s own type names', async () => {
    const board = await buildSettlementBoard(db, client, GOLDEN_ANCHOR_ISO);
    const names = board.map((s) => s.matterLabel).join(' | ');
    for (const n of ['Grasso', 'Fontana', 'Ricci', 'Bailey', 'Okafor', 'Tran', 'Hughes']) expect(names).toContain(n);
  });

  it('a free-form note puts the case on the board, flagged as read from notes, invented values dropped', async () => {
    const s = (await analyzeMatter(db, client, 'm-petrov', GOLDEN_ANCHOR_ISO))!;
    expect(s.status).toBe('in_negotiation');
    expect(s.facts.offer).toBe('$60,000');
    expect(s.facts.demand).toBe('$185,000');
    expect(s.facts.offerDate).toBe('2026-07-20');
    expect(s.facts.offerBy).toBe('Lena Ortiz');
    expect(s.facts.policyLimits).toBeUndefined(); // "$500,000" is nowhere in the notes
    expect(s.facts.interpreted).toEqual(expect.arrayContaining(['offer', 'demand']));
    expect(s.citations.some((c) => c.id === 'memo-petrov-free')).toBe(true);
    const r = reads;
    clearSettlementCache();
    await analyzeMatter(db, client, 'm-petrov', GOLDEN_ANCHOR_ISO);
    expect(reads).toBe(r); // the reading is kept per note version — asked once
  });

  it('labelled notes never reach the model', async () => {
    const before = reads;
    const s = (await analyzeMatter(db, client, 'm-grasso', GOLDEN_ANCHOR_ISO))!;
    expect(s.facts.interpreted).toBeUndefined();
    expect(reads).toBe(before);
  });

  it('after a restart nothing is re-downloaded and the model is not re-asked', async () => {
    await buildSettlementBoard(db, client, GOLDEN_ANCHOR_ISO);
    const d = downloads;
    const r = reads;
    clearSettlementCache(); // what a process restart does to the in-memory cache
    const board = await buildSettlementBoard(db, client, GOLDEN_ANCHOR_ISO);
    expect(board.length).toBeGreaterThanOrEqual(8);
    expect(downloads).toBe(d);
    expect(reads).toBe(r);
  });

  it('a changed file is read again (its signals are versioned)', async () => {
    const d = downloads;
    const f = (await db.select().from(schema.files).where(eq(schema.files.matterId, 'm-okafor'))).find((x) => /lien/i.test(x.name))!;
    await db.update(schema.files).set({ dateModified: '2026-07-27T07:00:00.000Z' }).where(eq(schema.files.id, f.id));
    await analyzeMatter(db, client, 'm-okafor', GOLDEN_ANCHOR_ISO);
    expect(downloads).toBe(d + 1);
  });

  it('a cold board never hangs the caller: partial now, complete shortly', async () => {
    clearSettlementCache();
    await db.delete(schema.derived);
    const slow = new Proxy(client, {
      get(target, prop, recv) {
        if (prop === 'downloadFile') {
          return async (...args: [string, string]) => {
            await new Promise((r) => setTimeout(r, 60));
            return target.downloadFile(...args);
          };
        }
        return Reflect.get(target, prop, recv) as unknown;
      },
    }) as SmokeballClient;
    const first = await getSettlementBoard(db, slow, GOLDEN_ANCHOR_ISO, 30);
    expect(first.warming).toBe(true);
    expect(first.total).toBeGreaterThan(0);
    const done = await getSettlementBoard(db, slow, GOLDEN_ANCHOR_ISO); // joins the same run
    expect(done.warming).toBe(false);
    expect(done.summaries.length).toBeGreaterThanOrEqual(8);
  });
});
