import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { checkVoice } from './health.js';
import { openDb } from './db/index.js';

/** The voice check reads ElevenLabs' subscription endpoint; it must classify
 *  the three states a key can be in and never throw. */
describe('checkVoice', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env['ELEVENLABS_API_KEY'];
  });

  it('reports no key, a rejected key, low credits, and restricted scope distinctly', async () => {
    const { db, close } = await openDb();
    expect((await checkVoice(db, true)).detail).toMatch(/no ElevenLabs key/);

    process.env['ELEVENLABS_API_KEY'] = 'k';
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    expect((await checkVoice(db, true)).detail).toMatch(/rejected the API key/);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ character_count: 99_000, character_limit: 100_000 }), { status: 200 })) as typeof fetch;
    const low = await checkVoice(db, true);
    expect(low.ok).toBe(false);
    expect(low.detail).toMatch(/1,000 characters left/);

    globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch;
    const restricted = await checkVoice(db, true);
    expect(restricted.ok).toBe(true);
    expect(restricted.detail).toMatch(/restricted scope/);

    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect((await checkVoice(db, true)).detail).toMatch(/unreachable/);
    await close();
  });
});
