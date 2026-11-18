import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import type { ToolContext } from './tools/types.js';
import { buildSettlementBoard } from './settlement/engine.js';
import { firmVocabulary, nameHints, voiceInputNote } from './voice-hints.js';

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
  await buildSettlementBoard(opened.db, client, GOLDEN_ANCHOR_ISO); // adjusters and carriers join the vocabulary
});
afterAll(async () => {
  await mock.close();
  await close();
});

const hintsFor = async (heard: string) => nameHints(heard, await firmVocabulary(ctx)).map((h) => `${h.heard}→${h.name}`);

describe('names the recognizer mangled are matched to names on file', () => {
  it('clients, however the recognizer spelled them', async () => {
    expect(await hintsFor('where do we stand on grass oh')).toContain('grass oh→Grasso');
    expect(await hintsFor('any update on the oak afore matter')).toContain('oak afore→Okafor');
    expect(await hintsFor('what is the status of fontanna')).toContain('fontanna→Fontana');
    expect(await hintsFor("pull up vaskez's file")).toContain("vaskez's→Vasquez");
    expect(await hintsFor('did we hear back on petroff')).toContain('petroff→Petrov');
    expect(await hintsFor('what about richie')).toContain('richie→Ricci');
  });
  it('adjusters and carriers from the settlement notes, and staff', async () => {
    expect(await hintsFor('did bowland call back')).toContain('bowland→Boland');
    expect(await hintsFor('what did whitcom offer')).toContain('whitcom→Whitcomb');
    expect((await hintsFor('what is on isabelle calendar')).some((h) => h.endsWith('→Isabel'))).toBe(true);
  });
  it('ordinary questions are left alone — no name is conjured from everyday words', async () => {
    for (const q of [
      "what's on my calendar today",
      'what tasks are overdue',
      'brief me on today',
      'what are the top five cases I am negotiating',
      "what's in court this week",
      'create a task to call the adjuster tomorrow',
      'move that to next Tuesday',
      'yes go ahead',
      'which matters have no next step scheduled',
      'who is negotiating the settlement',
    ]) {
      expect(await hintsFor(q), q).toEqual([]);
    }
  });
  it('a name heard correctly needs no hint', async () => {
    expect(await hintsFor('where do we stand on Grasso')).toEqual([]);
    expect(await hintsFor('did Boland call back about Hughes')).toEqual([]);
  });
});

describe('the note the model receives for a spoken question', () => {
  it('names what was heard, the recognizer’s other guesses, and the close names — and how to use them', async () => {
    const note = await voiceInputNote(ctx, 'where do we stand on oak afore', ['where do we stand on Okafor', 'where do we stand on okay for']);
    expect(note).toContain('Heard: "where do we stand on oak afore"');
    expect(note).toContain('"where do we stand on Okafor"');
    expect(note).toContain('Names on file that appear in those other guesses: Okafor');
    expect(note).toContain('"oak afore" ≈ Okafor (client)');
    expect(note).toMatch(/mentioning the name you understood/);
  });
  it('is empty when the transcript needs no help', async () => {
    expect(await voiceInputNote(ctx, "what's on my calendar today")).toBe('');
  });
});
