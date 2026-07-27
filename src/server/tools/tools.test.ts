import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { runTool, validateCitations, type ToolContext } from './read-tools.js';

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let ctx: ToolContext;

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 200 });
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
  await new SyncWorker(db, client).fullSync();
  ctx = { db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO };
});

afterAll(async () => {
  await mock.close();
  await closeDb();
});

describe('read tools', () => {
  it("today's calendar: Jeff sees his 3 events in order, not Frank's", async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'today' });
    const d = r.data as { events: { subject: string }[]; calendar: string };
    expect(d.calendar).toContain('Jeff Millman');
    expect(d.events).toHaveLength(3);
    expect(d.events[0]!.subject).toContain('Clarkstown');
    expect(d.events.map((e) => e.subject).join(' ')).not.toContain('FJP Rockland Supreme');
    expect(r.citations.length).toBe(3);
    expect((await validateCitations(db, r.citations)).valid).toBe(true);
  });

  it("Frank's calendar by name resolves and scopes correctly", async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'today', staffRef: 'Frank' });
    const d = r.data as { events: { subject: string }[] };
    expect(d.events).toHaveLength(1);
    expect(d.events[0]!.subject).toContain('Keller');
  });

  it('next-week court list returns all three including the shared JTM/FJP diary', async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'next_week_courts', officeCalendar: true });
    const d = r.data as { events: { subject: string }[] };
    expect(d.events).toHaveLength(3);
    expect(d.events.some((e) => e.subject.startsWith('JTM/FJP'))).toBe(true);
  });

  it('overdue tasks split statute reminders from needs-decision, oldest first', async () => {
    const r = await runTool(ctx, 'get_tasks', { status: 'overdue' });
    const d = r.data as {
      needsDecision: { subject: string; daysOverdue: number }[];
      statuteReminders: { note: string; tasks: { subject: string }[] };
    };
    expect(d.needsDecision).toHaveLength(2);
    expect(d.needsDecision[0]!.subject).toContain('Call adjuster'); // 22 days > 9 days
    expect(d.needsDecision[0]!.daysOverdue).toBe(22);
    expect(d.statuteReminders.tasks).toHaveLength(1);
    expect(d.statuteReminders.note).toContain('never be rescheduled');
  });

  it('due-today excludes completed tasks and other assignees', async () => {
    const r = await runTool(ctx, 'get_tasks', { status: 'due_today' });
    const d = r.data as { tasks: { subject: string }[] };
    expect(d.tasks).toHaveLength(3);
    for (const t of d.tasks) expect(t.subject).not.toContain('Serve discovery'); // completed
  });

  it('matter search by shared first name flags ambiguity with both candidates', async () => {
    const r = await runTool(ctx, 'search_matters', { clientName: 'Juan' });
    const d = r.data as { ambiguous: boolean; matters: { label: string }[] };
    expect(d.ambiguous).toBe(true);
    expect(d.matters).toHaveLength(2);
  });

  it('matter search excludes closed matters by default but finds them on request', async () => {
    const open = await runTool(ctx, 'search_matters', { practiceArea: 'Personal Injury' });
    expect((open.data as { matters: { label: string }[] }).matters.every((m) => !m.label.includes('Marino'))).toBe(true);
    const any = await runTool(ctx, 'search_matters', { clientName: 'Marino', status: 'any' });
    expect((any.data as { count: number }).count).toBe(1);
  });

  it('matter overview surfaces notes verbatim with author attribution', async () => {
    const r = await runTool(ctx, 'get_matter_overview', { matterId: 'm-grasso' });
    const d = r.data as { notes: { text: string; lastEditedBy: string }[]; filesByFolder: Record<string, unknown[]> };
    expect(d.notes[0]!.text).toContain('Demand: $250,000');
    expect(d.notes[0]!.text).toContain('Offer: $110,000');
    expect(d.notes[0]!.lastEditedBy).toContain('Jeff Millman');
    expect(d.filesByFolder['Settlement Package']).toHaveLength(1);
    expect(r.citations.some((c) => c.kind === 'memo')).toBe(true);
  });

  it("who's-negotiating attribution: Hughes note credits Isabel", async () => {
    const r = await runTool(ctx, 'get_matter_overview', { matterId: 'm-hughes' });
    const d = r.data as { notes: { lastEditedBy: string }[] };
    expect(d.notes[0]!.lastEditedBy).toContain('Isabel');
  });

  it('stalled matters finds Whitfield, Bailey, and Ricci — and nothing else', async () => {
    const r = await runTool(ctx, 'find_stalled_matters', {});
    const d = r.data as { matters: { label: string }[] };
    const labels = d.matters.map((m) => m.label).join(' ');
    expect(labels).toContain('Whitfield'); // the designed stalled case
    expect(labels).toContain('Bailey'); // prepared-not-sent trap: no follow-up task either
    expect(labels).toContain('Ricci'); // mailed 45 days ago, follow-up completed, nothing since
    expect(d.matters).toHaveLength(3);
  });

  it('unknown staff reference returns a clarification, not a guess', async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'today', staffRef: 'Bartholomew' });
    expect((r.data as { error: string }).error).toContain('No staff member matches');
    expect(r.citations).toHaveLength(0);
  });

  it('every tool call lands in the audit log', async () => {
    const { schema } = await import('../db/index.js');
    const rows = await db.select().from(schema.auditLog);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.every((r) => r.actor === 's-jeff')).toBe(true);
  });

  it('citation validator catches a fabricated record id', async () => {
    const { valid, missing } = await validateCitations(db, [
      { kind: 'matter', id: 'm-nonexistent', label: 'Fabricated' },
    ]);
    expect(valid).toBe(false);
    expect(missing).toHaveLength(1);
  });
});
