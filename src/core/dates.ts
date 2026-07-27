import { DateTime } from 'luxon';

/**
 * All user-facing date logic runs in the firm's timezone, never UTC and never
 * from Smokeball's display colors (docs/04 §1). Jeff's firm is in Stony Point, NY.
 */
export const FIRM_TZ = 'America/New_York';

export type TaskStatus =
  | 'completed'
  | 'overdue'
  | 'due_today'
  | 'upcoming'
  | 'no_due_date';

/** A calendar day in the firm's timezone for a given instant. */
export function firmDay(now: DateTime): DateTime {
  return now.setZone(FIRM_TZ).startOf('day');
}

/**
 * Classify a task by comparing its due date and completion status to "now"
 * in the firm's timezone. `dueDate` is a plain ISO calendar date (Smokeball's
 * dueDateOnly) — a task due "today" is due until the last moment of today.
 */
export function classifyTask(
  task: { dueDate?: string | undefined; isCompleted: boolean },
  now: DateTime,
): TaskStatus {
  if (task.isCompleted) return 'completed';
  if (!task.dueDate) return 'no_due_date';
  const due = DateTime.fromISO(task.dueDate, { zone: FIRM_TZ }).startOf('day');
  if (!due.isValid) return 'no_due_date';
  const today = firmDay(now);
  if (due < today) return 'overdue';
  if (due.equals(today)) return 'due_today';
  return 'upcoming';
}

/** Whole days a task is past due (0 when not overdue). */
export function daysOverdue(
  task: { dueDate?: string | undefined; isCompleted: boolean },
  now: DateTime,
): number {
  if (classifyTask(task, now) !== 'overdue' || !task.dueDate) return 0;
  const due = DateTime.fromISO(task.dueDate, { zone: FIRM_TZ }).startOf('day');
  return Math.round(firmDay(now).diff(due, 'days').days);
}

/**
 * Statute-of-limitations reminder detection.
 *
 * The firm does not use task categories (docs/08 §3), so hard-deadline
 * detection keys off title text. Statute reminders follow Smokeball's
 * 6-month / 3-month / 1-month pattern and typically contain "statute",
 * "statute of limitations", or "SOL" in the subject. These tasks are never
 * movable and are listed apart from actionable overdue work.
 */
const STATUTE_PATTERNS: RegExp[] = [
  /statute\s+of\s+limitations?/i,
  /\bstatute\b/i,
  /\bSOL\b/,
  /\blimitations?\s+(date|deadline|period)\b/i,
];

export function isStatuteReminder(subject: string): boolean {
  return STATUTE_PATTERNS.some((p) => p.test(subject));
}

/** Split tasks Jeff-style: statute reminders are expected to sit in overdue. */
export function splitOverdue<T extends { subject: string }>(
  overdueTasks: T[],
): { statuteReminders: T[]; needsDecision: T[] } {
  const statuteReminders: T[] = [];
  const needsDecision: T[] = [];
  for (const t of overdueTasks) {
    (isStatuteReminder(t.subject) ? statuteReminders : needsDecision).push(t);
  }
  return { statuteReminders, needsDecision };
}

/** Inclusive [start, end] instants of today in the firm's timezone. */
export function todayRange(now: DateTime): { start: DateTime; end: DateTime } {
  const start = firmDay(now);
  return { start, end: start.endOf('day') };
}

/** Monday–Sunday range containing "now" (his "schedule for the week"). */
export function thisWeekRange(now: DateTime): { start: DateTime; end: DateTime } {
  const start = firmDay(now).startOf('week'); // luxon weeks start Monday
  return { start, end: start.plus({ days: 6 }).endOf('day') };
}

/** Next week's Monday–Friday (the court list Jeff wants by Wednesday prior). */
export function nextWeekCourtRange(now: DateTime): { start: DateTime; end: DateTime } {
  const nextMonday = firmDay(now).startOf('week').plus({ weeks: 1 });
  return { start: nextMonday, end: nextMonday.plus({ days: 4 }).endOf('day') };
}

/**
 * The next-week Mon–Fri court list must be on the dashboard no later than the
 * Wednesday before (docs/08 §9): surface it Wednesday through Sunday.
 */
export function shouldShowNextWeekCourts(now: DateTime): boolean {
  return firmDay(now).weekday >= 3; // 3 = Wednesday
}

/** "Now" for the app: real clock unless a fixed instant is injected (tests, golden data). */
export function appNow(fixedIso?: string): DateTime {
  if (fixedIso) {
    const dt = DateTime.fromISO(fixedIso, { zone: FIRM_TZ });
    if (!dt.isValid) throw new Error(`invalid fixed now: ${fixedIso}`);
    return dt;
  }
  return DateTime.now().setZone(FIRM_TZ);
}
