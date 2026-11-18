import { DateTime } from 'luxon';
import { FIRM_TZ, appNow, isStatuteReminder, looksLikeCourt } from '../core/dates.js';
import { mirror } from './db/mirror.js';
import { stripInitials } from './panels.js';
import { runTool } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

/**
 * What PAM says when Jeff walks into the orb room.
 *
 * Computed from the mirror, not written by the model: it must be instant,
 * and it must be exactly right. One or two sentences — the hour's greeting,
 * what is next on the calendar, and the shape of the task list.
 */

export interface Greeting {
  /** Spoken (and shown as the first caption). */
  text: string;
  /** For the ambient readout around the orb. */
  ambient: {
    name: string;
    nextEvent: { time: string; title: string; startIso: string; court: boolean } | null;
    eventsLeft: number;
    dueToday: number;
    overdue: number;
  };
}

const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n: number): string => (n >= 0 && n < words.length ? words[n]! : String(n));

/** "9:00 AM" → "nine", "9:30 AM" → "nine thirty", "12:15 PM" → "twelve fifteen" */
export function spokenTime(d: DateTime): string {
  const h = d.hour % 12 === 0 ? 12 : d.hour % 12;
  const m = d.minute;
  return m === 0 ? count(h) : `${count(h)} ${m < 10 ? `oh ${count(m)}` : String(m)}`;
}


export async function buildGreeting(ctx: ToolContext): Promise<Greeting> {
  const now = appNow(ctx.fixedNowIso).setZone(FIRM_TZ);
  const allStaff = await mirror.staff(ctx.db);
  const staff = allStaff.find((s) => s.id === ctx.currentStaffId);
  // The firm's calendar prefixes ("JTM ", "JTM - ") are not said aloud.
  const tidy = (subject: string): string => stripInitials(subject, allStaff.map((s) => s.initials)).trim();
  const first = staff?.firstName?.replace(/^Jeffrey$/i, 'Jeff') || 'Jeff';
  const part = now.hour < 12 ? 'Good morning' : now.hour < 17 ? 'Good afternoon' : 'Good evening';

  type Ev = { start: string; subject: string; location?: string | null; matter?: string | null };
  type Tk = { subject: string };
  const evRes = await runTool(ctx, 'get_calendar_events', { scope: 'today' }).catch(() => null);
  const events = ((evRes?.data as { events?: Ev[] } | undefined)?.events ?? []).filter((e) => DateTime.fromISO(e.start) > now);
  const tkRes = await runTool(ctx, 'get_tasks', { status: 'all_open' }).catch(() => null);
  const buckets = (tkRes?.data ?? {}) as { dueToday?: Tk[]; overdue?: Tk[] };
  const dueToday = (buckets.dueToday ?? []).filter((t) => !isStatuteReminder(t.subject)).length;
  const overdue = (buckets.overdue ?? []).filter((t) => !isStatuteReminder(t.subject)).length;

  const next = events[0];
  const nextAt = next ? DateTime.fromISO(next.start, { zone: FIRM_TZ }) : null;
  const parts: string[] = [`${part}, ${first}.`];
  if (next && nextAt) {
    const mins = Math.round(nextAt.diff(now, 'minutes').minutes);
    const when = mins <= 50 ? `in ${mins} minute${mins === 1 ? '' : 's'}` : `at ${spokenTime(nextAt)}`;
    const title = tidy(next.subject);
    const court = looksLikeCourt(next.subject, next.location ?? undefined);
    const who = next.matter?.replace(/^Matter \S+ · /, '').split(' ').at(-1);
    // A court appearance is said as one: where, and whose matter.
    const what = court && next.location ? `court at ${next.location}${who ? `, on ${who}` : ''}` : title.length > 70 ? `${title.slice(0, 67)}…` : title;
    parts.push(events.length === 1 ? `One thing left on the calendar: ${what}, ${when}.` : court && next.location ? `You have ${what}, ${when}.` : `Next up ${when}: ${what}.`);
  } else {
    parts.push(now.hour < 16 ? 'Your calendar is clear for the rest of the day.' : 'Nothing left on the calendar today.');
  }
  if (dueToday || overdue) {
    const bits = [dueToday ? `${count(dueToday)} task${dueToday === 1 ? '' : 's'} due today` : '', overdue ? `${count(overdue)} overdue` : ''].filter(Boolean);
    parts.push(`${bits.join(' and ').replace(/^./, (c) => c.toUpperCase())}.`);
  }
  return {
    text: parts.join(' '),
    ambient: {
      name: first,
      nextEvent: next && nextAt ? { time: nextAt.toFormat('h:mm a'), title: tidy(next.subject), startIso: next.start, court: looksLikeCourt(next.subject, next.location ?? undefined) } : null,
      eventsLeft: events.length,
      dueToday,
      overdue,
    },
  };
}
