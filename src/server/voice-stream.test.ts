import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb, type Db } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import { buildApp } from './app.js';
import { stripThinking, type LlmClient, type LlmMessage } from './agent/loop.js';
import type { FastifyInstance } from 'fastify';

/** The orb room's server side: voice turns, panels, progress notes, speech clips. */

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
const seen: { who: string; system: string; messages: LlmMessage[] }[] = [];
let prewarmed = 0;
let script: 'lookup' | 'two-lookups' | 'refuse' | 'plain' = 'lookup';

const fake = (who: string): LlmClient => ({
  async create(params, hooks) {
    seen.push({ who, system: params.system.map((b) => b.text).join('\n'), messages: structuredClone(params.messages) });
    const toolResults = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).length;
    const turnStart = params.messages.map((m) => typeof m.content === 'string').lastIndexOf(true);
    const stepsThisTurn = params.messages.slice(turnStart + 1).filter((m) => m.role === 'assistant').length;
    if (script === 'refuse') return { stopReason: 'refusal', content: [] };
    if (script === 'plain' || stepsThisTurn > 0) {
      hooks?.onText?.('Court at nine in Clarkstown. ');
      hooks?.onText?.('Want the rest?');
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Court at nine in Clarkstown. Want the rest?' }], ttftMs: 5, ms: 9 };
    }
    hooks?.onNote?.('Checking the calendar.');
    return {
      stopReason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'Checking the calendar.', signature: 'sig' },
        { type: 'tool_use', id: `t${toolResults}a`, name: 'get_calendar_events', input: { scope: 'today' } },
        ...(script === 'two-lookups' ? [{ type: 'tool_use' as const, id: `t${toolResults}b`, name: 'get_tasks', input: { status: 'all_open' } }] : []),
      ],
      ttftMs: 4,
      ms: 8,
    };
  },
  async prewarm() {
    prewarmed++;
    return true;
  },
});

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const client = new SmokeballClient({ baseUrl: await mock.listen(), apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 500 });
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
  const worker = new SyncWorker(db, client);
  await worker.fullSync();
  app = buildApp({ ctx: { db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO, smokeball: client }, worker, llm: fake('main'), voiceLlm: fake('voice'), voiceModel: 'fast-model' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await mock.close();
  await closeDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['ELEVENLABS_API_KEY'];
});

type Frame = { type: string; text?: string; name?: string; panel?: { kind: string; title: string; items?: unknown[] }; timing?: { steps: { tools: { name: string }[] }[] } };
const chat = async (message: string, voice: boolean): Promise<Frame[]> => {
  const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message, voice } });
  expect(res.statusCode).toBe(200);
  return res.body.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Frame);
};

describe('a voice turn', () => {
  it('uses the fast model in voice mode, speaks a progress note, shows a panel, and reports where the time went', async () => {
    script = 'lookup';
    seen.length = 0;
    const frames = await chat('What is on my calendar?', true);
    expect(seen.every((s) => s.who === 'voice')).toBe(true);
    expect(seen[0]!.system).toContain('You are being heard, not read');
    const types = frames.map((f) => f.type);
    expect(types.indexOf('note_delta')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('note_delta')).toBeLessThan(types.indexOf('tool'));
    expect(types.indexOf('panel')).toBeLessThan(types.indexOf('text_delta')); // the screen is ready before she answers
    const panel = frames.find((f) => f.type === 'panel')!.panel!;
    expect(panel).toMatchObject({ kind: 'schedule', title: 'Today' });
    const done = frames.find((f) => f.type === 'done')!;
    expect(done.text).toBe('Court at nine in Clarkstown. Want the rest?');
    expect(done.timing!.steps[0]!.tools[0]!.name).toBe('get_calendar_events');
  });

  it('typed chat keeps the main model and is not told to speak', async () => {
    script = 'plain';
    seen.length = 0;
    await chat('And tomorrow?', false);
    expect(seen[0]!.who).toBe('main');
    expect(seen[0]!.system).not.toContain('You are being heard');
  });

  it('never replays an earlier turn’s thinking blocks (they are bound to that turn’s prompt)', async () => {
    script = 'plain';
    seen.length = 0;
    await chat('One more thing.', true);
    const replayed = seen[0]!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(replayed.some((b) => b.type === 'tool_use')).toBe(true); // the earlier lookup is still in history…
    expect(replayed.some((b) => b.type === 'thinking')).toBe(false); // …its thinking block is not
    expect(stripThinking([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }])[0]!.content).toEqual([{ type: 'text', text: '(continuing)' }]);
  });

  it('a briefing puts the day on the screen even when she answers from memory', async () => {
    script = 'plain';
    const frames = await chat('Brief me on today.', true);
    const kinds = frames.filter((f) => f.type === 'panel').map((f) => f.panel!.kind);
    expect(kinds).toEqual(['schedule', 'tasks']);
  });

  it('two lookups in one step both run and both show', async () => {
    script = 'two-lookups';
    await app.inject({ method: 'POST', url: '/api/chat/new' });
    const frames = await chat('How does the day look?', true);
    expect(frames.filter((f) => f.type === 'panel').map((f) => f.panel!.kind).sort()).toEqual(['schedule', 'tasks']);
    expect(frames.find((f) => f.type === 'done')!.timing!.steps[0]!.tools.map((t) => t.name).sort()).toEqual(['get_calendar_events', 'get_tasks']);
  });

  it('a declined request is said plainly, never silence', async () => {
    script = 'refuse';
    const frames = await chat('Something the model declines.', true);
    expect(frames.find((f) => f.type === 'done')!.text).toMatch(/wasn’t able to answer that one/);
    script = 'plain';
  });

  it('opening the room warms the voice model, at most once in a while', async () => {
    const a = (await app.inject({ method: 'POST', url: '/api/chat/prewarm' })).json() as { ok: boolean };
    const b = (await app.inject({ method: 'POST', url: '/api/chat/prewarm' })).json() as { ok: boolean; warm?: string };
    expect(a.ok).toBe(true);
    expect(b.warm).toBe('already');
    expect(prewarmed).toBe(2); // voice model + the typed-chat model, once each
  });
});

describe('speech clips', () => {
  const audio = (parts: string[]) =>
    new Response(new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(new TextEncoder().encode(p))), c.close()) }), { status: 200 });

  it('a clip is requested by POST (text never in a URL) and played by id; the fast streaming voice is asked first', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'k';
    const calls: { url: string; model: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, model: (JSON.parse(init.body) as { model_id: string }).model_id });
      return audio(['ID3-', 'audio-bytes']);
    });
    const res = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'Court at nine.', stream: true } });
    const { id } = res.json() as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]).toMatchObject({ model: 'eleven_flash_v2_5' });
    expect(calls[0]!.url).toContain('/stream');
    expect(calls[0]!.url).not.toContain('Court');
    const clip = await app.inject({ method: 'GET', url: `/api/tts/clip/${id}` });
    expect(clip.headers['content-type']).toBe('audio/mpeg');
    expect(clip.body).toBe('ID3-audio-bytes');
    // The same sentence again (prefetch, then play) is one synthesis, not two.
    const again = (await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'Court at nine.', prefetch: true } })).json() as { id: string };
    expect(again.id).toBe(id);
    expect(calls).toHaveLength(1);
  });

  it('if the streaming voice is refused, the previous known-good request is used', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'k';
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model_id: string }).model_id;
      calls.push(`${url.includes('/stream') ? 'stream' : 'whole'}:${model}`);
      return url.includes('/stream') ? new Response('{}', { status: 400 }) : audio(['whole-clip']);
    });
    const res = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'A different sentence.' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('whole-clip');
    expect(calls).toEqual(['stream:eleven_flash_v2_5', 'whole:eleven_turbo_v2_5']);
  });

  it('a dead key is reported as such, and the failure is not cached', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'k';
    let status = 401;
    vi.stubGlobal('fetch', async () => (status === 200 ? audio(['ok']) : new Response('{}', { status })));
    const bad = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'Third sentence.', stream: true } });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toEqual({ error: 'bad_key' });
    status = 200;
    const good = await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'Third sentence.' } });
    expect(good.body).toBe('ok');
  });

  it('without a key the browser voice takes over (501), and a recorded question is transcribed when there is one', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tts', payload: { text: 'x' } })).statusCode).toBe(501);
    process.env['ELEVENLABS_API_KEY'] = 'k';
    let form: FormData | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => {
      form = init.body;
      return new Response(JSON.stringify({ text: ' where do we stand on Grasso ' }), { status: 200 });
    });
    const res = await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': 'audio/webm;codecs=opus' }, payload: Buffer.alloc(4000, 1) });
    expect(res.json()).toEqual({ text: 'where do we stand on Grasso' });
    expect(form!.get('model_id')).toBe('scribe_v2');
    expect((form!.get('file') as File).size).toBe(4000);
    expect((await app.inject({ method: 'POST', url: '/api/stt', headers: { 'content-type': 'audio/webm' }, payload: Buffer.alloc(10) })).statusCode).toBe(400);
  });
});
