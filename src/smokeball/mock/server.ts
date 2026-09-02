import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { FirmDataset, Task, CalendarEvent } from '../../core/types.js';

/**
 * Mock Smokeball API server, faithful to the behaviors that matter for PAM
 * (vendor/smokeball-openapi.json + docs/02):
 *
 *  - x-api-key + Bearer token required on every request
 *  - paging via limit/offset (max 500)
 *  - UpdatedSince filters
 *  - ASYNC writes: POST/PUT return 202 with a RequestId; the mutation applies
 *    ~25ms later and a webhook fires. Invalid writes emit an `error` webhook.
 *  - webhook subscriptions with HMAC-SHA256 `Signature` (Timestamp|RequestId|ClientId)
 *  - optional 5 req/s rate limiting (429), enabled via {rateLimit: true}
 *  - file download returns content from a presigned-style URL
 *  - POST /search/files over file name + content
 *
 * The dataset is mutable in-memory state so sync-convergence tests can mutate
 * and assert the cache follows.
 */

export interface MockOptions {
  apiKey?: string;
  bearer?: string;
  rateLimit?: boolean;
  /** Webhook signing key handed to subscribers. */
  webhookKey?: string;
}

export interface MockSmokeball {
  app: FastifyInstance;
  data: FirmDataset;
  /** Mutate a record server-side (simulating a change made in Smokeball's UI). */
  touch: (kind: 'task' | 'event' | 'matter', id: string, patch: Record<string, unknown>) => Promise<void>;
  listen: (port?: number) => Promise<string>;
  close: () => Promise<void>;
}

const nowIso = () => DateTime.utc().toISO()!;

export function createMockSmokeball(data: FirmDataset, opts: MockOptions = {}): MockSmokeball {
  const apiKey = opts.apiKey ?? 'mock-api-key';
  const bearer = opts.bearer ?? 'mock-token';
  const webhookKey = opts.webhookKey ?? 'mock-webhook-key';
  const clientId = 'mock-client-id';

  const app = Fastify({ logger: false });

  // ------------------------------------------------------------ auth + rate
  const stamps: number[] = [];
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/download/')) return; // presigned URLs skip auth
    if (req.headers['x-api-key'] !== apiKey) return reply.code(403).send({ message: 'invalid api key' });
    if (req.headers.authorization !== `Bearer ${bearer}`) return reply.code(401).send({ message: 'unauthorized' });
    if (opts.rateLimit) {
      const t = Date.now();
      while (stamps.length > 0 && t - stamps[0]! > 1000) stamps.shift();
      if (stamps.length >= 5) return reply.code(429).send({ message: 'rate limit exceeded' });
      stamps.push(t);
    }
  });

  // ---------------------------------------------------------------- helpers
  const page = <T>(items: T[], q: Record<string, unknown>) => {
    const limit = Math.min(Number(q['limit'] ?? 500), 500);
    const offset = Number(q['offset'] ?? 0);
    return { value: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };

  const updatedSince = <T extends { updatedAt: string }>(items: T[], q: Record<string, unknown>) => {
    // Real API: LastUpdated (ISO) is current; UpdatedSince is legacy (and on
    // /matters//tasks actually wants ticks). Accept both here.
    const since = q['LastUpdated'] ?? q['lastUpdated'] ?? q['UpdatedSince'] ?? q['updatedSince'];
    if (typeof since !== 'string' || since === '') return items;
    const cut = DateTime.fromISO(since, { zone: 'utc' }); // zone-less strings (events form) are UTC
    return items.filter((i) => DateTime.fromISO(i.updatedAt) >= cut);
  };

  // ---------------------------------------------------------------- webhooks
  interface Subscription {
    id: string;
    eventTypes: string[];
    callbackUrl: string;
    key: string;
  }
  const subscriptions = new Map<string, Subscription>();

  async function emitWebhook(type: string, payload: unknown, requestId: string) {
    for (const sub of subscriptions.values()) {
      if (!sub.eventTypes.includes(type) && !sub.eventTypes.includes('*')) continue;
      const timestamp = nowIso();
      const signature = createHmac('sha256', sub.key)
        .update(`${timestamp}|${requestId}|${clientId}`)
        .digest('hex');
      try {
        await fetch(sub.callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', signature, timestamp, requestid: requestId },
          body: JSON.stringify({ accountId: 'mock-account', type, source: 'API', payload, timestamp }),
        });
      } catch {
        // Subscribers may be down; Smokeball drops silently too.
      }
    }
  }

  app.get('/webhooks', async () => ({ value: [...subscriptions.values()] }));
  app.post('/webhooks', async (req, reply) => {
    const body = req.body as { eventTypes: string[]; callbackUrl: string };
    const id = randomUUID();
    subscriptions.set(id, { id, key: webhookKey, ...body });
    return reply.code(201).send({ id, key: webhookKey });
  });
  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req) => {
    subscriptions.delete(req.params.id);
    return {};
  });

  // ------------------------------------------------------------------ reads
  app.get('/staff', async (req) => page(data.staff, req.query as Record<string, unknown>));
  app.get('/mattertypes', async (req) => page(data.matterTypes, req.query as Record<string, unknown>));

  app.get('/matters', async (req) => {
    const q = req.query as Record<string, unknown>;
    let items = data.matters;
    if (typeof q['Status'] === 'string') items = items.filter((m) => m.status === q['Status']);
    if (typeof q['MatterTypeId'] === 'string') items = items.filter((m) => m.matterTypeId === q['MatterTypeId']);
    if (typeof q['Search'] === 'string') {
      const s = (q['Search'] as string).toLowerCase();
      items = items.filter(
        (m) =>
          m.clientFirstName.toLowerCase().includes(s) ||
          m.clientLastName.toLowerCase().includes(s) ||
          m.number.includes(s),
      );
    }
    items = updatedSince(items, q);
    return page(items, q);
  });
  app.get<{ Params: { id: string } }>('/matters/:id', async (req, reply) => {
    const m = data.matters.find((m) => m.id === req.params.id);
    return m ?? reply.code(404).send({ message: 'not found' });
  });

  app.get('/tasks', async (req) => {
    const q = req.query as Record<string, unknown>;
    let items = data.tasks;
    if (typeof q['MatterId'] === 'string') items = items.filter((t) => t.matterId === q['MatterId']);
    if (q['IsCompleted'] !== undefined) {
      const want = q['IsCompleted'] === 'true';
      items = items.filter((t) => t.isCompleted === want);
    }
    items = updatedSince(items, q);
    return page(items, q);
  });

  app.get('/events', async (req) => {
    const q = req.query as Record<string, unknown>;
    let items = data.events;
    if (typeof q['From'] === 'string') {
      const from = DateTime.fromISO(q['From'] as string);
      items = items.filter((e) => DateTime.fromISO(e.startTime) >= from);
    }
    if (typeof q['To'] === 'string') {
      const to = DateTime.fromISO(q['To'] as string);
      items = items.filter((e) => DateTime.fromISO(e.startTime) <= to);
    }
    if (typeof q['MatterId'] === 'string') items = items.filter((e) => e.matterId === q['MatterId']);
    items = updatedSince(items, q);
    return page(items, q);
  });

  app.get<{ Params: { matterId: string } }>('/matters/:matterId/folders', async (req) =>
    page(data.folders.filter((f) => f.matterId === req.params.matterId), req.query as Record<string, unknown>),
  );
  app.get<{ Params: { matterId: string } }>('/matters/:matterId/files', async (req) => {
    const q = req.query as Record<string, unknown>;
    let items = data.files.filter((f) => f.matterId === req.params.matterId);
    if (typeof q['FolderId'] === 'string') items = items.filter((f) => f.folderId === q['FolderId']);
    return page(
      items.map(({ content: _content, ...rest }) => rest),
      q,
    );
  });
  app.get<{ Params: { matterId: string; fileId: string } }>(
    '/matters/:matterId/files/:fileId/download',
    async (req, reply) => {
      const f = data.files.find((f) => f.id === req.params.fileId && f.matterId === req.params.matterId);
      if (!f) return reply.code(404).send({ message: 'not found' });
      // Real API returns a time-limited presigned URL; we mimic the indirection.
      return { downloadUrl: `/download/${f.id}` };
    },
  );
  app.get<{ Params: { fileId: string } }>('/download/:fileId', async (req, reply) => {
    const f = data.files.find((f) => f.id === req.params.fileId);
    if (!f) return reply.code(404).send({ message: 'not found' });
    return reply.type('application/octet-stream').send(f.content ?? '');
  });

  app.get<{ Params: { matterId: string } }>('/matters/:matterId/memos', async (req) =>
    page(data.memos.filter((m) => m.matterId === req.params.matterId), req.query as Record<string, unknown>),
  );

  app.post('/search/files', async (req) => {
    const body = req.body as { query: string; matterIds?: string[] };
    const q = body.query.toLowerCase();
    let items = data.files.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.content ?? '').toLowerCase().includes(q),
    );
    if (body.matterIds) items = items.filter((f) => body.matterIds!.includes(f.matterId));
    return { value: items.map(({ content: _content, ...rest }) => rest) };
  });

  // ------------------------------------------------- async writes + webhooks
  /** Apply a mutation after a short delay, then emit its webhook — Smokeball's
   *  eventually-consistent write behavior (docs/02 "Write semantics"). */
  function asyncWrite(fn: () => { type: string; payload: unknown } | { error: string }, requestId: string) {
    setTimeout(async () => {
      const result = fn();
      if ('error' in result) {
        await emitWebhook('error', { requestId, message: result.error }, requestId);
      } else {
        await emitWebhook(result.type, result.payload, requestId);
      }
    }, 25);
  }

  app.post('/tasks', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const body = req.body as Partial<Task>;
    asyncWrite(() => {
      if (!body.subject || !body.assigneeIds?.length) return { error: 'subject and assigneeIds required' };
      const task: Task = {
        id: `task-${randomUUID().slice(0, 8)}`,
        subject: body.subject,
        assigneeIds: body.assigneeIds,
        isCompleted: false,
        createdById: body.createdById ?? 'api',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...(body.matterId !== undefined ? { matterId: body.matterId } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      };
      data.tasks.push(task);
      return { type: 'task.created', payload: task };
    }, requestId);
    return reply.code(202).send({ requestId });
  });

  app.put<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const patch = req.body as Partial<Task>;
    const id = req.params.id;
    asyncWrite(() => {
      const t = data.tasks.find((t) => t.id === id);
      if (!t) return { error: `task ${id} not found` };
      Object.assign(t, patch, { updatedAt: nowIso() });
      return { type: 'task.updated', payload: t };
    }, requestId);
    return reply.code(202).send({ requestId });
  });

  app.post('/events', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const body = req.body as Partial<CalendarEvent>;
    asyncWrite(() => {
      if (!body.subject || !body.startTime || !body.endTime || !body.attendeeIds?.length) {
        return { error: 'subject, startTime, endTime, attendeeIds required' };
      }
      const event: CalendarEvent = {
        id: `event-${randomUUID().slice(0, 8)}`,
        subject: body.subject,
        startTime: body.startTime,
        endTime: body.endTime,
        timeZone: body.timeZone ?? 'America/New_York',
        allDay: body.allDay ?? false,
        attendeeIds: body.attendeeIds,
        onOfficeCalendar: body.onOfficeCalendar ?? false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...(body.matterId !== undefined ? { matterId: body.matterId } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
      };
      data.events.push(event);
      return { type: 'event.created', payload: event };
    }, requestId);
    return reply.code(202).send({ requestId });
  });

  // ------------------------------------------------------------------ admin
  async function touch(kind: 'task' | 'event' | 'matter', id: string, patch: Record<string, unknown>) {
    const coll = kind === 'task' ? data.tasks : kind === 'event' ? data.events : data.matters;
    const rec = (coll as { id: string; updatedAt: string }[]).find((r) => r.id === id);
    if (!rec) throw new Error(`${kind} ${id} not found`);
    Object.assign(rec, patch, { updatedAt: nowIso() });
    await emitWebhook(`${kind}.updated`, rec, randomUUID());
  }

  let baseUrl = '';
  return {
    app,
    data,
    touch,
    listen: async (port = 0) => {
      baseUrl = await app.listen({ port, host: '127.0.0.1' });
      return baseUrl;
    },
    close: () => app.close(),
  };
}
