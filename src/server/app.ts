import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './db/index.js';
import type { SyncWorker } from './sync/worker.js';
import { getTodayData } from './api/today.js';
import { runAgentTurn, type LlmClient, type LlmMessage } from './agent/loop.js';
import { runTool } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

/**
 * The PAM web app: JSON API + SSE chat + static SPA, behind cookie-session
 * auth (login page UX instead of the browser Basic-auth popup). Built as a
 * factory so Playwright and integration tests boot the identical app.
 */

export interface AppDeps {
  ctx: ToolContext;
  worker: SyncWorker;
  llm?: LlmClient | undefined;
  /** The model behind the orb room: chosen for speed to first word. Falls back to `llm`. */
  voiceLlm?: LlmClient | undefined;
  voiceModel?: string | undefined;
  /** When set, /api/* requires a session cookie obtained via /api/login. */
  accessCode?: string | undefined;
  /** False when the DB fell back to memory (persistent disk missing). */
  dataPersistent?: boolean | undefined;
  /** Signing key registered with Smokeball; when set, deliveries must verify. */
  webhookKey?: string | undefined;
}

const SESSION_COOKIE = 'pam_session';

const sessionToken = (secret: string) =>
  createHmac('sha256', secret).update('pam-session-v1').digest('hex');

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const { ctx, worker, accessCode } = deps;
  const app = Fastify({ logger: false });
  // Recorded questions for /api/stt arrive as raw audio.
  app.addContentTypeParser(/^audio\/.+/, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  void app.register(fastifyCookie);

  const authed = (req: FastifyRequest): boolean => {
    if (!accessCode) return true;
    const cookie = req.cookies[SESSION_COOKIE];
    return typeof cookie === 'string' && safeEqual(cookie, sessionToken(accessCode));
  };

  // The diagnostics key: a separate, narrow credential that opens ONLY the
  // no-client-data health pages — so PAM can be checked from outside (by
  // Adam's assistant) without the access code and without exposing a file.
  const DIAG_ROUTES = new Set(['/api/diag', '/api/status', '/api/smokeball/verify', '/api/smokeball/inspect', '/api/chat/timing', '/api/health/services']);
  let diagKey: string | null = null;
  const getDiagKey = async (): Promise<string> => {
    if (diagKey) return diagKey;
    const row = (await ctx.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'diag.key')).limit(1))[0];
    if (row?.value) return (diagKey = row.value);
    const fresh = `pamdiag-${randomUUID().replace(/-/g, '')}`;
    await ctx.db.insert(schema.appSettings).values({ key: 'diag.key', value: fresh }).onConflictDoNothing();
    return (diagKey = fresh);
  };

  app.addHook('onRequest', async (req, reply) => {
    const open =
      req.url === '/healthz' ||
      req.url.startsWith('/webhooks/') ||
      req.url === '/api/login' ||
      req.url === '/api/me' ||
      !req.url.startsWith('/api/');
    if (open) return;
    if (authed(req)) return;
    const offered = req.headers['x-pam-key'];
    if (typeof offered === 'string' && req.method === 'GET' && DIAG_ROUTES.has(req.url.split('?')[0]!)) {
      const key = await getDiagKey();
      if (offered.length === key.length && safeEqual(offered, key)) return;
    }
    return reply.code(401).send({ error: 'authentication required' });
  });

  app.get('/api/diag', async () => {
    const { buildDiag } = await import('./diag.js');
    const { PAM_MODEL } = await import('./agent/loop.js');
    return buildDiag(ctx, worker, { lastTurnTiming, models: { chat: PAM_MODEL, voice: deps.voiceModel ?? PAM_MODEL }, writes: ctx.writesEnabled !== false });
  });
  /** Shown on the admin settings page; never reachable with the diag key itself. */
  app.get('/api/diag/key', async () => ({ key: await getDiagKey() }));

  app.get('/healthz', async () => {
    const { checkBrain, checkVoice } = await import('./health.js');
    const { PAM_MODEL } = await import('./agent/loop.js');
    const [brain, voice] = deps.llm
      ? await Promise.all([checkBrain(PAM_MODEL), checkVoice(ctx.db)])
      : [{ ok: false, detail: 'no Anthropic key on the server' }, { ok: false, detail: 'not checked' }];
    return {
      ok: true,
      commit: (process.env['RENDER_GIT_COMMIT'] ?? 'dev').slice(0, 10),
      web: existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web', 'index.html'))
        ? 'built'
        : 'MISSING',
      storage: deps.dataPersistent === false ? 'IN MEMORY' : 'persistent',
      mode: process.env['SMOKEBALL_BASE_URL'] ? 'real' : 'mock',
      writes: ctx.writesEnabled === false ? 'off (shadow)' : 'on',
      model: PAM_MODEL,
      voiceModel: deps.voiceModel ?? PAM_MODEL,
      brain: brain.ok ? 'ok' : `DOWN — ${brain.detail}`,
      voice: voice.ok ? 'ok' : voice.detail,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  // ------------------------------------------------------------------ auth
  app.post('/api/login', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!accessCode) return { ok: true }; // local dev: no gate
    if (!code || !safeEqual(code, accessCode)) {
      return reply.code(401).send({ error: 'That code isn’t right. Check the access code and try again.' });
    }
    void reply.setCookie(SESSION_COOKIE, sessionToken(accessCode), {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    // The signed-in lawyer, from the mirror once it knows who that is. Only
    // revealed past the access gate; the fallback is the firm's public name.
    let user = { name: 'Jeff Millman', initials: 'JTM', staffId: ctx.currentStaffId };
    if (authed(req)) {
      const row = await ctx.db.query.staff.findFirst({ where: eq(schema.staff.id, ctx.currentStaffId) }).catch(() => undefined);
      const name = row ? `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() : '';
      if (row && name) {
        const initials = (row.initials || name.split(/\s+/).map((w) => w[0]).join('')).toUpperCase().slice(0, 3);
        user = { name, initials, staffId: row.id };
      }
    }
    const { appNow, FIRM_TZ } = await import('../core/dates.js');
    return {
      authed: authed(req),
      gated: Boolean(accessCode),
      chatEnabled: Boolean(deps.llm),
      writesEnabled: ctx.writesEnabled !== false,
      // The firm's date as the server sees it — "days until" is counted from here.
      today: appNow(ctx.fixedNowIso).setZone(FIRM_TZ).toISODate(),
      user,
    };
  });

  // ------------------------------------------------------------------ data
  app.get('/api/today', async () => getTodayData(ctx));

  /** One day's schedule + tasks due that day — powers the Today day-tabs. */
  app.get('/api/day', async (req) => {
    const { date } = req.query as { date?: string };
    const { appNow, FIRM_TZ } = await import('../core/dates.js');
    const { DateTime } = await import('luxon');
    const now = appNow(ctx.fixedNowIso);
    const target = date
      ? DateTime.fromISO(date, { zone: FIRM_TZ }).startOf('day')
      : now.setZone(FIRM_TZ).startOf('day');
    const iso = target.toISODate()!;
    const isToday = target.hasSame(now.setZone(FIRM_TZ), 'day');

    const events = await runTool(ctx, 'get_calendar_events', { scope: 'range', from: iso, to: iso });
    const allTasks = await runTool(ctx, 'get_tasks', { status: 'all_open', limit: 5000 });
    // Tools answer { error } (no buckets) when the staff member isn't in the
    // mirror yet — degrade to empty lists, never 500 (blank-site bug).
    type DueRow = { dueDate?: string | null };
    const buckets = allTasks.data as
      | { overdue?: DueRow[]; dueToday?: DueRow[]; upcoming?: DueRow[] }
      | undefined;
    const tasksDue = isToday
      ? (buckets?.dueToday ?? [])
      : [...(buckets?.upcoming ?? []), ...(buckets?.overdue ?? [])].filter((t) => t.dueDate === iso);

    return {
      dateIso: iso,
      isToday,
      todayIso: now.setZone(FIRM_TZ).toISODate(),
      label: target.toFormat(isToday ? "'Today —' cccc, LLLL d" : 'cccc, LLLL d'),
      events: (events.data as { events?: unknown[] })?.events ?? [],
      tasksDue,
      asOf: events.asOf,
      nowIso: now.toISO(),
    };
  });

  /** Full task buckets — powers the Tasks page. Statute reminders are pulled
   *  out of EVERY bucket (not just overdue): they are never movable, so they
   *  never belong next to a "Move to…" button. */
  app.get('/api/tasks', async () => {
    const { isStatuteReminder } = await import('../core/dates.js');
    const [all, overdue] = [
      await runTool(ctx, 'get_tasks', { status: 'all_open', limit: 5000 }),
      await runTool(ctx, 'get_tasks', { status: 'overdue', limit: 5000 }),
    ];
    type Row = { subject: string };
    const allData = all.data as { dueToday?: Row[]; upcoming?: Row[] } | undefined;
    const od = overdue.data as
      | { needsDecision?: Row[]; statuteReminders?: { note: string; tasks: Row[] } }
      | undefined;
    const dueToday = allData?.dueToday ?? [];
    const upcoming = allData?.upcoming ?? [];
    const statute = od?.statuteReminders ?? { note: '', tasks: [] };
    const statuteUpcoming = [...dueToday, ...upcoming].filter((t) => isStatuteReminder(t.subject));
    return {
      dueToday: dueToday.filter((t) => !isStatuteReminder(t.subject)),
      upcoming: upcoming.filter((t) => !isStatuteReminder(t.subject)),
      needsDecision: od?.needsDecision ?? [],
      statuteReminders: {
        note: statute.note,
        tasks: [...statute.tasks, ...statuteUpcoming],
      },
      asOf: all.asOf,
    };
  });

  app.get('/api/matters', async (req) => {
    const q = req.query as { clientName?: string; practiceArea?: string; status?: string };
    const result = await runTool(ctx, 'search_matters', {
      limit: 10000, // the page shows every match, a page at a time
      ...(q.clientName ? { clientName: q.clientName } : {}),
      ...(q.practiceArea ? { practiceArea: q.practiceArea } : {}),
      ...(q.status ? { status: q.status as 'Open' | 'Closed' | 'any' } : {}),
    });
    return result.data;
  });

  app.get<{ Params: { id: string } }>('/api/matters/:id', async (req) => {
    const result = await runTool(ctx, 'get_matter_overview', { matterId: req.params.id, fileLimit: 100000 });
    return { ...(result.data as Record<string, unknown>), asOf: result.asOf };
  });

  app.get('/api/courts', async (req) => {
    const q = req.query as { scope?: string; from?: string; to?: string };
    const result = await runTool(ctx, 'get_calendar_events', {
      scope: (q.scope ?? 'next_week_courts') as 'today' | 'this_week' | 'next_week_courts' | 'range',
      officeCalendar: true,
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
    });
    return result.data;
  });

  // -------------------------------------------------- identity & settings
  const EDITABLE_SETTINGS = new Set(['identity.md', 'knowledge.md', 'elevenlabs_voice_id']);

  // Service health: brain (Anthropic) + voice (ElevenLabs), cached 3 min;
  // ?force=1 re-checks now. Surfaced on /healthz, /api/smokeball/verify,
  // and the orb's status line.
  app.get('/api/health/services', async (req) => {
    const force = (req.query as { force?: string }).force === '1';
    const { checkBrain, checkVoice } = await import('./health.js');
    const { PAM_MODEL } = await import('./agent/loop.js');
    const [brain, voice] = await Promise.all([checkBrain(PAM_MODEL, force), checkVoice(ctx.db, force)]);
    return { brain, voice, model: PAM_MODEL };
  });

  app.get('/api/settings', async () => {
    const { getIdentity, getKnowledge } = await import('./identity.js');
    const { eq } = await import('drizzle-orm');
    const voiceRow = await ctx.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'elevenlabs_voice_id'))
      .limit(1);
    const { pamApiKeyInfo } = await import('./agent/loop.js');
    const info = pamApiKeyInfo();
    const elevenKey = (process.env['ELEVENLABS_API_KEY'] ?? '').trim();
    return {
      'identity.md': await getIdentity(ctx.db),
      'knowledge.md': await getKnowledge(ctx.db),
      elevenlabs_voice_id: voiceRow[0]?.value ?? '',
      ttsConfigured: Boolean(elevenKey),
      // Safe key audit: source + shape only, never the value.
      brain: {
        source: info.source,
        prefix: info.prefix,
        length: info.length,
        looksAnthropic: info.looksAnthropic,
        skipped: info.skipped,
      },
      voiceKey: elevenKey
        ? { prefix: elevenKey.slice(0, 3), length: elevenKey.length, looksElevenLabs: !elevenKey.startsWith('sk-ant-') }
        : null,
    };
  });

  app.put<{ Params: { key: string } }>('/api/settings/:key', async (req, reply) => {
    const key = req.params.key;
    if (!EDITABLE_SETTINGS.has(key)) return reply.code(400).send({ error: `"${key}" is not editable.` });
    const { value } = (req.body ?? {}) as { value?: string };
    if (typeof value !== 'string') return reply.code(400).send({ error: 'value (string) required' });
    const { putSetting } = await import('./identity.js');
    await putSetting(ctx.db, key, value);
    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: `settings:edit:${key}`,
      params: { bytes: value.length },
      result: 'saved',
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ tts
  // ElevenLabs relay: the key stays server-side, restricted to synthesis.
  // Clips are held in memory by (voice, text) so a sentence that was
  // PREFETCHED while the previous one played is served instantly.
  //
  // A clip is requested by POST (the text never rides in a URL, where it
  // would land in request logs) and played by GET /api/tts/clip/:id, which
  // relays the audio AS IT IS GENERATED — the browser starts playing on the
  // first bytes instead of after the whole sentence is synthesized.
  interface Clip {
    id: string;
    key: string;
    chunks: Buffer[];
    done: boolean;
    failed: string | null;
    at: number;
    waiters: Set<() => void>;
  }
  const clipsByKey = new Map<string, Clip>();
  const clipsById = new Map<string, Clip>();
  const TTS_CACHE_MAX = 240;
  const TTS_CACHE_TTL_MS = 15 * 60 * 1000;
  const wake = (c: Clip) => {
    for (const w of c.waiters) w();
    c.waiters.clear();
  };
  const evictClips = () => {
    const now = Date.now();
    for (const c of [...clipsById.values()].sort((x, y) => x.at - y.at)) {
      if (clipsById.size <= TTS_CACHE_MAX && now - c.at < TTS_CACHE_TTL_MS) break;
      clipsById.delete(c.id);
      if (clipsByKey.get(c.key) === c) clipsByKey.delete(c.key);
    }
  };
  /** Ask ElevenLabs for the clip: fastest model + streaming first; if that
   *  combination is refused, the previous known-good request. */
  const synthesize = async (c: Clip, apiKey: string, voiceId: string, text: string) => {
    const attempt = (path: string, model: string) =>
      fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}${path}?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: model }),
      });
    try {
      const fast = process.env['PAM_TTS_MODEL']?.trim() || 'eleven_flash_v2_5';
      let res = await attempt('/stream', fast);
      if (!res.ok && res.status !== 401 && res.status !== 429) res = await attempt('', 'eleven_turbo_v2_5');
      if (!res.ok || !res.body) {
        c.failed = res.status === 401 ? 'bad_key' : res.status === 429 ? 'out_of_credits' : `elevenlabs_${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) {
          c.chunks.push(Buffer.from(value));
          wake(c);
        }
      }
    } catch (e) {
      c.failed = `tts_${String(e instanceof Error ? e.message : e).slice(0, 60)}`;
    } finally {
      c.done = true;
      if (c.failed || c.chunks.length === 0) {
        c.failed ??= 'empty_audio';
        if (clipsByKey.get(c.key) === c) clipsByKey.delete(c.key); // never cache a failure
      }
      wake(c);
    }
  };
  const clipFor = async (text: string): Promise<Clip | { error: string; code: number }> => {
    const apiKey = (process.env['ELEVENLABS_API_KEY'] ?? '').trim();
    if (!apiKey) return { error: 'no_tts_key', code: 501 };
    const voiceRow = await ctx.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'elevenlabs_voice_id')).limit(1);
    const voiceId = voiceRow[0]?.value || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" default
    const clean = text.slice(0, 2500);
    const key = `${voiceId}\u0000${clean}`;
    const hit = clipsByKey.get(key);
    if (hit && !hit.failed && Date.now() - hit.at < TTS_CACHE_TTL_MS) return hit;
    const c: Clip = { id: randomUUID(), key, chunks: [], done: false, failed: null, at: Date.now(), waiters: new Set() };
    clipsByKey.set(key, c);
    clipsById.set(c.id, c);
    evictClips();
    void synthesize(c, apiKey, voiceId, clean);
    return c;
  };
  /** Wait for the clip to have its first audio (or fail). */
  const firstAudio = (c: Clip, ms = 12_000) =>
    new Promise<void>((resolve) => {
      if (c.chunks.length || c.done) return resolve();
      const t = setTimeout(resolve, ms);
      c.waiters.add(() => {
        clearTimeout(t);
        resolve();
      });
    });

  app.post('/api/tts', async (req, reply) => {
    const { text, prefetch, stream } = (req.body ?? {}) as { text?: string; prefetch?: boolean; stream?: boolean };
    if (!text?.trim()) return reply.code(400).send({ error: 'empty text' });
    const c = await clipFor(text);
    if ('error' in c) return reply.code(c.code).send({ error: c.error });
    if (prefetch || stream) {
      // Report a dead key/credit problem now rather than as a silent clip.
      await firstAudio(c, stream ? 2500 : 50);
      if (c.failed) return reply.code(502).send({ error: c.failed });
      return { id: c.id, cached: c.done };
    }
    // Whole-clip response (older clients, Safari): wait for it all.
    while (!c.done) await new Promise<void>((r) => c.waiters.add(r));
    if (c.failed) return reply.code(502).send({ error: c.failed });
    return reply.type('audio/mpeg').send(Buffer.concat(c.chunks));
  });

  app.get<{ Params: { id: string } }>('/api/tts/clip/:id', async (req, reply) => {
    const c = clipsById.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'no such clip' });
    await firstAudio(c);
    if (c.failed || c.chunks.length === 0) return reply.code(502).send({ error: c.failed ?? 'no_audio' });
    if (c.done) return reply.type('audio/mpeg').header('cache-control', 'no-store').send(Buffer.concat(c.chunks));
    reply.raw.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    let i = 0;
    for (;;) {
      while (i < c.chunks.length) reply.raw.write(c.chunks[i++]);
      if (c.done) break;
      await new Promise<void>((r) => c.waiters.add(r));
    }
    reply.raw.end();
    return reply;
  });

  /** Speech-to-text for browsers with no built-in recognition (Firefox,
   *  Chrome on iPhone): the recorded question is transcribed by ElevenLabs
   *  and discarded — never stored. */
  app.post('/api/stt', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const apiKey = (process.env['ELEVENLABS_API_KEY'] ?? '').trim();
    if (!apiKey) return reply.code(501).send({ error: 'no_stt_key' });
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 800) return reply.code(400).send({ error: 'no audio' });
    const type = String(req.headers['content-type'] ?? 'audio/webm').split(';')[0]!;
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
    const attempt = async (model: string) => {
      const form = new FormData();
      form.append('model_id', model);
      form.append('language_code', 'en');
      form.append('tag_audio_events', 'false');
      form.append('file', new Blob([new Uint8Array(audio)], { type }), `question.${ext}`);
      return fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form });
    };
    try {
      let res = await attempt(process.env['PAM_STT_MODEL']?.trim() || 'scribe_v2');
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) res = await attempt('scribe_v1');
      if (!res.ok) {
        const detail = res.status === 401 ? 'bad_key' : res.status === 429 ? 'out_of_credits' : res.status === 403 ? 'key_lacks_speech_to_text_permission' : `elevenlabs_${res.status}`;
        return reply.code(502).send({ error: detail });
      }
      const j = (await res.json()) as { text?: string };
      return { text: (j.text ?? '').trim() };
    } catch (e) {
      return reply.code(502).send({ error: `stt_${String(e instanceof Error ? e.message : e).slice(0, 80)}` });
    }
  });

  app.get('/api/settlements', async () => {
    // The page gets what is ready within a few seconds and polls while
    // `warming` — a cold board on a big firm takes minutes, not a spinner.
    const { settlementBoardResult } = await import('./tools/settlement-tools.js');
    try {
      return (await settlementBoardResult(ctx, undefined, 5000)).data;
    } catch (e) {
      return { count: 0, matters: [], error: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
  });

  app.get('/api/audit', async () => {
    const rows = await ctx.db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(100);
    // Flags never scroll off the bottom of the log.
    const flags = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'feedback'))
      .orderBy(desc(schema.auditLog.id))
      .limit(50);
    return { entries: rows, flags };
  });

  /** "Something looks wrong" — one tap from any page. Lands in the audit
   *  log so the trial week produces a list of things to fix, in the user's
   *  own words, instead of things half-remembered. */
  app.post('/api/feedback', async (req, reply) => {
    const b = (req.body ?? {}) as { note?: unknown; page?: unknown; context?: unknown };
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
    if (!note) return reply.code(400).send({ error: 'Say what looks wrong.' });
    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'feedback',
      params: {
        note,
        page: typeof b.page === 'string' ? b.page.slice(0, 120) : undefined,
        context: typeof b.context === 'string' ? b.context.slice(0, 1500) : undefined,
      },
      result: 'flagged for review',
    });
    return { ok: true };
  });

  /** Pull now. `?full=1` re-reads everything (runs in the background — a
   *  real firm takes minutes; watch /api/status for progress). */
  app.post('/api/sync', async (req) => {
    const { full } = req.query as { full?: string };
    if (full === '1' || full === 'true') {
      if (worker.busy) return { ok: true, started: false, note: 'a sync is already running', progress: worker.progress };
      worker.fullSync().catch((e) => console.error('[pam] manual full sync failed:', e instanceof Error ? e.message : e));
      return { ok: true, started: true };
    }
    const counts = await worker.incrementalSync();
    return { ok: true, counts };
  });

  /** Live state for the header pill and the first-sync banner. Cheap: the UI
   *  polls it. */
  app.get('/api/status', async () => {
    const count = async (t: typeof schema.matters | typeof schema.tasks | typeof schema.events | typeof schema.memos) =>
      Number((await ctx.db.select({ n: sql<number>`count(*)` }).from(t))[0]?.n ?? 0);
    const mirror = {
      matters: await count(schema.matters),
      tasks: await count(schema.tasks),
      events: await count(schema.events),
      notes: await count(schema.memos),
    };
    const last = worker.lastSync;
    const state = worker.firstRun ? 'first-sync' : worker.busy && worker.progress?.kind === 'full' ? 'syncing' : last && !last.ok ? 'error' : worker.lastOkAt ? 'ok' : 'starting';
    return {
      mode: ctx.fixedNowIso ? 'demo' : 'live',
      writesEnabled: ctx.writesEnabled !== false,
      sync: {
        state,
        progress: worker.progress,
        lastOkAt: worker.lastOkAt,
        lastError: last && !last.ok ? last.error : null,
        warnings: last?.warnings ?? [],
      },
      mirror,
    };
  });

  // Shape-only sample of what the REAL tenant sends — field names and types,
  // never values — so custom-field keys (statute date, date of loss) can be
  // mapped from a paste without exposing client data.
  app.get('/api/smokeball/inspect', async (_req, reply) => {
    if (!ctx.smokeball) return reply.code(503).send({ error: 'no Smokeball client configured' });
    const { shapeOf } = await import('./inspect.js');
    const sb = ctx.smokeball;
    const out: Record<string, unknown> = {};
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      try {
        out[name] = shapeOf(await fn());
      } catch (e) {
        out[name] = `unavailable: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
      }
    };
    await probe('matter', () => sb.rawFirst('/matters'));
    await probe('task', () => sb.rawFirst('/tasks'));
    await probe('event', () => sb.rawFirst('/events'));
    await probe('staff', () => sb.rawFirst('/staff'));
    const firstMatter = (await sb.rawFirst('/matters').catch(() => null)) as { id?: string } | null;
    if (firstMatter?.id) {
      const id = firstMatter.id;
      await probe('memo', () => sb.rawFirst(`/matters/${id}/memos`));
      await probe('file', () => sb.rawFirst(`/matters/${id}/documents/files`));
      await probe('folders', () => sb.rawFirst(`/matters/${id}/documents/folders`));
    }
    // Custom fields (statute date, date of loss, index number) live in a
    // matter's layouts. Report the field KEYS in use across
    // a few open injury matters — names of fields, never what is in them.
    try {
      const { mirror } = await import('./db/mirror.js');
      const types = await mirror.typesInUse(ctx.db);
      const sample = (await mirror.matters(ctx.db))
        .filter((m) => m.status === 'Open' && /injur|malpractice/i.test(types.get(m.matterTypeId)?.category ?? ''))
        .slice(0, 8);
      const fields = new Map<string, { filled: number; of: number; looksLike: string }>();
      let read = 0;
      for (const m of sample) {
        const res = (await sb.rawGet(`/matters/${m.id}/layouts`).catch(() => null)) as { value?: unknown } | null;
        if (!res) continue;
        read++;
        for (const item of Array.isArray(res.value) ? (res.value as Record<string, unknown>[]) : []) {
          for (const v of Array.isArray(item['values']) ? (item['values'] as Record<string, unknown>[]) : []) {
            if (typeof v['key'] !== 'string') continue;
            const id = v['key'].slice(0, 80); // the field's key only — an item's own name could be a person's
            const f = fields.get(id) ?? { filled: 0, of: 0, looksLike: 'empty' };
            f.of++;
            if (v['value'] !== null && v['value'] !== undefined && v['value'] !== '') {
              f.filled++;
              f.looksLike = shapeOf(v['value']) as string;
            }
            fields.set(id, f);
          }
        }
      }
      out['layoutFields'] = { injuryMattersRead: read, fields: Object.fromEntries([...fields].slice(0, 300)) };
      await probe('layoutDesign', () => sb.rawFirst('/layouts'));
    } catch (e) {
      out['layoutFields'] = `unavailable: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
    }
    return { note: 'Field names and types only — no values. Paste this to map custom fields.', shapes: out };
  });

  // Connection check for the real Smokeball cutover: auth + a read from each
  // core resource, each reported independently. Shapes and counts only —
  // never credential values. Open /api/smokeball/verify in the browser.
  app.get('/api/smokeball/verify', async (_req, reply) => {
    const sb = ctx.smokeball;
    if (!sb) return reply.code(503).send({ error: 'no Smokeball client configured in this context' });
    const checks: Record<string, { ok: boolean; detail: string }> = {};
    const run = async (name: string, fn: () => Promise<string>) => {
      try {
        checks[name] = { ok: true, detail: await fn() };
      } catch (e) {
        checks[name] = { ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 300) };
      }
    };
    await run('staff', async () => `${(await sb.listStaff()).length} staff`);
    await run('matterTypes', async () => `${(await sb.listMatterTypes()).length} matter types`);
    await run('matters', async () => `${(await sb.listMatters()).length} matters`);
    await run('tasks', async () => `${(await sb.listTasks()).length} tasks`);
    await run('events', async () => `${(await sb.listEvents()).length} events`);
    // Webhooks: what the API calls its event types, and what's subscribed —
    // informational (a failure here doesn't count against allOk).
    const webhooks: Record<string, unknown> = {};
    try {
      webhooks['types'] = await sb.listWebhookTypes();
    } catch (e) {
      webhooks['types'] = `unavailable: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
    }
    try {
      webhooks['subscriptions'] = (await sb.listWebhooks()).value;
    } catch (e) {
      webhooks['subscriptions'] = `unavailable: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    return {
      storage:
        deps.dataPersistent === false
          ? 'IN MEMORY — persistent disk missing; settings/chat are lost on restart. Add a disk mounted at /var/data.'
          : 'persistent disk',
      writes: ctx.writesEnabled === false ? 'OFF — shadow mode (PAM_WRITES=off)' : 'on',
      lastSync: worker.lastSync ?? 'no sync attempted yet',
      lastWebhook: worker.lastWebhook ?? 'none received yet',
      mode: process.env['SMOKEBALL_BASE_URL'] ? 'REAL Smokeball' : 'mock (golden data)',
      baseUrl: process.env['SMOKEBALL_BASE_URL'] ?? '(mock)',
      auth:
        process.env['SMOKEBALL_AUTH_URL'] && process.env['SMOKEBALL_CLIENT_ID']
          ? `oauth (${process.env['SMOKEBALL_REFRESH_TOKEN']?.trim() ? 'refresh_token' : 'client_credentials'} grant)`
          : 'static token',
      apiKeyPresent: Boolean(process.env['SMOKEBALL_API_KEY']?.trim()),
      allOk,
      checks,
      webhooks,
      next: allOk
        ? 'Connection healthy. POST /api/sync (or wait a minute) to pull data.'
        : 'Fix the failing checks above — usually credentials or the auth/base URL pair.',
    };
  });

  // ------------------------------------------------------------------ chat
  // Server-side persistence: conversations survive reloads and resume the
  // most recent OPEN session under 24h; "new conversation" closes ALL open
  // sessions server-side (docs/05 lesson).

  const openSession = async (): Promise<{ id: string; history: LlmMessage[] } | null> => {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await ctx.db.select().from(schema.chatSessions).orderBy(desc(schema.chatSessions.updatedAt)).limit(5);
    const open = rows.find((r) => !r.closed && r.staffId === ctx.currentStaffId && r.updatedAt > dayAgo);
    if (!open) return null;
    const msgs = await ctx.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.sessionId, open.id)).orderBy(schema.chatMessages.id);
    const history = msgs.flatMap((m) => (m.llmJson as LlmMessage[] | null) ?? []);
    return { id: open.id, history };
  };

  app.get('/api/chat/history', async () => {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await ctx.db.select().from(schema.chatSessions).orderBy(desc(schema.chatSessions.updatedAt)).limit(5);
    const open = rows.find((r) => !r.closed && r.staffId === ctx.currentStaffId && r.updatedAt > dayAgo);
    if (!open) return { sessionId: null, messages: [] };
    const msgs = await ctx.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.sessionId, open.id)).orderBy(schema.chatMessages.id);
    return {
      sessionId: open.id,
      messages: msgs.map((m) => ({ role: m.role, text: m.displayText, citations: m.citations ?? [] })),
    };
  });

  app.post('/api/chat/new', async () => {
    await ctx.db.update(schema.chatSessions).set({ closed: true }).where(eq(schema.chatSessions.staffId, ctx.currentStaffId));
    // Quiet memory extraction runs in the background over what just closed.
    if (deps.llm) {
      const { extractMemoriesFromSession, pendingExtractions } = await import('./agent/extractor.js');
      const llm = deps.llm;
      void pendingExtractions(ctx.db, ctx.currentStaffId).then(async (ids) => {
        for (const id of ids) {
          const r = await extractMemoriesFromSession(ctx.db, llm, id);
          if (r.proposed > 0) console.log(`[pam] memory extractor: session ${id} → saved ${r.saved}, refused ${r.refused}`);
        }
      });
    }
    return { ok: true };
  });

  // ------------------------------------------------------------- memories
  app.get('/api/memories', async () => {
    const { listMemories } = await import('./tools/memory-tools.js');
    return { memories: await listMemories(ctx.db, 200) };
  });
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req, reply) => {
    const rows = await ctx.db.select().from(schema.memories).where(eq(schema.memories.id, req.params.id));
    if (rows.length === 0) return reply.code(404).send({ error: 'no such memory' });
    await ctx.db.delete(schema.memories).where(eq(schema.memories.id, req.params.id));
    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'memory:forget',
      params: { id: req.params.id, hook: rows[0]!.hook, via: 'settings' },
      result: 'deleted',
    });
    return { ok: true };
  });

  // ----------------------------------------------------------- seed (admin)
  // Proves the write path end to end on a real tenant: one task due today +
  // one 30-minute event tomorrow, both clearly labeled as safe to delete.
  app.post('/api/smokeball/seed', async (_req, reply) => {
    if (!ctx.smokeball) return reply.code(503).send({ error: 'no Smokeball client configured' });
    if (ctx.writesEnabled === false) {
      return reply.code(423).send({ error: 'Writes are switched off (PAM_WRITES=off) — shadow mode. Nothing was created.' });
    }
    const { appNow, FIRM_TZ } = await import('../core/dates.js');
    const now = appNow(ctx.fixedNowIso).setZone(FIRM_TZ);
    const stamp = now.toFormat('LLL d, h:mm a');
    const task = await ctx.smokeball.createTask(
      {
        subject: `PAM test task (${stamp}) — safe to delete`,
        assigneeIds: [ctx.currentStaffId],
        dueDate: now.toISODate()!,
        note: 'Created by PAM to prove the Smokeball write path. Delete freely.',
      },
      ctx.currentStaffId,
    );
    const start = now.plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const event = await ctx.smokeball.createEvent({
      subject: `PAM test event (${stamp}) — safe to delete`,
      startTime: start.toISO()!,
      endTime: start.plus({ minutes: 30 }).toISO()!,
      timeZone: FIRM_TZ,
      attendeeIds: [ctx.currentStaffId],
      allDay: false,
    });
    // Writes are async and a rejected one only ever surfaces via webhook —
    // so poll for each record by the Link id the 202 handed back.
    const landed = { task: false, event: false };
    for (let i = 0; i < 16 && !(landed.task && landed.event); i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!landed.task && task.id) landed.task = Boolean(await ctx.smokeball.getTask(task.id));
      if (!landed.event && event.id) landed.event = Boolean(await ctx.smokeball.getEvent(event.id));
    }
    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'write:seed',
      params: { task: task.id ?? task.requestId ?? null, event: event.id ?? event.requestId ?? null },
      result: `task ${landed.task ? 'landed' : 'NOT seen'}, event ${landed.event ? 'landed' : 'NOT seen'}`,
    });
    const both = landed.task && landed.event;
    return {
      ok: true,
      submitted: { task: task.id ?? task.requestId ?? null, event: event.id ?? event.requestId ?? null },
      landed,
      note: both
        ? 'Both landed in Smokeball — verified by reading them back. They show in PAM after the next sync (about a minute).'
        : `Smokeball accepted the request${landed.task || landed.event ? ', but only ' + (landed.task ? 'the task' : 'the event') + ' is visible so far' : ', but neither record is visible yet'} — Smokeball rejects invalid writes silently, so if this stays missing after a minute the payload shape needs adjusting (see the server log).`,
    };
  });

  let lastTurnTiming: unknown = null;
  let voiceModelDownUntil = 0;
  let lastPrewarm = 0;
  /** Warm the model's prompt cache when the orb room (or chat) opens, so the
   *  first question after a quiet spell is as fast as the tenth. At most
   *  once every 20 minutes; the cache itself lasts an hour. */
  app.post('/api/chat/prewarm', async () => {
    const target = deps.voiceLlm ?? deps.llm;
    if (!target?.prewarm) return { ok: false, reason: 'unavailable' };
    if (Date.now() - lastPrewarm < 20 * 60_000) return { ok: true, warm: 'already' };
    lastPrewarm = Date.now();
    const { toolDefinitions } = await import('./agent/loop.js');
    const { buildStableBlock } = await import('./agent/system-prompt.js');
    const { getIdentity, getKnowledge } = await import('./identity.js');
    const system = [{ text: buildStableBlock(await getIdentity(ctx.db), await getKnowledge(ctx.db)), cache: true }];
    const t0 = Date.now();
    const ok = await target.prewarm({ system, tools: toolDefinitions() });
    // The typed-chat model shares the room; warm it too, without waiting.
    if (deps.llm && deps.llm !== target) void deps.llm.prewarm?.({ system, tools: toolDefinitions() });
    if (!ok) lastPrewarm = 0;
    return { ok, ms: Date.now() - t0 };
  });
  app.get('/api/chat/timing', async () => ({ last: lastTurnTiming }));

  /** What PAM says when Jeff walks into the orb room — computed, instant,
   *  no model call: the hour's greeting and the shape of the day. */
  app.get('/api/greeting', async () => {
    const { buildGreeting } = await import('./greeting.js');
    return buildGreeting(ctx);
  });

  app.post('/api/chat/stream', async (req, reply) => {
    if (!deps.llm) {
      return reply.code(501).send({
        error: 'Chat isn’t configured yet — the server needs an ANTHROPIC_API_KEY.',
      });
    }
    const { message, voice, spoken, heard } = (req.body ?? {}) as { message?: string; voice?: boolean; spoken?: boolean; heard?: unknown };
    const alternatives = Array.isArray(heard) ? heard.filter((h): h is string => typeof h === 'string').slice(0, 3) : [];
    const turnOpts = { voice: voice === true, spoken: spoken === true, alternatives };
    if (!message?.trim()) return reply.code(400).send({ error: 'Empty message.' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell any proxy in front of us not to hold the stream back — a
      // buffered stream turns "first word in a second" into "all at once".
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();
    const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

    try {
      let session = await openSession();
      if (!session) {
        const id = randomUUID();
        await ctx.db.insert(schema.chatSessions).values({ id, staffId: ctx.currentStaffId });
        session = { id, history: [] };
      }

      // Bounded context window: full history stays in the DB; the model sees
      // the most recent slice (block-2 snapshot carries current state anyway).
      const window = session.history.slice(-60); // ~30 turns; drift checkpoint still fires at 28 msgs
      const { panelFor } = await import('./panels.js');
      const { mirror } = await import('./db/mirror.js');
      const initials = (await mirror.staff(ctx.db)).map((st) => st.initials).filter(Boolean);
      // One panel per subject per answer: the full task list already
      // contains the overdue ones, so a later overdue-only lookup adds nothing.
      const shown = new Set<string>();
      const showPanel = (name: string, params: unknown, data: unknown) => {
        const panel = panelFor(name, params, data, { initials });
        if (!panel) return;
        if (panel.kind === 'tasks' && panel.title === 'Overdue' && shown.has('tasks:Tasks')) return;
        shown.add(`${panel.kind}:${panel.title}`);
        send({ type: 'panel', panel });
      };
      // A briefing is answered from the snapshot (no lookup, so no panel of
      // its own) — put the day on the screen while she talks through it.
      if (voice === true && /\bbrief(ing)?\b|\bmy day\b|\bwhat(['’]?s| is) on (for )?today\b/i.test(message)) {
        for (const [name, params] of [
          ['get_calendar_events', { scope: 'today' }],
          ['get_tasks', { status: 'all_open' }],
        ] as const) {
          try {
            showPanel(name, params, (await runTool(ctx, name, params)).data);
          } catch {
            /* the briefing itself does not depend on this */
          }
        }
      }
      let spoke = false;
      const hooks = {
        onText: (delta: string) => {
          spoke = true;
          send({ type: 'text_delta', text: delta });
        },
        onNote: (delta: string) => {
          spoke = true;
          send({ type: 'note_delta', text: delta });
        },
        onTool: (name: string) => send({ type: 'tool', name }),
        onToolResult: (name: string, params: unknown, data: unknown) => {
          try {
            showPanel(name, params, data);
          } catch {
            /* a panel is a nicety — never fail the turn for one */
          }
        },
      };
      const useVoiceModel = voice === true && deps.voiceLlm !== undefined && Date.now() > voiceModelDownUntil;
      let turn;
      try {
        turn = await runAgentTurn(ctx, useVoiceModel ? deps.voiceLlm! : deps.llm, window, message, hooks, turnOpts);
      } catch (e) {
        // The fast voice model is unavailable to this key (or having a bad
        // minute): answer with the main model rather than not at all, and
        // stop trying the fast one for a while.
        if (!useVoiceModel || spoke) throw e;
        voiceModelDownUntil = Date.now() + 10 * 60_000;
        console.error(`[pam] voice model failed (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — answering with the main model for the next 10 minutes`);
        turn = await runAgentTurn(ctx, deps.llm, window, message, hooks, turnOpts);
      }
      const tm = turn.timing;
      console.log(
        `[pam] turn${voice ? ' (voice)' : ''}: total ${tm.totalMs}ms · prep ${tm.prepMs}ms · ` +
          tm.steps.map((st, i) => `step${i + 1} first ${st.ttftMs}ms/${st.ms}ms${st.cacheRead ? ' cached' : ''}${st.tools.length ? ` → ${st.tools.map((t) => `${t.name} ${t.ms}ms`).join(', ')}` : ''}`).join(' · '),
      );
      lastTurnTiming = tm;

      const newLlmMessages = turn.messages.slice(window.length);
      await ctx.db.insert(schema.chatMessages).values([
        { sessionId: session.id, role: 'user', displayText: message, llmJson: null, citations: null },
        {
          sessionId: session.id,
          role: 'assistant',
          displayText: turn.text,
          llmJson: newLlmMessages,
          citations: turn.citations,
        },
      ]);
      await ctx.db
        .update(schema.chatSessions)
        .set({ updatedAt: new Date() })
        .where(eq(schema.chatSessions.id, session.id));

      send({
        type: 'done',
        sessionId: session.id,
        text: turn.text,
        citations: turn.citations,
        citationsValid: turn.citationsValid,
        timing: turn.timing,
      });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
    reply.raw.end();
    return reply;
  });

  // ------------------------------------------------------------- static SPA
  // Serving is resolved per REQUEST, not per boot: a page URL can never get a
  // bare JSON 404. Missing bundle → a plain-words 503 explainer; unknown API
  // route → a 404 that names the path and method so screenshots self-diagnose.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  const haveIndex = () => existsSync(join(webDist, 'index.html'));
  const explainer =
    '<h1 style="font-family:Georgia,serif">PAM — server is up, but the web app bundle is missing</h1>' +
    '<p style="font-family:system-ui">The deploy needs its build step to run <code>pnpm build</code> ' +
    '(see render.yaml), or the build did not upload. This page is served by the API server itself, ' +
    'so the service and its data are fine — only the UI files are absent.</p>';
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist });
  } else {
    console.error(`[pam] WARNING: web UI not found at ${webDist} — run "pnpm build"`);
  }
  app.setNotFoundHandler((req, reply) => {
    const isPage = req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/webhooks/');
    if (isPage) {
      if (haveIndex()) return reply.sendFile('index.html');
      return reply.code(503).type('text/html').send(explainer);
    }
    return reply
      .code(404)
      .send({ error: 'not found', method: req.method, path: req.url.split('?')[0], hint: 'The web app lives at /' });
  });

  // ---------------------------------------------------------------- webhook
  // Deliveries are signed HMAC-SHA256(key, `${timestamp}|${requestId}|${clientId}`)
  // (docs/02). Verified whenever SMOKEBALL_WEBHOOK_KEY is set; the mock path
  // in tests runs unkeyed.
  app.post('/webhooks/smokeball', async (req, reply) => {
    const key = deps.webhookKey ?? process.env['SMOKEBALL_WEBHOOK_KEY']?.trim();
    if (key) {
      const { createHmac, timingSafeEqual } = await import('node:crypto');
      const h = req.headers;
      const sig = String(h['signature'] ?? '');
      const expected = createHmac('sha256', key)
        .update(`${String(h['timestamp'] ?? '')}|${String(h['requestid'] ?? '')}|${process.env['SMOKEBALL_CLIENT_ID']?.trim() ?? ''}`)
        .digest('hex');
      const ok = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) {
        console.error(`[pam] webhook signature rejected (type=${String((req.body as { type?: unknown })?.type ?? '?')})`);
        return reply.code(401).send({ error: 'bad signature' });
      }
    }
    // Defensive parse — field names vary between the mock and live deliveries.
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = String(b['type'] ?? b['eventType'] ?? '');
    const payload = b['payload'] ?? b['data'] ?? b;
    if (type === 'error') console.error('[pam] smokeball rejected a write:', JSON.stringify(payload).slice(0, 400));
    else if (type) await worker.handleWebhook(type, payload);
    return {};
  });

  return app;
}
