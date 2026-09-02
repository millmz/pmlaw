import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { FirmDataset, Task, CalendarEvent } from '../../core/types.js';
import {
  contactIdFor,
  contactToDto,
  eventToDto,
  fileToDto,
  foldersToDto,
  matterToDto,
  matterTypeToDto,
  memoToDto,
  staffToDto,
  taskToDto,
} from './dto.js';

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
  app.get('/webhooks/types', async () => ({
    value: ['task.created', 'task.updated', 'event.created', 'event.updated', 'matter.updated', 'memo.updated', 'error'].map((t) => ({ id: t, href: `/webhooks/types/${t}` })),
  }));
  app.post('/webhooks', async (req, reply) => {
    // Real body: { name, key, eventTypes, eventNotificationUrl } — the KEY is
    // chosen by the subscriber and signs every notification. Legacy
    // { callbackUrl } still accepted for older tests.
    const body = req.body as { name?: string; key?: string; eventTypes: string[]; eventNotificationUrl?: string; callbackUrl?: string };
    const id = randomUUID();
    const key = body.key ?? webhookKey;
    subscriptions.set(id, { id, key, eventTypes: body.eventTypes, callbackUrl: body.eventNotificationUrl ?? body.callbackUrl ?? '' });
    return reply.code(201).send({ id, key });
  });
  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req) => {
    subscriptions.delete(req.params.id);
    return {};
  });

  // ------------------------------------------------------------------ reads
  // Every read answers in the REAL wire shape (mock/dto.ts) so the adapter
  // layer is exercised by the whole suite, not just by staging.
  app.get('/staff', async (req) => page(data.staff.map(staffToDto), req.query as Record<string, unknown>));
  app.get('/mattertypes', async (req) =>
    page(data.matterTypes.map(matterTypeToDto), req.query as Record<string, unknown>),
  );
  app.get<{ Params: { id: string } }>('/contacts/:id', async (req, reply) => {
    const m = data.matters.find((m) => contactIdFor(m.id) === req.params.id);
    return m ? contactToDto(m) : reply.code(404).send({ message: 'not found' });
  });

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
    return page(items.map(matterToDto), q);
  });
  app.get<{ Params: { id: string } }>('/matters/:id', async (req, reply) => {
    const m = data.matters.find((m) => m.id === req.params.id);
    return m ? matterToDto(m) : reply.code(404).send({ message: 'not found' });
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
    return page(items.map(taskToDto), q);
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
    return page(items.map(eventToDto), q);
  });

  // Real document paths live under /matters/{id}/documents/…
  app.get<{ Params: { matterId: string } }>('/matters/:matterId/documents/folders', async (req) =>
    page(
      foldersToDto(
        data.folders.filter((f) => f.matterId === req.params.matterId),
        data.files.filter((f) => f.matterId === req.params.matterId),
      ),
      req.query as Record<string, unknown>,
    ),
  );
  app.get<{ Params: { matterId: string } }>('/matters/:matterId/documents/files', async (req) => {
    const q = req.query as Record<string, unknown>;
    let items = data.files.filter((f) => f.matterId === req.params.matterId);
    if (typeof q['FolderId'] === 'string') items = items.filter((f) => f.folderId === q['FolderId']);
    return page(items.map(fileToDto), q);
  });
  app.get<{ Params: { matterId: string; fileId: string } }>(
    '/matters/:matterId/documents/files/:fileId/download',
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
    page(
      data.memos.filter((m) => m.matterId === req.params.matterId).map(memoToDto),
      req.query as Record<string, unknown>,
    ),
  );

  app.post('/search/files', async (req) => {
    const body = req.body as { query: string; matterIds?: string[] };
    const q = body.query.toLowerCase();
    let items = data.files.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.content ?? '').toLowerCase().includes(q),
    );
    if (body.matterIds) items = items.filter((f) => body.matterIds!.includes(f.matterId));
    return { value: items.map(fileToDto) };
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

  // Writes arrive in the REAL DTO shape (TaskDto / EventDto) and are decoded
  // to core here — the same decoding the real API performs server-side.
  type TaskWire = Partial<Task> & { staffId?: string; dueDateOnly?: string | null };
  const decodeTaskDue = (b: TaskWire): string | undefined =>
    typeof b.dueDateOnly === 'string' ? b.dueDateOnly.slice(0, 10) : b.dueDate;

  /** Real 202s answer with a hypermedia Link to the record being created. */
  const accepted = (requestId: string, id: string, href: string) => ({ requestId, id, href, relation: 'self', method: 'GET' });

  app.post('/tasks', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const body = req.body as TaskWire;
    const newId = `task-${randomUUID().slice(0, 8)}`;
    asyncWrite(() => {
      if (!body.subject || !body.assigneeIds?.length) return { error: 'subject and assigneeIds required' };
      if (!body.staffId && !body.createdById) return { error: 'staffId required' };
      const due = decodeTaskDue(body);
      const task: Task = {
        id: newId,
        subject: body.subject,
        assigneeIds: body.assigneeIds,
        isCompleted: false,
        createdById: body.staffId ?? body.createdById ?? 'api',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...(body.matterId !== undefined && body.matterId !== null ? { matterId: body.matterId } : {}),
        ...(due !== undefined ? { dueDate: due } : {}),
        ...(body.note !== undefined && body.note !== null ? { note: body.note } : {}),
      };
      data.tasks.push(task);
      return { type: 'task.created', payload: task };
    }, requestId);
    return reply.code(202).send(accepted(requestId, newId, `/tasks/${newId}`));
  });

  app.put<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const body = req.body as TaskWire;
    const id = req.params.id;
    asyncWrite(() => {
      const t = data.tasks.find((t) => t.id === id);
      if (!t) return { error: `task ${id} not found` };
      const { staffId: _s, dueDateOnly: _d, ...rest } = body;
      const due = decodeTaskDue(body);
      Object.assign(t, rest, due !== undefined ? { dueDate: due } : {}, { updatedAt: nowIso() });
      return { type: 'task.updated', payload: t };
    }, requestId);
    return reply.code(202).send(accepted(requestId, id, `/tasks/${id}`));
  });

  app.get<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
    const e = data.events.find((e) => e.id === req.params.id);
    return e ? eventToDto(e) : reply.code(404).send({ message: 'not found' });
  });

  type EventWire = Partial<CalendarEvent> & { attendees?: string[] };
  app.post('/events', async (req, reply) => {
    const requestId = (req.headers['requestid'] as string | undefined) ?? randomUUID();
    const body = req.body as EventWire;
    const newId = `event-${randomUUID().slice(0, 8)}`;
    asyncWrite(() => {
      const attendeeIds = body.attendees ?? body.attendeeIds ?? [];
      if (!body.subject || !body.startTime || !body.endTime || attendeeIds.length === 0) {
        return { error: 'subject, startTime, endTime, attendees required' };
      }
      const tz = body.timeZone ?? 'America/New_York';
      // Zone-less local times (the wire form) become absolute in tz; absolute ISO passes through.
      const abs = (s: string) => DateTime.fromISO(s, { zone: tz }).toISO()!;
      const event: CalendarEvent = {
        id: newId,
        subject: body.subject,
        startTime: abs(body.startTime),
        endTime: abs(body.endTime),
        timeZone: tz,
        allDay: body.allDay ?? false,
        attendeeIds,
        onOfficeCalendar: body.onOfficeCalendar ?? false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...(body.matterId !== undefined && body.matterId !== null ? { matterId: body.matterId } : {}),
        ...(body.location !== undefined && body.location !== null ? { location: body.location } : {}),
      };
      data.events.push(event);
      return { type: 'event.created', payload: event };
    }, requestId);
    return reply.code(202).send(accepted(requestId, newId, `/events/${newId}`));
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
