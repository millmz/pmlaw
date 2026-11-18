import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { FIRM_TZ, appNow, isStatuteReminder, looksLikeCourt } from '../core/dates.js';
import { schema } from './db/index.js';
import { mirror } from './db/mirror.js';
import type { SyncWorker } from './sync/worker.js';
import type { ToolContext } from './tools/types.js';

/**
 * A health report on PAM's picture of the firm — WITHOUT the firm's data.
 *
 * Counts, percentages, and field coverage only: never a client name, a
 * matter number, a note, a subject line, or a figure. It answers the
 * questions that decide whether PAM is right on real data ("do tasks know
 * who they are assigned to?", "do matters carry a statute date?", "are the
 * firm's notes in a shape the settlement board can read?") so problems can
 * be found and fixed without anyone outside the firm reading a file.
 */

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`);

export async function buildDiag(ctx: ToolContext, worker: SyncWorker, extras: Record<string, unknown> = {}) {
  const now = appNow(ctx.fixedNowIso).setZone(FIRM_TZ);
  const [matters, tasks, events, staff, types] = [
    await mirror.matters(ctx.db),
    await mirror.tasks(ctx.db),
    await mirror.events(ctx.db),
    await mirror.staff(ctx.db),
    await mirror.typesInUse(ctx.db),
  ];
  const staffIds = new Set(staff.map((s) => s.id));
  const me = ctx.currentStaffId;
  const open = matters.filter((m) => m.status === 'Open');
  const openTasks = tasks.filter((t) => !t.isCompleted);
  const weekEnd = now.plus({ days: 7 }).toMillis();
  const upcoming = events.filter((e) => e.startMs >= now.startOf('day').toMillis() && e.startMs <= weekEnd);

  const count = async (q: ReturnType<typeof sql>) => Number(((await ctx.db.execute(q)).rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  const memoTotal = await count(sql`select count(*)::int as n from ${schema.memos}`);
  const memoLabelled = await count(sql`select count(*)::int as n from ${schema.memos} where ${schema.memos.text} ~* ${'(demand|offer)(ed)?\\s*(:|of|is|was|at)?\\s*\\$'}`);
  const memoSettlementTalk = await count(sql`select count(*)::int as n from ${schema.memos} where ${schema.memos.text} ~* ${'\\m(demand|offer|settle|adjuster|policy limit)'}`);
  const memoMatters = await count(sql`select count(distinct ${schema.memos.matterId})::int as n from ${schema.memos}`);
  const fileTotal = await count(sql`select count(*)::int as n from ${schema.files}`);
  const fileEmail = await count(sql`select count(*)::int as n from ${schema.files} where ${schema.files.emailFrom} is not null`);
  const fileMsg = await count(sql`select count(*)::int as n from ${schema.files} where ${schema.files.name} ~* ${'\\.(msg|eml)$'}`);
  const pkgFolders = await count(sql`select count(*)::int as n from ${schema.folders} where ${schema.folders.name} ~* ${'settlement'}`);
  const folderTotal = await count(sql`select count(*)::int as n from ${schema.folders}`);

  // Matter-type vocabulary in use (the firm's own category words, with counts).
  const categories: Record<string, number> = {};
  for (const m of open) {
    const c = types.get(m.matterTypeId)?.category ?? '(no type)';
    categories[c] = (categories[c] ?? 0) + 1;
  }

  let board: unknown = 'not built yet';
  try {
    if (ctx.smokeball) {
      const { getSettlementBoard } = await import('./settlement/engine.js');
      const b = await getSettlementBoard(ctx.db, ctx.smokeball, ctx.fixedNowIso, 1500);
      const byStatus: Record<string, number> = {};
      for (const s of b.summaries) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      board = {
        warming: b.warming,
        analyzed: `${b.done} of ${b.total}`,
        onBoard: b.summaries.length,
        byStatus,
        readFromFreeFormNotes: b.summaries.filter((s) => s.facts.interpreted?.length).length,
        withSentEvidence: b.summaries.filter((s) => s.packageSentDate).length,
      };
    }
  } catch (e) {
    board = `error: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
  }

  const known = (ids: string[]) => ids.filter((id) => staffIds.has(id)).length;
  const today = now.toISODate()!;
  const bucketOf = (t: (typeof openTasks)[number]) => (!t.dueDate ? 'noDueDate' : t.dueDate < today ? 'overdue' : t.dueDate === today ? 'dueToday' : 'upcoming');
  const mine = openTasks.filter((t) => t.assigneeIds.includes(me));
  const myBuckets: Record<string, number> = { overdue: 0, dueToday: 0, upcoming: 0, noDueDate: 0 };
  for (const t of mine) myBuckets[bucketOf(t)]!++;
  const injury = open.filter((m) => /injur|malpractice/i.test(types.get(m.matterTypeId)?.category ?? ''));
  const layoutsCursor = await count(sql`select count(*)::int as n from ${schema.syncState} where ${schema.syncState.recordType} = 'layouts'`);
  const taskAssignees = openTasks.flatMap((t) => t.assigneeIds);
  const eventAttendees = upcoming.flatMap((e) => e.attendeeIds);

  return {
    note: 'Counts and coverage only — no names, numbers, notes, or subjects.',
    at: now.toISO(),
    sync: { last: worker.lastSync, lastOkAt: worker.lastOkAt, progress: worker.progress, firstRun: worker.firstRun, lastWebhook: worker.lastWebhook },
    user: {
      resolvedInStaffList: staffIds.has(me),
      staffCount: staff.length,
      openTasksAssigned: mine.length,
      tasksByBucket: myBuckets,
      statuteRemindersAssigned: mine.filter((t) => isStatuteReminder(t.subject)).length,
      overdueNeedingDecision: mine.filter((t) => bucketOf(t) === 'overdue' && !isStatuteReminder(t.subject)).length,
      eventsNext7Days: upcoming.filter((e) => e.attendeeIds.includes(me)).length,
    },
    matters: {
      total: matters.length,
      open: open.length,
      // A company client has no first name, so this counts people only.
      withPersonClientName: pct(open.filter((m) => m.clientFirstName !== '').length, open.length),
      withStatuteDate: pct(open.filter((m) => m.statuteDate).length, open.length),
      withDateOfLoss: pct(open.filter((m) => m.dateOfLoss).length, open.length),
      inSuitKnown: pct(open.filter((m) => m.isInSuit !== null).length, open.length),
      withMatterType: pct(open.filter((m) => types.has(m.matterTypeId)).length, open.length),
      injuryMatters: {
        open: injury.length,
        withStatuteDate: pct(injury.filter((m) => m.statuteDate).length, injury.length),
        withDateOfLoss: pct(injury.filter((m) => m.dateOfLoss).length, injury.length),
        inSuitKnown: pct(injury.filter((m) => m.isInSuit !== null).length, injury.length),
      },
      // Custom fields are read from each matter's layouts; this is the one-time catch-up.
      customFieldCatchUp: worker.factsBackfill ?? (layoutsCursor > 0 ? 'done' : 'not started'),
      openByCategory: categories,
    },
    tasks: {
      open: openTasks.length,
      withDueDate: pct(openTasks.filter((t) => t.dueDate).length, openTasks.length),
      withMatter: pct(openTasks.filter((t) => t.matterId).length, openTasks.length),
      withAssignee: pct(openTasks.filter((t) => t.assigneeIds.length > 0).length, openTasks.length),
      assigneesFoundInStaffList: pct(known(taskAssignees), taskAssignees.length),
      statuteReminders: openTasks.filter((t) => isStatuteReminder(t.subject)).length,
      statuteRemindersWithoutDueDate: openTasks.filter((t) => !t.dueDate && isStatuteReminder(t.subject)).length,
      overdue: openTasks.filter((t) => t.dueDate && t.dueDate < now.toISODate()!).length,
    },
    calendar: {
      events: events.length,
      next7Days: upcoming.length,
      withAttendee: pct(upcoming.filter((e) => e.attendeeIds.length > 0).length, upcoming.length),
      attendeesFoundInStaffList: pct(known(eventAttendees), eventAttendees.length),
      withLocation: pct(upcoming.filter((e) => e.location).length, upcoming.length),
      looksLikeCourt: upcoming.filter((e) => looksLikeCourt(e.subject, e.location ?? undefined)).length,
      allDay: upcoming.filter((e) => e.allDay).length,
      earliest: events.length ? DateTime.fromMillis(Math.min(...events.map((e) => e.startMs))).toISODate() : null,
    },
    notes: {
      total: memoTotal,
      mattersWithNotes: memoMatters,
      mentionSettlement: memoSettlementTalk,
      labelledDemandOrOffer: memoLabelled,
    },
    documents: {
      folders: folderTotal,
      settlementFolders: pkgFolders,
      files: fileTotal,
      emailsWithSender: fileEmail,
      emailFilesByExtension: fileMsg,
    },
    settlementBoard: board,
    ...extras,
  };
}
