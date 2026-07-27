import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from './golden.js';
import { classifyTask, FIRM_TZ, isStatuteReminder, splitOverdue } from './dates.js';

const now = DateTime.fromISO(GOLDEN_ANCHOR_ISO, { zone: FIRM_TZ });
const data = buildGoldenDataset();

describe('golden dataset invariants', () => {
  it('contains every settlement evidence case', () => {
    const emailFiles = data.files.filter((f) => f.from !== undefined);
    // Attachment case
    expect(
      emailFiles.some((f) => f.matterId === 'm-grasso' && /attachment: settlement package/i.test(f.content ?? '')),
    ).toBe(true);
    // Dropbox case: link present, no "Attachment:" marker
    const fontana = emailFiles.find((f) => f.matterId === 'm-fontana');
    expect(fontana?.content).toMatch(/dropbox\.com/);
    expect(fontana?.content).not.toMatch(/attachment:/i);
    // Mail-only: package doc exists, zero email files
    expect(data.files.some((f) => f.matterId === 'm-ricci' && /settlement package/i.test(f.name))).toBe(true);
    expect(emailFiles.filter((f) => f.matterId === 'm-ricci')).toHaveLength(0);
    // Trap: prepared, not sent, and no open follow-up task
    expect(data.files.some((f) => f.matterId === 'm-bailey' && /settlement package/i.test(f.name))).toBe(true);
    expect(emailFiles.filter((f) => f.matterId === 'm-bailey')).toHaveLength(0);
    expect(data.tasks.filter((t) => t.matterId === 'm-bailey' && !t.isCompleted)).toHaveLength(0);
  });

  it('has the lien case with a searchable lien file', () => {
    const lien = data.files.find((f) => f.matterId === 'm-okafor' && /lien/i.test(f.name));
    expect(lien?.content).toMatch(/\$97,000/);
  });

  it('statute reminders on Petrov follow the 6/3/1 pattern and are detected', () => {
    const petrov = data.tasks.filter((t) => t.matterId === 'm-petrov');
    expect(petrov).toHaveLength(3);
    for (const t of petrov) expect(isStatuteReminder(t.subject)).toBe(true);
    // The 6-month reminder sits overdue — and must be split out, not actionable.
    const overdue = petrov.filter((t) => classifyTask(t, now) === 'overdue');
    expect(overdue).toHaveLength(1);
    const { statuteReminders, needsDecision } = splitOverdue(overdue);
    expect(statuteReminders).toHaveLength(1);
    expect(needsDecision).toHaveLength(0);
  });

  it("Jeff's overdue box matches his real-world shape: real work + statute noise", () => {
    const jeffOverdue = data.tasks.filter(
      (t) => t.assigneeIds.includes('s-jeff') && classifyTask(t, now) === 'overdue',
    );
    const { statuteReminders, needsDecision } = splitOverdue(jeffOverdue);
    expect(needsDecision.length).toBe(2); // Grasso call + authorizations
    expect(statuteReminders.length).toBe(1); // Petrov 6-month
  });

  it('completed tasks never classify as active', () => {
    for (const t of data.tasks.filter((t) => t.isCompleted)) {
      expect(classifyTask(t, now)).toBe('completed');
    }
  });

  it('has the ambiguity pair sharing a first name', () => {
    const juans = data.matters.filter((m) => m.clientFirstName === 'Juan' && m.status === 'Open');
    expect(juans.length).toBe(2);
    expect(new Set(juans.map((m) => m.clientLastName)).size).toBe(2);
  });

  it('stalled matter has no future task or event; closed matter is closed', () => {
    const whitTasks = data.tasks.filter((t) => t.matterId === 'm-whitfield' && !t.isCompleted);
    const whitEvents = data.events.filter(
      (e) => e.matterId === 'm-whitfield' && DateTime.fromISO(e.startTime) > now,
    );
    expect(whitTasks).toHaveLength(0);
    expect(whitEvents).toHaveLength(0);
    expect(data.matters.find((m) => m.id === 'm-marino')?.status).toBe('Closed');
  });

  it('today has three events for Jeff and one for Frank', () => {
    const today = data.events.filter((e) => {
      const d = DateTime.fromISO(e.startTime, { zone: FIRM_TZ });
      return d.hasSame(now, 'day');
    });
    expect(today.filter((e) => e.attendeeIds.includes('s-jeff'))).toHaveLength(3);
    expect(today.filter((e) => e.attendeeIds.includes('s-frank') && !e.attendeeIds.includes('s-jeff'))).toHaveLength(1);
  });

  it('next week Mon–Fri contains three court events including a shared JTM/FJP diary', () => {
    const nextMon = now.startOf('week').plus({ weeks: 1 });
    const nextFri = nextMon.plus({ days: 4 }).endOf('day');
    const nextWeek = data.events.filter((e) => {
      const d = DateTime.fromISO(e.startTime, { zone: FIRM_TZ });
      return d >= nextMon && d <= nextFri;
    });
    expect(nextWeek).toHaveLength(3);
    const shared = nextWeek.find((e) => e.subject.startsWith('JTM/FJP'));
    expect(shared?.attendeeIds.sort()).toEqual(['s-frank', 's-jeff']);
  });

  it('conflicting policy limits exist for Keller (memo 100k vs email 250k)', () => {
    const memo = data.memos.find((m) => m.matterId === 'm-keller');
    expect(memo?.text).toMatch(/\$100,000/);
    const email = data.files.find((f) => f.matterId === 'm-keller' && f.from !== undefined);
    expect(email?.content).toMatch(/\$250,000/);
  });

  it("who's-negotiating case: Hughes settlement memo last touched by Isabel", () => {
    const memo = data.memos.find((m) => m.matterId === 'm-hughes');
    expect(memo?.updatedById).toBe('s-isabel');
  });

  it('every task assignee and matter reference resolves', () => {
    const staffIds = new Set(data.staff.map((s) => s.id));
    const matterIds = new Set(data.matters.map((m) => m.id));
    for (const t of data.tasks) {
      for (const a of t.assigneeIds) expect(staffIds.has(a)).toBe(true);
      if (t.matterId) expect(matterIds.has(t.matterId)).toBe(true);
    }
    for (const e of data.events) {
      for (const a of e.attendeeIds) expect(staffIds.has(a)).toBe(true);
      if (e.matterId) expect(matterIds.has(e.matterId)).toBe(true);
    }
  });
});
