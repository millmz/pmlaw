import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { runTool, validateCitations } from './registry.js';
import type { ToolContext } from './types.js';

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
  it("today's calendar: Jeff sees his 6 events in order, not Frank's", async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'today' });
    const d = r.data as { events: { subject: string }[]; calendar: string };
    expect(d.calendar).toContain('Jeff Millman');
    expect(d.events).toHaveLength(6);
    expect(d.events[0]!.subject).toContain('Clarkstown');
    expect(d.events.map((e) => e.subject).join(' ')).not.toContain('FJP Rockland Supreme');
    expect(r.citations.length).toBe(6);
    expect((await validateCitations(db, r.citations)).valid).toBe(true);
  });

  it("Frank's calendar by name resolves and scopes correctly", async () => {
    const r = await runTool(ctx, 'get_calendar_events', { scope: 'today', staffRef: 'Frank' });
    const d = r.data as { events: { subject: string }[] };
    // Frank's own Keller conference + the shared Jeff/Frank Tran call.
    expect(d.events).toHaveLength(2);
    expect(d.events.map((e) => e.subject).join(' ')).toContain('Keller');
    expect(d.events.map((e) => e.subject).join(' ')).not.toContain('Clarkstown');
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

  it('due-today excludes completed tasks and other assignees, at real density', async () => {
    const r = await runTool(ctx, 'get_tasks', { status: 'due_today' });
    const d = r.data as { tasks: { subject: string }[] };
    expect(d.tasks).toHaveLength(11);
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

  it('stalled matters finds Whitfield and Bailey — and nothing else', async () => {
    const r = await runTool(ctx, 'find_stalled_matters', {});
    const d = r.data as { matters: { label: string }[] };
    const labels = d.matters.map((m) => m.label).join(' ');
    expect(labels).toContain('Whitfield'); // the designed stalled case
    expect(labels).toContain('Bailey'); // prepared-not-sent trap: no follow-up task either
    // Ricci is no longer stalled: the lien-ledger review task (due today) is open on it.
    expect(d.matters).toHaveLength(2);
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

describe('voice: a misheard client name still finds the file', () => {
  it('offers the closest client when nothing is spelled that way, and says so', async () => {
    const r = await runTool(ctx, 'search_matters', { clientName: 'grass oh' });
    const d = r.data as { count: number; closeMatch?: boolean; note?: string; matters: { label: string }[] };
    expect(d.closeMatch).toBe(true);
    expect(d.matters[0]!.label).toContain('Grasso');
    expect(d.note).toMatch(/closest names/);
    const none = await runTool(ctx, 'search_matters', { clientName: 'Zzyzx' });
    expect((none.data as { count: number }).count).toBe(0);
  });
});

describe('firm-scale results are cut to a page, with the true totals', () => {
  it('get_tasks: rows are capped per bucket, totals are whole, undated statute reminders are only counted', async () => {
    const all = await runTool(ctx, 'get_tasks', { status: 'all_open', limit: 5000 });
    const full = all.data as { totals: Record<string, number>; dueToday: unknown[]; noDueDate: { total: number; statuteReminders: number; tasks: unknown[] } };
    expect(full.dueToday.length).toBe(full.totals['dueToday']);
    const cut = await runTool(ctx, 'get_tasks', { status: 'all_open', limit: 3 });
    const d = cut.data as typeof full & { dueTodayNote?: string };
    expect(d.dueToday).toHaveLength(3);
    expect(d.totals['dueToday']).toBe(full.totals['dueToday']);
    expect(d.dueTodayNote).toMatch(/first 3 of/);
    expect(d.noDueDate.tasks.length).toBeLessThanOrEqual(3);
    expect(cut.citations.length).toBeLessThanOrEqual(12); // only what is shown is cited
    expect((await validateCitations(db, cut.citations)).valid).toBe(true);
  });
  it('search_matters: a broad search returns a page and says how many there are', async () => {
    const r = await runTool(ctx, 'search_matters', { limit: 4 });
    const d = r.data as { count: number; showing?: number; note?: string; matters: unknown[] };
    expect(d.matters).toHaveLength(4);
    expect(d.count).toBeGreaterThan(4);
    expect(d.showing).toBe(4);
    expect(d.note).toMatch(/first 4 of/);
    expect(r.citations).toHaveLength(4);
  });
  it('get_matter_overview: lists the newest files and counts the rest by folder', async () => {
    const whole = (await runTool(ctx, 'get_matter_overview', { matterId: 'm-grasso' })).data as { filesByFolder: Record<string, unknown[]>; fileCounts: Record<string, number> };
    const total = Object.values(whole.filesByFolder).reduce((n, f) => n + f.length, 0);
    expect(Object.values(whole.fileCounts).reduce((a, b) => a + b, 0)).toBe(total);
    const cut = (await runTool(ctx, 'get_matter_overview', { matterId: 'm-grasso', fileLimit: 1 })).data as typeof whole & { filesNote?: string };
    expect(Object.values(cut.filesByFolder).reduce((n, f) => n + f.length, 0)).toBe(1);
    expect(cut.filesNote).toMatch(/newest/);
    expect(Object.values(cut.fileCounts).reduce((a, b) => a + b, 0)).toBe(total);
  });
  it('custom fields arrive from layouts: the synced matter carries its statute date and date of loss', async () => {
    const m = (await runTool(ctx, 'get_matter_overview', { matterId: 'm-grasso' })).data as { matter: { statuteDate?: string | null; dateOfLoss?: string | null } };
    expect(m.matter.statuteDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.matter.dateOfLoss).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
