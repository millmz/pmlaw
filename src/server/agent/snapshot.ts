import { DateTime } from 'luxon';
import { FIRM_TZ, appNow, classifyTask, daysOverdue, isStatuteReminder, splitOverdue } from '../../core/dates.js';
import { parseMemoFacts } from '../settlement/engine.js';
import { schema } from '../db/index.js';
import type { ToolContext } from '../tools/types.js';

/**
 * The live snapshot — Block 2's picture of the whole practice, assembled from
 * cheap cache queries only (no file downloads, no API calls) so it can ride
 * every single turn. It is a summary; the tools are the drill-down. Compact
 * JSON: the model reads it fine and tokens stay modest.
 */
export async function buildSnapshot(ctx: ToolContext): Promise<string> {
  const now = appNow(ctx.fixedNowIso);
  const today = now.setZone(FIRM_TZ).startOf('day');

  const [matters, types, tasks, events, memos] = [
    await ctx.db.select().from(schema.matters),
    await ctx.db.select().from(schema.matterTypes),
    await ctx.db.select().from(schema.tasks),
    await ctx.db.select().from(schema.events),
    await ctx.db.select().from(schema.memos),
  ];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const open = matters.filter((m) => m.status === 'Open');
  const label = (m: (typeof matters)[number]) => `${m.clientFirstName} ${m.clientLastName}`;

  // Practice mix
  const mix: Record<string, number> = {};
  for (const m of open) {
    const cat = typeById.get(m.matterTypeId)?.category ?? 'Other';
    mix[cat] = (mix[cat] ?? 0) + 1;
  }

  // Statutes, nearest first
  const statutes = open
    .filter((m) => m.statuteDate)
    .map((m) => ({
      matter: label(m),
      date: m.statuteDate!,
      daysOut: Math.round(DateTime.fromISO(m.statuteDate!, { zone: FIRM_TZ }).diff(today, 'days').days),
    }))
    .filter((s) => s.daysOut >= 0 && s.daysOut <= 400)
    .sort((a, b) => a.daysOut - b.daysOut)
    .slice(0, 6);

  // Today's calendar (Jeff's)
  const todaysEvents = events
    .filter((e) => e.attendeeIds.includes(ctx.currentStaffId))
    .filter((e) => DateTime.fromISO(e.startTime, { zone: FIRM_TZ }).hasSame(today, 'day'))
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((e) => ({
      t: DateTime.fromISO(e.startTime, { zone: FIRM_TZ }).toFormat('h:mm a'),
      what: e.subject,
    }));

  // Task posture (Jeff's)
  const openTasks = tasks.filter((t) => !t.isCompleted && t.assigneeIds.includes(ctx.currentStaffId));
  const dueToday = openTasks.filter((t) => classifyTask({ dueDate: t.dueDate ?? undefined, isCompleted: false }, now) === 'due_today');
  const overdue = openTasks.filter((t) => classifyTask({ dueDate: t.dueDate ?? undefined, isCompleted: false }, now) === 'overdue');
  const { statuteReminders, needsDecision } = splitOverdue(overdue.map((t) => ({ subject: t.subject, _t: t })));
  const oldest = needsDecision
    .map((x) => (x as { _t: (typeof overdue)[number] })._t)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0];

  // Settlement digest from cached notes (no downloads — engine does the deep pass)
  const settlementDigest = open
    .filter((m) => ['Personal Injury', 'Medical Malpractice'].includes(typeById.get(m.matterTypeId)?.category ?? ''))
    .map((m) => {
      const facts = parseMemoFacts(memos.filter((x) => x.matterId === m.id).map((x) => ({ id: x.id, text: x.text })));
      const lastTouch = memos
        .filter((x) => x.matterId === m.id && facts.sourceMemoIds.includes(x.id))
        .map((x) => x.updatedAt)
        .sort()
        .at(-1);
      return facts.offer || facts.demand
        ? { matter: label(m), demand: facts.demand, offer: facts.offer, adjuster: facts.adjusterName, lastTouch: lastTouch?.slice(0, 10) }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (b.lastTouch ?? '').localeCompare(a.lastTouch ?? ''))
    .slice(0, 5);

  // Stalled: open matters with no open task and no future event
  const stalled = open
    .filter((m) => !tasks.some((t) => t.matterId === m.id && !t.isCompleted))
    .filter((m) => !events.some((e) => e.matterId === m.id && DateTime.fromISO(e.startTime, { zone: FIRM_TZ }) > now))
    .map(label);

  // Alerts — computed, each one a reason to act
  const alerts: string[] = [];
  if (oldest) alerts.push(`Oldest overdue needing a decision: "${oldest.subject}" — ${daysOverdue({ dueDate: oldest.dueDate ?? undefined, isCompleted: false }, now)} days late`);
  for (const s of statutes.filter((s) => s.daysOut <= 60)) alerts.push(`Statute in ${s.daysOut} days: ${s.matter} (${s.date})`);
  if (stalled.length > 0) alerts.push(`No next step scheduled: ${stalled.join(', ')}`);
  const statuteTasksDue = openTasks.filter((t) => isStatuteReminder(t.subject) && classifyTask({ dueDate: t.dueDate ?? undefined, isCompleted: false }, now) === 'overdue');
  if (statuteTasksDue.length > 0) alerts.push(`${statuteTasksDue.length} statute reminder(s) sitting in overdue — expected, never reschedule`);

  return JSON.stringify({
    openMatters: open.length,
    practiceMix: mix,
    statutesNearest: statutes,
    today: { events: todaysEvents, tasksDueToday: dueToday.length, overdueNeedingDecision: needsDecision.length, statuteRemindersInOverdue: statuteReminders.length },
    settlementNegotiations: settlementDigest,
    alerts,
  });
}
