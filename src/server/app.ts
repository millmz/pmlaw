import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
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
  /** When set, /api/* requires a session cookie obtained via /api/login. */
  accessCode?: string | undefined;
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
  void app.register(fastifyCookie);

  const authed = (req: FastifyRequest): boolean => {
    if (!accessCode) return true;
    const cookie = req.cookies[SESSION_COOKIE];
    return typeof cookie === 'string' && safeEqual(cookie, sessionToken(accessCode));
  };

  app.addHook('onRequest', async (req, reply) => {
    const open =
      req.url === '/healthz' ||
      req.url.startsWith('/webhooks/') ||
      req.url === '/api/login' ||
      req.url === '/api/me' ||
      !req.url.startsWith('/api/');
    if (open) return;
    if (!authed(req)) return reply.code(401).send({ error: 'authentication required' });
  });

  app.get('/healthz', async () => ({ ok: true }));

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

  app.get('/api/me', async (req) => ({
    authed: authed(req),
    gated: Boolean(accessCode),
    chatEnabled: Boolean(deps.llm),
    user: { name: 'Jeff Millman', initials: 'JTM', staffId: ctx.currentStaffId },
  }));

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
    const allTasks = await runTool(ctx, 'get_tasks', { status: 'all_open' });
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
    };
  });

  /** Full task buckets — powers the Tasks page. Statute reminders are pulled
   *  out of EVERY bucket (not just overdue): they are never movable, so they
   *  never belong next to a "Move to…" button. */
  app.get('/api/tasks', async () => {
    const { isStatuteReminder } = await import('../core/dates.js');
    const [all, overdue] = [
      await runTool(ctx, 'get_tasks', { status: 'all_open' }),
      await runTool(ctx, 'get_tasks', { status: 'overdue' }),
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
      ...(q.clientName ? { clientName: q.clientName } : {}),
      ...(q.practiceArea ? { practiceArea: q.practiceArea } : {}),
      ...(q.status ? { status: q.status as 'Open' | 'Closed' | 'any' } : {}),
    });
    return result.data;
  });

  app.get<{ Params: { id: string } }>('/api/matters/:id', async (req) => {
    const result = await runTool(ctx, 'get_matter_overview', { matterId: req.params.id });
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
  app.post('/api/tts', async (req, reply) => {
    const apiKey = (process.env['ELEVENLABS_API_KEY'] ?? '').trim();
    if (!apiKey) return reply.code(501).send({ error: 'no_tts_key' });
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text?.trim()) return reply.code(400).send({ error: 'empty text' });
    const { eq } = await import('drizzle-orm');
    const voiceRow = await ctx.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'elevenlabs_voice_id'))
      .limit(1);
    const voiceId = voiceRow[0]?.value || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" default
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2500), model_id: 'eleven_turbo_v2_5' }),
    });
    if (!res.ok) {
      const detail = res.status === 401 ? 'bad_key' : res.status === 429 ? 'out_of_credits' : `elevenlabs_${res.status}`;
      return reply.code(502).send({ error: detail });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return reply.type('audio/mpeg').send(buf);
  });

  app.get('/api/settlements', async () => {
    const result = await runTool(ctx, 'get_settlement_board', {});
    return result.data;
  });

  app.get('/api/audit', async () => {
    const rows = await ctx.db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(100);
    return { entries: rows };
  });

  app.post('/api/sync', async () => {
    const counts = await worker.incrementalSync();
    return { ok: true, counts };
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
    const allOk = Object.values(checks).every((c) => c.ok);
    return {
      lastSync: worker.lastSync ?? 'no sync attempted yet',
      mode: process.env['SMOKEBALL_BASE_URL'] ? 'REAL Smokeball' : 'mock (golden data)',
      baseUrl: process.env['SMOKEBALL_BASE_URL'] ?? '(mock)',
      auth:
        process.env['SMOKEBALL_AUTH_URL'] && process.env['SMOKEBALL_CLIENT_ID']
          ? `oauth (${process.env['SMOKEBALL_REFRESH_TOKEN']?.trim() ? 'refresh_token' : 'client_credentials'} grant)`
          : 'static token',
      apiKeyPresent: Boolean(process.env['SMOKEBALL_API_KEY']?.trim()),
      allOk,
      checks,
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
    return { ok: true };
  });

  app.post('/api/chat/stream', async (req, reply) => {
    if (!deps.llm) {
      return reply.code(501).send({
        error: 'Chat isn’t configured yet — the server needs an ANTHROPIC_API_KEY.',
      });
    }
    const { message } = (req.body ?? {}) as { message?: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'Empty message.' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
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
      const window = session.history.slice(-40);
      const turn = await runAgentTurn(ctx, deps.llm, window, message, {
        onText: (delta) => send({ type: 'text_delta', text: delta }),
        onTool: (name) => send({ type: 'tool', name }),
      });

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
      });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
    reply.raw.end();
    return reply;
  });

  // ------------------------------------------------------------- static SPA
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(webDist)) {
    void app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA fallback: any non-API GET serves index.html so client routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    // The UI bundle wasn't built. Say so plainly instead of a mystery 404.
    console.error(`[pam] WARNING: web UI not found at ${webDist} — run "pnpm build"`);
    app.get('/', async (_req, reply) =>
      reply.code(503).type('text/html').send(
        '<h1 style="font-family:Georgia,serif">PAM — server is up, but the web app was not built</h1>' +
          '<p style="font-family:system-ui">The deploy needs its build step to run <code>pnpm build</code>. ' +
          'Check that the build command includes it (see render.yaml).</p>',
      ),
    );
  }

  // ---------------------------------------------------------------- webhook
  app.post('/webhooks/smokeball', async (req) => {
    const { type, payload } = req.body as { type: string; payload: unknown };
    await worker.applyWebhook(type, payload);
    return {};
  });

  return app;
}
