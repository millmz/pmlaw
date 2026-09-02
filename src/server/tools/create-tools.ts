import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { appNow, FIRM_TZ } from '../../core/dates.js';
import { schema } from '../db/index.js';
import { cite } from './citations.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';

/**
 * Creating tasks and calendar events by conversation — the second and third
 * write verbs, on the same framework as rescheduling (docs/03):
 * propose → the user confirms in this conversation → execute with a
 * single-use, payload-bound token → VERIFY against the live API → audit.
 * Nothing court-filed, client-facing, or money-moving; these are diary
 * entries, the kind Jeff dictates to himself all day.
 */

const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Resolve an optional matter reference by client name / number / id. */
async function resolveMatter(
  ctx: ToolContext,
  query: string | undefined,
): Promise<{ matter?: { id: string; label: string }; ambiguous?: ToolResult; notFound?: ToolResult }> {
  if (!query) return {};
  const asOf = new Date().toISOString();
  const all = (await ctx.db.select().from(schema.matters)).filter((m) => m.status === 'Open');
  const q = query.toLowerCase();
  let hits = all.filter((m) => m.id === query || m.number === query);
  if (hits.length === 0) {
    hits = all.filter((m) => `${m.clientFirstName} ${m.clientLastName} ${m.number}`.toLowerCase().includes(q));
  }
  const label = (m: (typeof all)[number]) => `Matter ${m.number} · ${m.clientFirstName} ${m.clientLastName}`.trim();
  if (hits.length === 0) {
    return {
      notFound: {
        data: { error: `No open matter matches "${query}". Ask the user to clarify, or create the entry without a matter.` },
        citations: [],
        asOf,
      },
    };
  }
  if (hits.length > 1) {
    return {
      ambiguous: {
        data: {
          ambiguous: true,
          note: 'Several matters match — ask the user which one.',
          candidates: hits.slice(0, 6).map((m) => ({ id: m.id, label: label(m) })),
        },
        citations: hits.slice(0, 6).map((m) => cite('matter', m.id, label(m))),
        asOf,
      },
    };
  }
  return { matter: { id: hits[0]!.id, label: label(hits[0]!) } };
}

/** Parse a date-time the model supplies; zone-less input is firm-local. */
function parseWhen(s: string): DateTime {
  return DateTime.fromISO(s, { zone: FIRM_TZ, setZone: true });
}

// ------------------------------------------------------------- task create

const proposeTaskSchema = z.object({
  subject: z.string().min(2).max(200).describe('Task title, in the firm\'s diary style, e.g. "Call adjuster Boland re Grasso offer".'),
  dueDate: z.string().optional().describe('Due date, ISO YYYY-MM-DD. Omit for no due date.'),
  matterQuery: z.string().optional().describe('Client name, matter number, or matter id to attach the task to. Omit for a general task.'),
  note: z.string().max(1000).optional().describe('Optional note body.'),
});

const proposeTaskCreate: ToolDef = {
  name: 'propose_task_create',
  description:
    'Step 1 of creating a task for the user. Validates the date, resolves the matter (asks if several match), and returns a confirmation card + token. Present the card in one or two spoken sentences and call execute_task_create ONLY after the user explicitly confirms in this conversation.',
  paramsSchema: proposeTaskSchema,
  run: async (ctx, raw) => {
    const p = proposeTaskSchema.parse(raw);
    const asOf = new Date().toISOString();
    if (p.dueDate) {
      const d = DateTime.fromISO(p.dueDate, { zone: FIRM_TZ });
      if (!d.isValid) return { data: { error: `"${p.dueDate}" is not a valid date — use YYYY-MM-DD.` }, citations: [], asOf };
    }
    const r = await resolveMatter(ctx, p.matterQuery);
    if (r.ambiguous) return r.ambiguous;
    if (r.notFound) return r.notFound;

    const token = randomUUID();
    ctx.confirmations ??= new Map();
    ctx.confirmations.set(token, {
      action: 'task_create',
      subject: p.subject,
      dueDate: p.dueDate,
      matterId: r.matter?.id,
      matterLabel: r.matter?.label,
      note: p.note,
      assigneeIds: [ctx.currentStaffId],
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    const today = appNow(ctx.fixedNowIso).setZone(FIRM_TZ).toISODate()!;
    return {
      data: {
        confirmationRequired: true,
        confirmationToken: token,
        card: {
          action: 'Create task',
          task: p.subject,
          due: p.dueDate ?? 'no due date',
          matter: r.matter?.label ?? 'no matter (general task)',
          assignedTo: 'you',
          ...(p.dueDate && p.dueDate < today ? { warning: 'That due date is already in the past.' } : {}),
          note: 'Nothing is created in Smokeball until the user confirms.',
        },
      },
      citations: r.matter ? [cite('matter', r.matter.id, r.matter.label)] : [],
      asOf,
    };
  },
};

const executeTaskCreate: ToolDef = {
  name: 'execute_task_create',
  description:
    'Step 2 of creating a task — call ONLY after the user explicitly confirmed the proposed card in this conversation. Creates it in Smokeball, verifies it landed (writes are asynchronous), and reports the verified result.',
  paramsSchema: z.object({ confirmationToken: z.string() }),
  run: async (ctx, raw) => {
    const { confirmationToken } = z.object({ confirmationToken: z.string() }).parse(raw);
    const asOf = new Date().toISOString();
    const pending = ctx.confirmations?.get(confirmationToken);
    if (!pending || pending.expiresAt < Date.now() || pending.action !== 'task_create') {
      ctx.confirmations?.delete(confirmationToken);
      return { data: { error: 'That confirmation has expired or was already used — propose the task again.' }, citations: [], asOf };
    }
    ctx.confirmations!.delete(confirmationToken);
    if (!ctx.smokeball) throw new Error('writes unavailable: no Smokeball connection');

    const createdAfter = Date.now() - 5_000;
    await ctx.smokeball.createTask(
      {
        subject: pending.subject,
        assigneeIds: pending.assigneeIds,
        ...(pending.dueDate ? { dueDate: pending.dueDate } : {}),
        ...(pending.matterId ? { matterId: pending.matterId } : {}),
        ...(pending.note ? { note: pending.note } : {}),
      },
      ctx.currentStaffId,
    );

    // VERIFY by poll: the new task must be visible with our subject.
    let created: { id: string } | undefined;
    for (let i = 0; i < 20 && !created; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const tasks = pending.matterId ? await ctx.smokeball.listTasks({ matterId: pending.matterId }) : await ctx.smokeball.listTasks();
      created = tasks.find((t) => t.subject === pending.subject && !t.isCompleted && new Date(t.createdAt).getTime() >= createdAfter);
      if (created) {
        const t = tasks.find((x) => x.id === created!.id)!;
        await ctx.db
          .insert(schema.tasks)
          .values({
            id: t.id,
            matterId: t.matterId ?? null,
            subject: t.subject,
            note: t.note ?? null,
            assigneeIds: t.assigneeIds,
            dueDate: t.dueDate ?? null,
            isCompleted: false,
            completedAt: null,
            createdById: t.createdById,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          })
          .onConflictDoNothing();
      }
    }

    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'write:task_create',
      params: { subject: pending.subject, dueDate: pending.dueDate ?? null, matterId: pending.matterId ?? null, taskId: created?.id ?? null },
      result: created ? 'executed and verified' : 'submitted but NOT verified',
    });

    return {
      data: created
        ? { done: true, taskId: created.id, summary: `Task "${pending.subject}"${pending.dueDate ? ` due ${pending.dueDate}` : ''}${pending.matterLabel ? ` on ${pending.matterLabel}` : ''} — created and verified in Smokeball.` }
        : { done: false, warning: 'The task was submitted but could not be verified in Smokeball yet. Tell the user to double-check before relying on it.' },
      citations: created ? [cite('task', created.id, `Task: ${pending.subject}`)] : [],
      asOf,
    };
  },
};

// ------------------------------------------------------------ event create

const proposeEventSchema = z.object({
  subject: z.string().min(2).max(200).describe('Event title in diary style, e.g. "Call with Frank re Tran settlement posture".'),
  start: z.string().describe('Start date-time, ISO (YYYY-MM-DDTHH:mm). Firm time zone if no offset given.'),
  end: z.string().optional().describe('End date-time, ISO. Omit to use durationMinutes.'),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional().describe('Length when no end is given. Default 30.'),
  matterQuery: z.string().optional().describe('Client name, matter number, or matter id to attach the event to.'),
  location: z.string().max(200).optional(),
});

const proposeEventCreate: ToolDef = {
  name: 'propose_event_create',
  description:
    'Step 1 of putting something on the calendar. Validates the time, resolves the matter (asks if several match), flags conflicts with existing events, and returns a confirmation card + token. Present it in a sentence or two and call execute_event_create ONLY after the user explicitly confirms.',
  paramsSchema: proposeEventSchema,
  run: async (ctx, raw) => {
    const p = proposeEventSchema.parse(raw);
    const asOf = new Date().toISOString();
    const start = parseWhen(p.start);
    if (!start.isValid) return { data: { error: `"${p.start}" is not a valid date-time — use YYYY-MM-DDTHH:mm.` }, citations: [], asOf };
    const end = p.end ? parseWhen(p.end) : start.plus({ minutes: p.durationMinutes ?? 30 });
    if (!end.isValid || end <= start) return { data: { error: 'The end must be after the start.' }, citations: [], asOf };

    const r = await resolveMatter(ctx, p.matterQuery);
    if (r.ambiguous) return r.ambiguous;
    if (r.notFound) return r.notFound;

    // Conflict check against the user's cached calendar.
    const mine = (await ctx.db.select().from(schema.events)).filter((e) => e.attendeeIds.includes(ctx.currentStaffId));
    const conflicts = mine.filter((e) => DateTime.fromISO(e.startTime) < end && DateTime.fromISO(e.endTime) > start);

    const token = randomUUID();
    ctx.confirmations ??= new Map();
    ctx.confirmations.set(token, {
      action: 'event_create',
      subject: p.subject,
      startTime: start.toISO()!,
      endTime: end.toISO()!,
      timeZone: FIRM_TZ,
      matterId: r.matter?.id,
      matterLabel: r.matter?.label,
      location: p.location,
      attendeeIds: [ctx.currentStaffId],
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    const now = appNow(ctx.fixedNowIso);
    return {
      data: {
        confirmationRequired: true,
        confirmationToken: token,
        card: {
          action: 'Create calendar event',
          event: p.subject,
          when: `${start.setZone(FIRM_TZ).toFormat('cccc, LLLL d')} ${start.setZone(FIRM_TZ).toFormat('h:mm a')}–${end.setZone(FIRM_TZ).toFormat('h:mm a')}`,
          matter: r.matter?.label ?? 'no matter',
          ...(p.location ? { location: p.location } : {}),
          ...(start < now ? { warning: 'That time is already in the past.' } : {}),
          ...(conflicts.length
            ? { conflicts: conflicts.map((c) => `${c.subject} (${DateTime.fromISO(c.startTime).setZone(FIRM_TZ).toFormat('h:mm a')})`) }
            : {}),
          note: 'Nothing is created in Smokeball until the user confirms.',
        },
      },
      citations: [
        ...(r.matter ? [cite('matter', r.matter.id, r.matter.label)] : []),
        ...conflicts.map((c) => cite('event', c.id, `Event: ${c.subject}`)),
      ],
      asOf,
    };
  },
};

const executeEventCreate: ToolDef = {
  name: 'execute_event_create',
  description:
    'Step 2 of putting something on the calendar — call ONLY after the user explicitly confirmed the proposed card in this conversation. Creates the event in Smokeball, verifies it landed, and reports the verified result.',
  paramsSchema: z.object({ confirmationToken: z.string() }),
  run: async (ctx, raw) => {
    const { confirmationToken } = z.object({ confirmationToken: z.string() }).parse(raw);
    const asOf = new Date().toISOString();
    const pending = ctx.confirmations?.get(confirmationToken);
    if (!pending || pending.expiresAt < Date.now() || pending.action !== 'event_create') {
      ctx.confirmations?.delete(confirmationToken);
      return { data: { error: 'That confirmation has expired or was already used — propose the event again.' }, citations: [], asOf };
    }
    ctx.confirmations!.delete(confirmationToken);
    if (!ctx.smokeball) throw new Error('writes unavailable: no Smokeball connection');

    await ctx.smokeball.createEvent({
      subject: pending.subject,
      startTime: pending.startTime,
      endTime: pending.endTime,
      timeZone: pending.timeZone,
      attendeeIds: pending.attendeeIds,
      allDay: false,
      ...(pending.matterId ? { matterId: pending.matterId } : {}),
      ...(pending.location ? { location: pending.location } : {}),
    });

    const day = DateTime.fromISO(pending.startTime).setZone(FIRM_TZ);
    let created: { id: string } | undefined;
    for (let i = 0; i < 20 && !created; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const events = await ctx.smokeball.listEvents({ from: day.startOf('day').toISO()!, to: day.endOf('day').toISO()! });
      const hit = events.find(
        (e) => e.subject === pending.subject && Math.abs(DateTime.fromISO(e.startTime).toMillis() - DateTime.fromISO(pending.startTime).toMillis()) < 60_000,
      );
      if (hit) {
        created = { id: hit.id };
        await ctx.db
          .insert(schema.events)
          .values({
            id: hit.id,
            matterId: hit.matterId ?? null,
            subject: hit.subject,
            startTime: hit.startTime,
            endTime: hit.endTime,
            timeZone: hit.timeZone,
            allDay: hit.allDay,
            attendeeIds: hit.attendeeIds,
            onOfficeCalendar: hit.onOfficeCalendar,
            location: hit.location ?? null,
            createdAt: hit.createdAt,
            updatedAt: hit.updatedAt,
          })
          .onConflictDoNothing();
      }
    }

    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'write:event_create',
      params: { subject: pending.subject, start: pending.startTime, end: pending.endTime, matterId: pending.matterId ?? null, eventId: created?.id ?? null },
      result: created ? 'executed and verified' : 'submitted but NOT verified',
    });

    return {
      data: created
        ? { done: true, eventId: created.id, summary: `"${pending.subject}" is on the calendar for ${day.toFormat('cccc, LLLL d')} at ${day.toFormat('h:mm a')} — verified in Smokeball.` }
        : { done: false, warning: 'The event was submitted but could not be verified in Smokeball yet. Tell the user to double-check before relying on it.' },
      citations: created ? [cite('event', created.id, `Event: ${pending.subject}`)] : [],
      asOf,
    };
  },
};

export const CREATE_TOOLS: ToolDef[] = [proposeTaskCreate, executeTaskCreate, proposeEventCreate, executeEventCreate];
