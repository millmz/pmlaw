import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { FIRM_TZ, isStatuteReminder } from '../../core/dates.js';
import { schema } from '../db/index.js';
import { cite } from './citations.js';
import type { ToolDef } from './types.js';

/**
 * The first write action (docs/03 confirmation flow, scoped to one verb):
 * task rescheduling. propose → user confirms in conversation → execute with
 * a single-use token → VERIFY against the live API before reporting done.
 *
 * Statute-of-limitations tasks are never movable — the guard refuses with an
 * explanation, mechanically, regardless of what the model asks for.
 */

const TOKEN_TTL_MS = 5 * 60 * 1000;

const proposeSchema = z.object({
  taskQuery: z.string().describe('Task id, or a fragment of the task subject / client name to find it.'),
  newDueDate: z.string().describe('New due date, ISO format YYYY-MM-DD.'),
  reason: z.string().optional().describe("The user's stated reason, if any — recorded in the audit log."),
});

const proposeTaskReschedule: ToolDef = {
  name: 'propose_task_reschedule',
  description:
    'Step 1 of moving a task. Finds the task, checks it is safely movable (statute-of-limitations reminders are NEVER movable), and returns a confirmation card + token. Present the card to the user and call execute_task_reschedule ONLY after they explicitly confirm in this conversation. If several tasks match, candidates are returned — ask the user to pick.',
  paramsSchema: proposeSchema,
  run: async (ctx, raw) => {
    const p = proposeSchema.parse(raw);
    const asOf = new Date().toISOString();
    const due = DateTime.fromISO(p.newDueDate, { zone: FIRM_TZ });
    if (!due.isValid) {
      return { data: { error: `"${p.newDueDate}" is not a valid date — use YYYY-MM-DD.` }, citations: [], asOf };
    }

    const all = (await ctx.db.select().from(schema.tasks)).filter((t) => !t.isCompleted);
    const q = p.taskQuery.toLowerCase();
    let hits = all.filter((t) => t.id === p.taskQuery);
    if (hits.length === 0) hits = all.filter((t) => t.subject.toLowerCase().includes(q));
    if (hits.length === 0) {
      // Fall back to client-name matching via the task's matter.
      const matters = await ctx.db.select().from(schema.matters);
      const matterIds = matters
        .filter((m) => `${m.clientFirstName} ${m.clientLastName}`.toLowerCase().includes(q))
        .map((m) => m.id);
      hits = all.filter((t) => t.matterId && matterIds.includes(t.matterId));
    }

    if (hits.length === 0) {
      return { data: { error: `No open task matches "${p.taskQuery}".` }, citations: [], asOf };
    }
    if (hits.length > 1) {
      return {
        data: {
          ambiguous: true,
          note: 'Several tasks match — ask the user which one.',
          candidates: hits.slice(0, 6).map((t) => ({ id: t.id, subject: t.subject, dueDate: t.dueDate })),
        },
        citations: hits.slice(0, 6).map((t) => cite('task', t.id, `Task: ${t.subject}`)),
        asOf,
      };
    }

    const task = hits[0]!;
    if (isStatuteReminder(task.subject)) {
      await ctx.db.insert(schema.auditLog).values({
        actor: ctx.currentStaffId,
        action: 'write:task_reschedule:REFUSED_STATUTE',
        params: { taskId: task.id, newDueDate: p.newDueDate },
        result: 'refused — statute reminder',
      });
      return {
        data: {
          refused: true,
          reason:
            `"${task.subject}" is a statute-of-limitations reminder. These are never rescheduled — that's how cases get destroyed. ` +
            'If the statute date itself is wrong, it must be corrected in Smokeball directly with attorney review.',
        },
        citations: [cite('task', task.id, `Task: ${task.subject}`)],
        asOf,
      };
    }

    const token = randomUUID();
    ctx.confirmations ??= new Map();
    ctx.confirmations.set(token, {
      action: 'task_reschedule',
      taskId: task.id,
      matterId: task.matterId ?? undefined,
      taskSubject: task.subject,
      oldDueDate: task.dueDate ?? undefined,
      newDueDate: p.newDueDate,
      reason: p.reason,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    return {
      data: {
        confirmationRequired: true,
        confirmationToken: token,
        card: {
          action: 'Reschedule task',
          task: task.subject,
          from: task.dueDate ?? 'no due date',
          to: p.newDueDate,
          note: 'Nothing changes in Smokeball until the user confirms.',
        },
      },
      citations: [cite('task', task.id, `Task: ${task.subject}`)],
      asOf,
    };
  },
};

const executeSchema = z.object({
  confirmationToken: z.string().describe('Token from propose_task_reschedule, after the user explicitly confirmed.'),
});

const executeTaskReschedule: ToolDef = {
  name: 'execute_task_reschedule',
  description:
    'Step 2 of moving a task — call ONLY after the user explicitly confirmed the proposed card in this conversation. Executes the change in Smokeball, verifies it landed (writes are asynchronous), and reports the verified result.',
  paramsSchema: executeSchema,
  run: async (ctx, raw) => {
    const p = executeSchema.parse(raw);
    const asOf = new Date().toISOString();
    const pending = ctx.confirmations?.get(p.confirmationToken);
    if (!pending || pending.expiresAt < Date.now() || pending.action !== 'task_reschedule') {
      ctx.confirmations?.delete(p.confirmationToken);
      return {
        data: { error: 'That confirmation has expired or was already used — propose the change again.' },
        citations: [],
        asOf,
      };
    }
    ctx.confirmations!.delete(p.confirmationToken); // single-use
    if (!ctx.smokeball) throw new Error('writes unavailable: no Smokeball connection');

    await ctx.smokeball.updateTask(pending.taskId, { dueDate: pending.newDueDate }, ctx.currentStaffId);

    // VERIFY: Smokeball writes are async (docs/02) — poll until the change is
    // visible in the API before telling the user it happened.
    let verified = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const tasks = pending.matterId
        ? await ctx.smokeball.listTasks({ matterId: pending.matterId })
        : await ctx.smokeball.listTasks();
      const t = tasks.find((t) => t.id === pending.taskId);
      if (t?.dueDate === pending.newDueDate) {
        verified = true;
        break;
      }
    }

    if (verified) {
      await ctx.db
        .update(schema.tasks)
        .set({ dueDate: pending.newDueDate, updatedAt: new Date().toISOString() })
        .where(eq(schema.tasks.id, pending.taskId));
    }

    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'write:task_reschedule',
      params: {
        taskId: pending.taskId,
        from: pending.oldDueDate ?? null,
        to: pending.newDueDate,
        reason: pending.reason ?? null,
      },
      result: verified ? 'executed and verified' : 'submitted but NOT verified',
    });

    return {
      data: verified
        ? {
            done: true,
            summary: `"${pending.taskSubject}" moved from ${pending.oldDueDate ?? 'no due date'} to ${pending.newDueDate} — verified in Smokeball.`,
          }
        : {
            done: false,
            warning:
              'The change was submitted but could not be verified in Smokeball yet. Tell the user to double-check before relying on it.',
          },
      citations: [cite('task', pending.taskId, `Task: ${pending.taskSubject}`)],
      asOf,
    };
  },
};

export const WRITE_TOOLS: ToolDef[] = [proposeTaskReschedule, executeTaskReschedule];
