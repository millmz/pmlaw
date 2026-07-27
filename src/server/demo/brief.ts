import { runTool, type ToolContext } from '../tools/read-tools.js';

/**
 * Deterministic morning brief, composed straight from the tool layer in
 * Jeff's order (docs/08 §1): today's calendar → week ahead → due today →
 * overdue split into needs-decision and statute reminders. No LLM involved —
 * this is the walking-skeleton proof and the future scheduled-brief backbone.
 */

interface EventRow {
  start: string;
  end: string;
  subject: string;
  location?: string | null;
  matter: string | null;
}
interface TaskRow {
  subject: string;
  dueDate?: string | null;
  daysOverdue: number;
  matter: string | null;
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });

export async function composeMorningBrief(ctx: ToolContext): Promise<{ text: string; citationCount: number }> {
  const today = await runTool(ctx, 'get_calendar_events', { scope: 'today' });
  const week = await runTool(ctx, 'get_calendar_events', { scope: 'this_week' });
  const dueToday = await runTool(ctx, 'get_tasks', { status: 'due_today' });
  const overdue = await runTool(ctx, 'get_tasks', { status: 'overdue' });

  const t = today.data as { events: EventRow[] };
  const w = week.data as { events: EventRow[] };
  const dt = dueToday.data as { tasks: TaskRow[] };
  const od = overdue.data as {
    needsDecision: TaskRow[];
    statuteReminders: { tasks: TaskRow[] };
  };

  const lines: string[] = [];
  lines.push('— TODAY —');
  if (t.events.length === 0) lines.push('No events on your calendar today.');
  for (const e of t.events) {
    lines.push(
      `${fmtTime(e.start)}–${fmtTime(e.end)}  ${e.subject}${e.location ? ` · ${e.location}` : ''}${e.matter ? `  [${e.matter}]` : ''}`,
    );
  }

  const laterThisWeek = w.events.filter((e) => !t.events.some((te) => te.subject === e.subject && te.start === e.start));
  lines.push('', '— REST OF THE WEEK —');
  if (laterThisWeek.length === 0) lines.push('Nothing further scheduled this week.');
  for (const e of laterThisWeek) {
    const day = new Date(e.start).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    lines.push(`${day} ${fmtTime(e.start)}  ${e.subject}${e.matter ? `  [${e.matter}]` : ''}`);
  }

  lines.push('', '— DUE TODAY —');
  if (dt.tasks.length === 0) lines.push('Nothing due today.');
  for (const task of dt.tasks) lines.push(`• ${task.subject}${task.matter ? `  [${task.matter}]` : ''}`);

  lines.push('', '— OVERDUE, NEEDS A DECISION (oldest first) —');
  if (od.needsDecision.length === 0) lines.push('Clean — nothing waiting on you.');
  for (const task of od.needsDecision) {
    lines.push(`• ${task.subject} — ${task.daysOverdue} days past due${task.matter ? `  [${task.matter}]` : ''}`);
  }

  lines.push('', '— STATUTE REMINDERS (tracked, leave as-is) —');
  if (od.statuteReminders.tasks.length === 0) lines.push('None pending.');
  for (const task of od.statuteReminders.tasks) {
    lines.push(`• ${task.subject}${task.matter ? `  [${task.matter}]` : ''}`);
  }

  const citationCount =
    today.citations.length + week.citations.length + dueToday.citations.length + overdue.citations.length;
  lines.push('', `Sources: ${citationCount} Smokeball records · data as of ${today.asOf}`);

  return { text: lines.join('\n'), citationCount };
}
