import { DateTime } from 'luxon';
import { FIRM_TZ, appNow, shouldShowNextWeekCourts } from '../../core/dates.js';
import { runTool } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

/**
 * Structured data for the Today dashboard — Jeff's morning order (docs/08 §1):
 * today's calendar → rest of week → due today → overdue (needs-decision vs
 * statute reminders) → watchlist. Composed from the same read tools the agent
 * uses, so the dashboard and chat can never disagree.
 */

interface ApiEvent {
  id: string;
  start: string;
  end: string;
  subject: string;
  location?: string | null;
  matter: string | null;
  matterId?: string | null;
}
interface ApiTask {
  id: string;
  subject: string;
  dueDate?: string | null;
  daysOverdue: number;
  matter: string | null;
  matterId?: string | null;
}

/** Tools return `{ error }` instead of data when e.g. the staff member isn't
 *  in the mirror yet (fresh real-tenant cutover, empty staging DB). The
 *  dashboard must degrade to empty lists, never 500. */
const eventsOf = (d: unknown): ApiEvent[] => (d as { events?: ApiEvent[] })?.events ?? [];
const tasksOf = (d: unknown): ApiTask[] => (d as { tasks?: ApiTask[] })?.tasks ?? [];

export async function getTodayData(ctx: ToolContext) {
  const now = appNow(ctx.fixedNowIso);

  const [today, week, dueToday, overdue, stalled] = [
    await runTool(ctx, 'get_calendar_events', { scope: 'today' }),
    await runTool(ctx, 'get_calendar_events', { scope: 'this_week' }),
    await runTool(ctx, 'get_tasks', { status: 'due_today' }),
    await runTool(ctx, 'get_tasks', { status: 'overdue' }),
    await runTool(ctx, 'find_stalled_matters', {}),
  ];

  const showNextWeek = shouldShowNextWeekCourts(now);
  const nextWeekCourts = showNextWeek
    ? await runTool(ctx, 'get_calendar_events', { scope: 'next_week_courts', officeCalendar: true })
    : null;

  const todayEvents = eventsOf(today.data);
  const weekEvents = eventsOf(week.data).filter((e) => !todayEvents.some((t) => t.id === e.id));
  const od = overdue.data as
    | { needsDecision?: ApiTask[]; statuteReminders?: { note: string; tasks: ApiTask[] } }
    | undefined;

  return {
    dateLabel: now.setZone(FIRM_TZ).toFormat('cccc, LLLL d, yyyy'),
    nowIso: now.toISO(),
    asOf: today.asOf,
    todayEvents,
    weekEvents,
    nextWeekCourts: nextWeekCourts ? eventsOf(nextWeekCourts.data) : null,
    dueToday: tasksOf(dueToday.data),
    overdue: {
      needsDecision: od?.needsDecision ?? [],
      statuteReminders: od?.statuteReminders ?? { note: '', tasks: [] },
    },
    watchlist: {
      stalledMatters:
        (stalled.data as { matters?: { id: string; label: string; lastActivity: string }[] })?.matters ?? [],
    },
    citationCount:
      today.citations.length +
      week.citations.length +
      dueToday.citations.length +
      overdue.citations.length +
      stalled.citations.length,
  };
}

export type TodayData = Awaited<ReturnType<typeof getTodayData>>;

/** Millis until the next event starts (for the "in 40 min" strip); null if none today. */
export function nextEventCountdown(data: TodayData): { event: ApiEvent; startsInMs: number } | null {
  const now = DateTime.fromISO(data.nowIso!);
  for (const e of data.todayEvents) {
    const start = DateTime.fromISO(e.start);
    if (start > now) return { event: e, startsInMs: start.diff(now).toMillis() };
  }
  return null;
}
