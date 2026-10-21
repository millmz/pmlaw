import type { Db } from './db/index.js';

/**
 * Self-checks for PAM's two external voices: the Anthropic brain and the
 * ElevenLabs voice. Each is a cheap request with a short timeout, cached
 * for a few minutes, so a dead key is reported on /healthz and in the orb's
 * status line instead of being discovered mid-conversation as a raw 401.
 */

export interface HealthResult {
  ok: boolean;
  detail: string;
  checkedAt: string;
}

const CACHE_MS = 3 * 60 * 1000;
let brainCache: { at: number; r: HealthResult } | null = null;
let voiceCache: { at: number; r: HealthResult } | null = null;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });

export async function checkBrain(model: string, force = false): Promise<HealthResult> {
  if (!force && brainCache && Date.now() - brainCache.at < CACHE_MS) return brainCache.r;
  const { pamApiKey } = await import('./agent/loop.js');
  const key = pamApiKey();
  let r: HealthResult;
  if (!key) {
    r = { ok: false, detail: 'no Anthropic key on the server', checkedAt: new Date().toISOString() };
  } else {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: key });
      // Cheapest authenticated call: count tokens (no generation billed).
      await withTimeout(client.messages.countTokens({ model, messages: [{ role: 'user', content: 'ok' }] }), 8000);
      r = { ok: true, detail: `${model} reachable`, checkedAt: new Date().toISOString() };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const detail = /invalid x-api-key|authentication_error|401/i.test(msg)
        ? 'Anthropic rejected the API key (invalid/revoked) — replace ANTHROPIC_API_KEY on the server'
        : /not_found|model/i.test(msg) && /model/i.test(msg)
          ? `model "${model}" not available to this key — set PAM_MODEL to one that is`
          : /credit|billing|overloaded|rate/i.test(msg)
            ? `Anthropic: ${msg.slice(0, 140)}`
            : `Anthropic unreachable: ${msg.slice(0, 140)}`;
      r = { ok: false, detail, checkedAt: new Date().toISOString() };
    }
  }
  brainCache = { at: Date.now(), r };
  return r;
}

export async function checkVoice(_db: Db, force = false): Promise<HealthResult> {
  if (!force && voiceCache && Date.now() - voiceCache.at < CACHE_MS) return voiceCache.r;
  const apiKey = (process.env['ELEVENLABS_API_KEY'] ?? '').trim();
  let r: HealthResult;
  if (!apiKey) {
    r = { ok: false, detail: 'no ElevenLabs key — browser voice in use', checkedAt: new Date().toISOString() };
  } else {
    try {
      const res = await withTimeout(
        fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': apiKey } }),
        8000,
      );
      if (res.status === 401) {
        r = { ok: false, detail: 'ElevenLabs rejected the API key — replace ELEVENLABS_API_KEY', checkedAt: new Date().toISOString() };
      } else if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { character_count?: number; character_limit?: number };
        const used = j.character_count ?? 0;
        const limit = j.character_limit ?? 0;
        const left = limit ? limit - used : null;
        r = {
          ok: left === null || left > 2000,
          detail: left === null ? 'ElevenLabs reachable' : `ElevenLabs reachable — ${left.toLocaleString()} characters left this cycle`,
          checkedAt: new Date().toISOString(),
        };
      } else if (res.status === 403) {
        // Key restricted to text-to-speech only can't read the subscription — that's fine.
        r = { ok: true, detail: 'ElevenLabs key present (restricted scope; usage not readable)', checkedAt: new Date().toISOString() };
      } else {
        r = { ok: false, detail: `ElevenLabs returned ${res.status}`, checkedAt: new Date().toISOString() };
      }
    } catch (e) {
      r = { ok: false, detail: `ElevenLabs unreachable: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`, checkedAt: new Date().toISOString() };
    }
  }
  voiceCache = { at: Date.now(), r };
  return r;
}
