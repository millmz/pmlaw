import { DateTime } from 'luxon';
import { FIRM_TZ, appNow, classifyTask, daysOverdue, isStatuteReminder, splitOverdue } from '../../core/dates.js';
import { parseMemoFacts } from '../settlement/engine.js';
import { sql } from 'drizzle-orm';
import { schema } from '../db/index.js';
import { mirror } from '../db/mirror.js';
import type { ToolContext } from '../tools/types.js';

/**
 * The live snapshot — Block 2's picture of the whole practice, assembled from
 * cheap cache queries only (no file downloads, no API calls) so it can ride
 * every single turn. It is a summary; the tools are the drill-down. Compact
 * JSON: the model reads it fine and tokens stay modest.
 */
export async function buildSnapshot(ctx: ToolContext): Promise<string> {
  // Rebuilt at most every five minutes, or the moment the mirror changes — not
  // on every turn (it rides every single request to the model).
  const bucket = Math.floor(appNow(ctx.fixedNowIso).toMillis() / 300_000);
  return mirror.derived(ctx.db, `snapshot:${ctx.currentStaffId}:${bucket}`, () => computeSnapshot(ctx));
}

async function computeSnapshot(ctx: ToolContext): Promise<string> {
  const now = appNow(ctx.fixedNowIso);
  const today = now.setZone(FIRM_TZ).startOf('day');

  const [matters, typeById, tasks, events] = [
    await mirror.matters(ctx.db),
    await mirror.typesInUse(ctx.db),
    await mirror.tasks(ctx.db),
    await mirror.events(ctx.db),
  ];
  // Only notes that talk settlement money are read — never the whole table.
  const memoRows = await ctx.db
    .select({ id: schema.memos.id, matterId: schema.memos.matterId, text: schema.memos.text, updatedAt: schema.memos.updatedAt })
    .from(schema.memos)
    .where(sql`${schema.memos.text} ~* ${'(demand|offer)'}`);
  const memosByMatter = new Map<string, typeof memoRows>();
  for (const x of memoRows) {
    const list = memosByMatter.get(x.matterId);
    if (list) list.push(x);
    else memosByMatter.set(x.matterId, [x]);
  }
  const nowMs = now.toMillis();
  const openTaskMatters = new Set(tasks.filter((t) => !t.isCompleted && t.matterId).map((t) => t.matterId!));
  const futureEventMatters = new Set(
    events.filter((e) => e.matterId && e.startMs > nowMs).map((e) => e.matterId!),
  );
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
    .filter((e) => e.startMs >= today.toMillis() && e.startMs < today.plus({ days: 1 }).toMillis())
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
    .filter((m) => memosByMatter.has(m.id))
    .map((m) => {
      const ms = [...memosByMatter.get(m.id)!].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const facts = parseMemoFacts(ms.map((x) => ({ id: x.id, text: x.text })));
      const lastTouch = ms.filter((x) => facts.sourceMemoIds.includes(x.id)).at(-1)?.updatedAt;
      return facts.offer || facts.demand
        ? { matter: label(m), demand: facts.demand, offer: facts.offer, adjuster: facts.adjusterName, lastTouch: lastTouch?.slice(0, 10) }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (b.lastTouch ?? '').localeCompare(a.lastTouch ?? ''))
    .slice(0, 5);

  // Stalled: open matters with no open task and no future event. On a real
  // firm that can be hundreds — the snapshot carries a count and a sample;
  // find_stalled_matters has the full list.
  const stalledAll = open.filter((m) => !openTaskMatters.has(m.id) && !futureEventMatters.has(m.id)).map(label);
  const stalled = stalledAll.slice(0, 12);

  // Alerts — computed, each one a reason to act
  const alerts: string[] = [];
  if (oldest) alerts.push(`Oldest overdue needing a decision: "${oldest.subject}" — ${daysOverdue({ dueDate: oldest.dueDate ?? undefined, isCompleted: false }, now)} days late`);
  for (const s of statutes.filter((s) => s.daysOut <= 60)) alerts.push(`Statute in ${s.daysOut} days: ${s.matter} (${s.date})`);
  if (stalledAll.length > 0) alerts.push(`No next step scheduled (${stalledAll.length} matter${stalledAll.length === 1 ? '' : 's'}): ${stalled.join(', ')}${stalledAll.length > stalled.length ? ', … (find_stalled_matters lists all)' : ''}`);
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
