import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  FIRM_TZ,
  classifyTask,
  daysOverdue,
  isStatuteReminder,
  nextWeekCourtRange,
  shouldShowNextWeekCourts,
  splitOverdue,
  thisWeekRange,
} from './dates.js';

const at = (iso: string) => DateTime.fromISO(iso, { zone: FIRM_TZ });

describe('classifyTask', () => {
  const now = at('2026-07-27T09:00:00'); // a Monday morning

  it('classifies the basic buckets', () => {
    expect(classifyTask({ dueDate: '2026-07-24', isCompleted: false }, now)).toBe('overdue');
    expect(classifyTask({ dueDate: '2026-07-27', isCompleted: false }, now)).toBe('due_today');
    expect(classifyTask({ dueDate: '2026-07-29', isCompleted: false }, now)).toBe('upcoming');
    expect(classifyTask({ isCompleted: false }, now)).toBe('no_due_date');
  });

  it('a task due today stays due_today until the last moment of the firm day', () => {
    const lateNight = at('2026-07-27T23:59:59');
    expect(classifyTask({ dueDate: '2026-07-27', isCompleted: false }, lateNight)).toBe('due_today');
    const justAfterMidnight = at('2026-07-28T00:00:01');
    expect(classifyTask({ dueDate: '2026-07-27', isCompleted: false }, justAfterMidnight)).toBe('overdue');
  });

  it('completed wins even when the due date has passed (completed late)', () => {
    expect(classifyTask({ dueDate: '2026-07-01', isCompleted: true }, now)).toBe('completed');
  });

  it('uses the firm timezone, not UTC', () => {
    // 11 PM July 27 in New York is already July 28 in UTC. Task due July 27
    // must still be due_today, not overdue.
    const elevenPmNY = at('2026-07-27T23:00:00');
    expect(elevenPmNY.toUTC().day).toBe(28); // sanity: UTC has rolled over
    expect(classifyTask({ dueDate: '2026-07-27', isCompleted: false }, elevenPmNY)).toBe('due_today');
  });

  it('handles DST transitions without off-by-one', () => {
    // US spring-forward 2026: March 8. A task due March 8, checked March 9.
    const springNow = at('2026-03-09T08:00:00');
    expect(classifyTask({ dueDate: '2026-03-08', isCompleted: false }, springNow)).toBe('overdue');
    expect(daysOverdue({ dueDate: '2026-03-08', isCompleted: false }, springNow)).toBe(1);
    // Fall-back 2026: November 1. Due Nov 1 checked Nov 2 = 1 day, not 0 or 2.
    const fallNow = at('2026-11-02T08:00:00');
    expect(daysOverdue({ dueDate: '2026-11-01', isCompleted: false }, fallNow)).toBe(1);
  });

  it('counts days overdue in whole firm days', () => {
    expect(daysOverdue({ dueDate: '2026-06-30', isCompleted: false }, at('2026-07-22T09:00:00'))).toBe(22);
    expect(daysOverdue({ dueDate: '2026-07-27', isCompleted: false }, now)).toBe(0);
  });
});

describe('statute reminder detection (title text — the firm uses no categories)', () => {
  it('detects the firm patterns', () => {
    expect(isStatuteReminder('Statute of Limitations - 6 Month Reminder')).toBe(true);
    expect(isStatuteReminder('SOL 3 month reminder - Petrov')).toBe(true);
    expect(isStatuteReminder('statute expires 11/3 - FILE SUIT')).toBe(true);
    expect(isStatuteReminder('JTM - 1 month limitations deadline')).toBe(true);
  });

  it('does not flag ordinary tasks', () => {
    expect(isStatuteReminder('JTM - Call adjuster re settlement package')).toBe(false);
    expect(isStatuteReminder('Obtain updated authorizations')).toBe(false);
    expect(isStatuteReminder('Draft solution memo')).toBe(false); // "sol" inside a word
  });

  it('splits overdue Jeff-style', () => {
    const { statuteReminders, needsDecision } = splitOverdue([
      { subject: 'Statute of Limitations - 6 Month Reminder' },
      { subject: 'JTM - Call adjuster' },
    ]);
    expect(statuteReminders).toHaveLength(1);
    expect(needsDecision).toHaveLength(1);
  });
});

describe('week ranges', () => {
  it('thisWeekRange covers Monday through Sunday of the current week', () => {
    const { start, end } = thisWeekRange(at('2026-07-29T12:00:00')); // a Wednesday
    expect(start.toISODate()).toBe('2026-07-27');
    expect(end.toISODate()).toBe('2026-08-02');
  });

  it('nextWeekCourtRange is next Monday through Friday', () => {
    const { start, end } = nextWeekCourtRange(at('2026-07-29T12:00:00'));
    expect(start.toISODate()).toBe('2026-08-03');
    expect(end.toISODate()).toBe('2026-08-07');
  });

  it('next-week courts surface Wednesday onward, not before', () => {
    expect(shouldShowNextWeekCourts(at('2026-07-27T09:00:00'))).toBe(false); // Mon
    expect(shouldShowNextWeekCourts(at('2026-07-28T09:00:00'))).toBe(false); // Tue
    expect(shouldShowNextWeekCourts(at('2026-07-29T09:00:00'))).toBe(true); // Wed
    expect(shouldShowNextWeekCourts(at('2026-08-01T09:00:00'))).toBe(true); // Sat
  });
});
