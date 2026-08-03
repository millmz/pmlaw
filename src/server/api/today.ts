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

  const todayEvents = (today.data as { events: ApiEvent[] }).events;
  const weekEvents = (week.data as { events: ApiEvent[] }).events.filter(
    (e) => !todayEvents.some((t) => t.id === e.id),
  );

  return {
    dateLabel: now.setZone(FIRM_TZ).toFormat('cccc, LLLL d, yyyy'),
    nowIso: now.toISO(),
    asOf: today.asOf,
    todayEvents,
    weekEvents,
    nextWeekCourts: nextWeekCourts
      ? (nextWeekCourts.data as { events: ApiEvent[] }).events
      : null,
    dueToday: (dueToday.data as { tasks: ApiTask[] }).tasks,
    overdue: overdue.data as {
      needsDecision: ApiTask[];
      statuteReminders: { note: string; tasks: ApiTask[] };
    },
    watchlist: {
      stalledMatters: (stalled.data as { matters: { id: string; label: string; lastActivity: string }[] })
        .matters,
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
