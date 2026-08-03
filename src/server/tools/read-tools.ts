import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  FIRM_TZ,
  appNow,
  classifyTask,
  daysOverdue,
  nextWeekCourtRange,
  shouldShowNextWeekCourts,
  splitOverdue,
  thisWeekRange,
  todayRange,
} from '../../core/dates.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import { cite, type Citation } from './citations.js';

import type { ToolContext, ToolDef, ToolResult } from './types.js';

/**
 * PAM's read tools (docs/01 "Tool layer"): a closed registry of typed
 * functions over the cache. Claude never writes SQL and never sees the
 * Smokeball API. Every tool result carries citations and an asOf timestamp.
 *
 * The full registry (read + settlement + write) is assembled in registry.ts —
 * the agent loop derives Claude's tool definitions from it, so capability
 * claims can never drift from what's wired.
 */

export type { ToolContext, ToolDef, ToolResult } from './types.js';

// ---------------------------------------------------------------- helpers

const asOfNow = async (db: Db): Promise<string> => {
  const row = await db.select().from(schema.syncState).limit(1);
  return row[0]?.lastSyncedAt ?? new Date().toISOString();
};

async function staffByRef(db: Db, ref: string): Promise<{ id: string; label: string } | undefined> {
  const all = await db.select().from(schema.staff);
  const r = ref.trim().toLowerCase();
  const hit = all.find(
    (s) =>
      s.id === ref ||
      s.initials.toLowerCase() === r ||
      s.firstName.toLowerCase() === r ||
      s.lastName.toLowerCase() === r ||
      `${s.firstName} ${s.lastName}`.toLowerCase() === r,
  );
  return hit ? { id: hit.id, label: `${hit.firstName} ${hit.lastName} (${hit.initials})` } : undefined;
}

const matterLabel = (m: { number: string; clientFirstName: string; clientLastName: string }) =>
  `Matter ${m.number} · ${m.clientFirstName} ${m.clientLastName}`;

// ------------------------------------------------------------------ tools

const getCalendarSchema = z.object({
  staffRef: z
    .string()
    .optional()
    .describe('Staff member: initials ("JTM"), first or last name. Defaults to the signed-in user.'),
  scope: z
    .enum(['today', 'this_week', 'next_week_courts', 'range'])
    .describe('Which window to fetch.'),
  from: z.string().optional().describe('ISO date, required when scope=range'),
  to: z.string().optional().describe('ISO date, required when scope=range'),
  officeCalendar: z.boolean().optional().describe('True = the shared office calendar (all staff).'),
});

const getCalendar: ToolDef = {
  name: 'get_calendar_events',
  description:
    'Calendar events for a staff member or the office calendar: today, this week, next week\'s Monday–Friday court list, or an explicit date range. Grouped chronologically with matter, location, and attendees.',
  paramsSchema: getCalendarSchema,
  run: async (ctx, raw) => {
    const p = getCalendarSchema.parse(raw);
    const now = appNow(ctx.fixedNowIso);
    let start: DateTime;
    let end: DateTime;
    if (p.scope === 'today') ({ start, end } = todayRange(now));
    else if (p.scope === 'this_week') ({ start, end } = thisWeekRange(now));
    else if (p.scope === 'next_week_courts') ({ start, end } = nextWeekCourtRange(now));
    else {
      if (!p.from || !p.to) throw new Error('scope=range requires from and to');
      start = DateTime.fromISO(p.from, { zone: FIRM_TZ }).startOf('day');
      end = DateTime.fromISO(p.to, { zone: FIRM_TZ }).endOf('day');
    }

    let staffFilter: string | undefined;
    let staffLabel = 'Office calendar';
    if (!p.officeCalendar) {
      const ref = p.staffRef ?? ctx.currentStaffId;
      const hit = await staffByRef(ctx.db, ref);
      if (!hit) {
        return {
          data: { error: `No staff member matches "${p.staffRef}". Ask the user to clarify.` },
          citations: [],
          asOf: await asOfNow(ctx.db),
        };
      }
      staffFilter = hit.id;
      staffLabel = hit.label;
    }

    const all = await ctx.db.select().from(schema.events);
    const matters = await ctx.db.select().from(schema.matters);
    const matterById = new Map(matters.map((m) => [m.id, m]));

    const inWindow = all
      .filter((e) => {
        const s = DateTime.fromISO(e.startTime, { zone: FIRM_TZ });
        return s >= start && s <= end;
      })
      .filter((e) => (staffFilter ? e.attendeeIds.includes(staffFilter) : e.onOfficeCalendar))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    const citations: Citation[] = inWindow.map((e) => {
      const m = e.matterId ? matterById.get(e.matterId) : undefined;
      return cite('event', e.id, `${m ? matterLabel(m) + ' — ' : ''}Event: ${e.subject}`);
    });

    return {
      data: {
        window: { start: start.toISO(), end: end.toISO(), scope: p.scope },
        calendar: staffLabel,
        note:
          p.scope === 'next_week_courts' && !shouldShowNextWeekCourts(now)
            ? 'Note: next-week list normally surfaces from Wednesday; shown because explicitly requested.'
            : undefined,
        events: inWindow.map((e) => {
          const m = e.matterId ? matterById.get(e.matterId) : undefined;
          return {
            id: e.id,
            start: e.startTime,
            end: e.endTime,
            subject: e.subject,
            location: e.location,
            matter: m ? matterLabel(m) : null,
            matterId: e.matterId,
            attendees: e.attendeeIds,
            onOfficeCalendar: e.onOfficeCalendar,
          };
        }),
      },
      citations,
      asOf: await asOfNow(ctx.db),
    };
  },
};

const getTasksSchema = z.object({
  assigneeRef: z
    .string()
    .optional()
    .describe('Staff member: initials, first or last name. Defaults to the signed-in user.'),
  status: z
    .enum(['overdue', 'due_today', 'upcoming', 'all_open'])
    .describe('Which bucket. Overdue is returned split: statute reminders vs needs-decision.'),
  matterId: z.string().optional(),
});

const getTasks: ToolDef = {
  name: 'get_tasks',
  description:
    'Open tasks for a staff member by status bucket (overdue / due today / upcoming / all open). Overdue is split into statute-of-limitations reminders (expected, never movable) and tasks needing a decision, ordered oldest first. Completed tasks are never included.',
  paramsSchema: getTasksSchema,
  run: async (ctx, raw) => {
    const p = getTasksSchema.parse(raw);
    const now = appNow(ctx.fixedNowIso);
    const ref = p.assigneeRef ?? ctx.currentStaffId;
    const hit = await staffByRef(ctx.db, ref);
    if (!hit) {
      return {
        data: { error: `No staff member matches "${p.assigneeRef}". Ask the user to clarify.` },
        citations: [],
        asOf: await asOfNow(ctx.db),
      };
    }

    const all = await ctx.db.select().from(schema.tasks);
    const matters = await ctx.db.select().from(schema.matters);
    const matterById = new Map(matters.map((m) => [m.id, m]));

    let open = all.filter((t) => !t.isCompleted && t.assigneeIds.includes(hit.id));
    if (p.matterId) open = open.filter((t) => t.matterId === p.matterId);

    const classified = open.map((t) => ({
      task: t,
      status: classifyTask({ dueDate: t.dueDate ?? undefined, isCompleted: t.isCompleted }, now),
    }));

    const project = (t: (typeof classified)[number]) => {
      const m = t.task.matterId ? matterById.get(t.task.matterId) : undefined;
      return {
        id: t.task.id,
        subject: t.task.subject,
        dueDate: t.task.dueDate,
        status: t.status,
        daysOverdue: daysOverdue({ dueDate: t.task.dueDate ?? undefined, isCompleted: false }, now),
        matter: m ? matterLabel(m) : null,
        matterId: t.task.matterId,
        assignees: t.task.assigneeIds,
      };
    };

    const byBucket = (bucket: string) =>
      classified.filter((c) => c.status === bucket).sort((a, b) => (a.task.dueDate ?? '').localeCompare(b.task.dueDate ?? ''));

    let data: unknown;
    let cited: (typeof classified)[number][];
    if (p.status === 'overdue') {
      const overdue = byBucket('overdue');
      const { statuteReminders, needsDecision } = splitOverdue(
        overdue.map((c) => ({ subject: c.task.subject, _c: c })),
      );
      data = {
        assignee: hit.label,
        needsDecision: needsDecision.map((x) => project((x as { _c: (typeof classified)[number] })._c)),
        statuteReminders: {
          note: 'Statute-of-limitations reminders are expected to remain overdue and must never be rescheduled.',
          tasks: statuteReminders.map((x) => project((x as { _c: (typeof classified)[number] })._c)),
        },
      };
      cited = overdue;
    } else if (p.status === 'all_open') {
      data = {
        assignee: hit.label,
        overdue: byBucket('overdue').map(project),
        dueToday: byBucket('due_today').map(project),
        upcoming: byBucket('upcoming').map(project),
        noDueDate: byBucket('no_due_date').map(project),
      };
      cited = classified;
    } else {
      const bucket = byBucket(p.status);
      data = { assignee: hit.label, tasks: bucket.map(project) };
      cited = bucket;
    }

    return {
      data,
      citations: cited.map((c) => {
        const m = c.task.matterId ? matterById.get(c.task.matterId) : undefined;
        return cite('task', c.task.id, `${m ? matterLabel(m) + ' — ' : ''}Task: ${c.task.subject}`);
      }),
      asOf: await asOfNow(ctx.db),
    };
  },
};

const searchMattersSchema = z.object({
  clientName: z.string().optional().describe('Client first or last name, e.g. "Fontana" or "Juan".'),
  practiceArea: z
    .string()
    .optional()
    .describe('e.g. "Personal Injury", "Criminal", "Medical Malpractice"'),
  status: z.enum(['Open', 'Closed', 'any']).optional().describe('Defaults to Open.'),
});

const searchMatters: ToolDef = {
  name: 'search_matters',
  description:
    'Search matters by client name and/or practice area. Defaults to open matters only. When several clients share a name, ALL matches are returned — present them and ask the user to choose; never silently pick one.',
  paramsSchema: searchMattersSchema,
  run: async (ctx, raw) => {
    const p = searchMattersSchema.parse(raw);
    const status = p.status ?? 'Open';
    const all = await ctx.db.select().from(schema.matters);
    const types = await ctx.db.select().from(schema.matterTypes);
    const typeById = new Map(types.map((t) => [t.id, t]));

    let hits = all;
    if (status !== 'any') hits = hits.filter((m) => m.status === status);
    if (p.clientName) {
      const q = p.clientName.trim().toLowerCase();
      hits = hits.filter(
        (m) =>
          m.clientFirstName.toLowerCase().includes(q) ||
          m.clientLastName.toLowerCase().includes(q) ||
          `${m.clientFirstName} ${m.clientLastName}`.toLowerCase().includes(q),
      );
    }
    if (p.practiceArea) {
      const q = p.practiceArea.toLowerCase();
      hits = hits.filter((m) => typeById.get(m.matterTypeId)?.category.toLowerCase().includes(q));
    }

    return {
      data: {
        count: hits.length,
        ambiguous: p.clientName !== undefined && hits.length > 1,
        matters: hits.map((m) => ({
          id: m.id,
          label: matterLabel(m),
          practiceArea: typeById.get(m.matterTypeId)?.category ?? 'Unknown',
          jurisdiction: typeById.get(m.matterTypeId)?.location,
          status: m.status,
          isInSuit: m.isInSuit,
          statuteDate: m.statuteDate,
        })),
      },
      citations: hits.map((m) => cite('matter', m.id, matterLabel(m))),
      asOf: await asOfNow(ctx.db),
    };
  },
};

const getMatterOverviewSchema = z.object({
  matterId: z.string().describe('Matter id from search_matters.'),
});

const getMatterOverview: ToolDef = {
  name: 'get_matter_overview',
  description:
    'Everything cached about one matter: details, statute date, open tasks, upcoming events, notes/memos (with author and last-edit info — where demand/offer/adjuster live), and file inventory by folder. The notes are retrieved verbatim; quote figures only from them and cite the memo.',
  paramsSchema: getMatterOverviewSchema,
  run: async (ctx, raw) => {
    const p = getMatterOverviewSchema.parse(raw);
    const now = appNow(ctx.fixedNowIso);
    const m = (await ctx.db.select().from(schema.matters).where(eq(schema.matters.id, p.matterId)))[0];
    if (!m) {
      return { data: { error: `No matter with id ${p.matterId}` }, citations: [], asOf: await asOfNow(ctx.db) };
    }
    const types = await ctx.db.select().from(schema.matterTypes);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const staffRows = await ctx.db.select().from(schema.staff);
    const staffById = new Map(staffRows.map((s) => [s.id, `${s.firstName} ${s.lastName} (${s.initials})`]));

    const tasksRows = (await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.matterId, p.matterId))).filter(
      (t) => !t.isCompleted,
    );
    const eventRows = (await ctx.db.select().from(schema.events).where(eq(schema.events.matterId, p.matterId))).filter(
      (e) => DateTime.fromISO(e.startTime, { zone: FIRM_TZ }) >= now.startOf('day'),
    );
    const memoRows = await ctx.db.select().from(schema.memos).where(eq(schema.memos.matterId, p.matterId));
    const folderRows = await ctx.db.select().from(schema.folders).where(eq(schema.folders.matterId, p.matterId));
    const fileRows = await ctx.db.select().from(schema.files).where(eq(schema.files.matterId, p.matterId));
    const folderById = new Map(folderRows.map((f) => [f.id, f.name]));

    const citations: Citation[] = [
      cite('matter', m.id, matterLabel(m)),
      ...memoRows.map((memo) =>
        cite('memo', memo.id, `${matterLabel(m)} — Note by ${staffById.get(memo.updatedById) ?? memo.updatedById}, last edited ${memo.updatedAt.slice(0, 10)}`),
      ),
    ];

    return {
      data: {
        matter: {
          id: m.id,
          label: matterLabel(m),
          practiceArea: typeById.get(m.matterTypeId)?.category,
          jurisdiction: typeById.get(m.matterTypeId)?.location,
          status: m.status,
          isInSuit: m.isInSuit,
          dateOfLoss: m.dateOfLoss,
          statuteDate: m.statuteDate,
        },
        openTasks: tasksRows.map((t) => ({
          id: t.id,
          subject: t.subject,
          dueDate: t.dueDate,
          status: classifyTask({ dueDate: t.dueDate ?? undefined, isCompleted: false }, now),
          assignees: t.assigneeIds.map((a) => staffById.get(a) ?? a),
        })),
        upcomingEvents: eventRows.map((e) => ({
          id: e.id,
          start: e.startTime,
          subject: e.subject,
          location: e.location,
        })),
        notes: memoRows.map((memo) => ({
          id: memo.id,
          text: memo.text,
          author: staffById.get(memo.createdById) ?? memo.createdById,
          lastEditedBy: staffById.get(memo.updatedById) ?? memo.updatedById,
          lastEditedAt: memo.updatedAt,
        })),
        filesByFolder: Object.fromEntries(
          [...folderRows.map((f) => f.name), 'Unfiled'].map((name) => [
            name,
            fileRows
              .filter((f) => (f.folderId ? folderById.get(f.folderId) === name : name === 'Unfiled'))
              .map((f) => ({ id: f.id, name: f.name, created: f.dateCreated, from: f.emailFrom, to: f.emailTo })),
          ]),
        ),
      },
      citations,
      asOf: await asOfNow(ctx.db),
    };
  },
};

const findStalledSchema = z.object({
  daysWithoutActivity: z.number().optional().describe('Default 30.'),
});

const findStalledMatters: ToolDef = {
  name: 'find_stalled_matters',
  description:
    'Open matters with no future task and no future calendar event — the cases at risk of slipping through the cracks. Includes last-activity date derived from cached record timestamps.',
  paramsSchema: findStalledSchema,
  run: async (ctx, raw) => {
    findStalledSchema.parse(raw);
    const now = appNow(ctx.fixedNowIso);
    const matters = (await ctx.db.select().from(schema.matters)).filter((m) => m.status === 'Open');
    const allTasks = await ctx.db.select().from(schema.tasks);
    const allEvents = await ctx.db.select().from(schema.events);

    const stalled = matters
      .map((m) => {
        const openTasks = allTasks.filter((t) => t.matterId === m.id && !t.isCompleted);
        const futureEvents = allEvents.filter(
          (e) => e.matterId === m.id && DateTime.fromISO(e.startTime, { zone: FIRM_TZ }) > now,
        );
        const lastTouched = [m.updatedAt, ...allTasks.filter((t) => t.matterId === m.id).map((t) => t.updatedAt), ...allEvents.filter((e) => e.matterId === m.id).map((e) => e.updatedAt)]
          .sort()
          .at(-1)!;
        return { m, openTasks, futureEvents, lastTouched };
      })
      .filter((x) => x.openTasks.length === 0 && x.futureEvents.length === 0);

    return {
      data: {
        note: 'Last-activity is derived from cached record update times (Smokeball has no activity feed).',
        matters: stalled.map((x) => ({
          id: x.m.id,
          label: matterLabel(x.m),
          lastActivity: x.lastTouched,
        })),
      },
      citations: stalled.map((x) => cite('matter', x.m.id, matterLabel(x.m))),
      asOf: await asOfNow(ctx.db),
    };
  },
};

const getStaffSchema = z.object({});

const listFirmStaff: ToolDef = {
  name: 'list_firm_staff',
  description: 'The firm roster: names, initials (JTM, FJP…), and roles, for resolving who "Frank" or "front desk" is.',
  paramsSchema: getStaffSchema,
  run: async (ctx) => {
    const rows = await ctx.db.select().from(schema.staff);
    return {
      data: rows.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}`, initials: s.initials, role: s.role })),
      citations: rows.map((s) => cite('staff', s.id, `${s.firstName} ${s.lastName} (${s.initials})`)),
      asOf: await asOfNow(ctx.db),
    };
  },
};

export const READ_TOOLS: ToolDef[] = [
  getCalendar,
  getTasks,
  searchMatters,
  getMatterOverview,
  findStalledMatters,
  listFirmStaff,
];

