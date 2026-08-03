import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { desc } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './db/index.js';
import type { SyncWorker } from './sync/worker.js';
import { getTodayData } from './api/today.js';
import { runAgentTurn, type LlmClient, type LlmMessage } from './agent/loop.js';
import { runTool, type ToolContext } from './tools/read-tools.js';

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
    const buckets = allTasks.data as {
      overdue: { dueDate?: string | null }[];
      dueToday: { dueDate?: string | null }[];
      upcoming: { dueDate?: string | null }[];
    };
    const tasksDue = isToday
      ? buckets.dueToday
      : [...buckets.upcoming, ...buckets.overdue].filter((t) => t.dueDate === iso);

    return {
      dateIso: iso,
      isToday,
      todayIso: now.setZone(FIRM_TZ).toISODate(),
      label: target.toFormat(isToday ? "'Today —' cccc, LLLL d" : 'cccc, LLLL d'),
      events: (events.data as { events: unknown[] }).events,
      tasksDue,
      asOf: events.asOf,
    };
  });

  /** Full task buckets — powers the Tasks page. */
  app.get('/api/tasks', async () => {
    const [all, overdue] = [
      await runTool(ctx, 'get_tasks', { status: 'all_open' }),
      await runTool(ctx, 'get_tasks', { status: 'overdue' }),
    ];
    const allData = all.data as { dueToday: unknown[]; upcoming: unknown[] };
    const od = overdue.data as { needsDecision: unknown[]; statuteReminders: unknown };
    return {
      dueToday: allData.dueToday,
      upcoming: allData.upcoming,
      needsDecision: od.needsDecision,
      statuteReminders: od.statuteReminders,
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

  // ------------------------------------------------------------------ chat
  const sessions = new Map<string, LlmMessage[]>();

  app.post('/api/chat/stream', async (req, reply) => {
    if (!deps.llm) {
      return reply.code(501).send({
        error: 'Chat isn’t configured yet — the server needs an ANTHROPIC_API_KEY.',
      });
    }
    const { sessionId, message } = (req.body ?? {}) as { sessionId?: string; message?: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'Empty message.' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (payload: unknown) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);

    const sid = sessionId && sessions.has(sessionId) ? sessionId : randomUUID();
    const history = sessions.get(sid) ?? [];

    try {
      const turn = await runAgentTurn(ctx, deps.llm, history, message, {
        onText: (delta) => send({ type: 'text_delta', text: delta }),
        onTool: (name) => send({ type: 'tool', name }),
      });
      sessions.set(sid, turn.messages);
      send({
        type: 'done',
        sessionId: sid,
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
