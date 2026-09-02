import { describe, expect, it } from 'vitest';
import {
  adaptContactName,
  adaptEvent,
  adaptFile,
  adaptFolders,
  adaptMatter,
  adaptMemo,
  adaptStaff,
  adaptTask,
  anyStampToIso,
  isoToTicks,
  ticksToIso,
  toEventDto,
  toTaskDto,
} from './adapt.js';

/** Fixtures follow the vendored spec's own examples for each DTO. */

describe('.NET ticks', () => {
  it('round-trips and matches the spec example magnitude', () => {
    const iso = '2022-04-23T14:00:00.000Z';
    expect(ticksToIso(isoToTicks(iso))).toBe(iso);
    expect(ticksToIso(637847425252027400)).toMatch(/^2022-04-/);
    expect(anyStampToIso('637847425252027400', 'x')).toMatch(/^2022-04-/);
    expect(anyStampToIso('2000-01-01T20:00:00', 'x')).toBe('2000-01-01T20:00:00.000Z'); // zone-less = UTC
    expect(anyStampToIso(undefined, 'fallback')).toBe('fallback');
  });
});

describe('adaptTask (real TaskDto → core)', () => {
  it('maps refs, dueDateOnly, ticks, and drops deleted rows', () => {
    const t = adaptTask({
      id: 't1',
      matter: { id: 'm1', href: '/matters/m1' },
      assignees: [{ id: 's1' }, { id: 's2' }],
      createdBy: { id: 's1' },
      subject: 'Review contract for John Smith',
      note: 'Contract needs to be reviewed',
      dueDate: '2020-02-15T13:00:00Z',
      dueDateOnly: '2020-02-16T00:00:00',
      isCompleted: false,
      createdDate: '2020-02-15T13:00:00Z',
      lastUpdated: 637847425252027400,
      isDeleted: false,
    })!;
    expect(t.matterId).toBe('m1');
    expect(t.assigneeIds).toEqual(['s1', 's2']);
    expect(t.dueDate).toBe('2020-02-16'); // dueDateOnly wins, date part only
    expect(t.createdById).toBe('s1');
    expect(t.updatedAt).toMatch(/^2022-04-/);
    expect(adaptTask({ id: 'x', isDeleted: true })).toBeNull();
  });
  it('passes core-shaped rows through untouched', () => {
    const core = { id: 't', subject: 's', assigneeIds: ['a'], isCompleted: false, createdById: 'a', createdAt: 'c', updatedAt: 'u' };
    expect(adaptTask(core)).toBe(core);
  });
});

describe('adaptEvent', () => {
  it('makes zone-less local times absolute in the event timeZone', () => {
    const e = adaptEvent({
      id: 'e1',
      matter: { id: 'm1' },
      attendees: [{ id: 's1' }],
      subject: 'Deposition',
      startTime: '2026-09-03T10:00:00',
      endTime: '2026-09-03T11:30:00',
      timeZone: 'America/New_York',
      lastUpdated: '2026-09-01T12:00:00',
      type: 'Normal',
      isDeleted: false,
    })!;
    expect(e.startTime).toBe('2026-09-03T10:00:00.000-04:00');
    expect(e.endTime).toBe('2026-09-03T11:30:00.000-04:00');
    expect(e.attendeeIds).toEqual(['s1']);
    expect(e.matterId).toBe('m1');
    expect(e.onOfficeCalendar).toBe(false);
  });
});

describe('adaptMatter + contacts', () => {
  it('keeps client contact refs for resolution and uses the title meanwhile', () => {
    const m = adaptMatter({
      id: 'm1',
      number: 'FUS-124',
      title: 'Smith - Personal Injury',
      status: 'Open',
      matterType: { id: 'mt1' },
      clients: [{ id: 'c1' }],
      openedDate: '2022-04-23T14:00:00Z',
      versionId: '637771038395217729',
      description: 'Rear-end collision',
      items: { statuteDate: '2027-01-15T00:00:00' },
    })!;
    expect(m.clientContactIds).toEqual(['c1']);
    expect(m.clientLastName).toBe('Smith - Personal Injury');
    expect(m.matterTypeId).toBe('mt1');
    expect(m.statuteDate).toBe('2027-01-15');
    expect(m.updatedAt).toMatch(/^2022-01/); // versionId ticks
    expect(adaptContactName({ person: { firstName: 'Peter', lastName: 'Grasso' } })).toEqual({ firstName: 'Peter', lastName: 'Grasso' });
    expect(adaptContactName({ company: { name: 'Apex Mutual' } })).toEqual({ firstName: '', lastName: 'Apex Mutual' });
    expect(adaptContactName({})).toBeNull();
  });
});

describe('adaptMemo', () => {
  it('prefers plainText, strips RTF otherwise, and maps user ids to staff', () => {
    const map = (u: string) => (u === 'user-1' ? 's1' : u);
    const a = adaptMemo({ id: 'n1', matterId: 'm1', plainText: 'Demand: $250,000', text: '{\\rtf1 junk}', createdByUserId: 'user-1', createdDate: '2026-08-01T00:00:00Z', lastUpdated: '2026-08-02T00:00:00Z' }, map)!;
    expect(a.text).toBe('Demand: $250,000');
    expect(a.createdById).toBe('s1');
    expect(a.updatedById).toBe('s1');
    const b = adaptMemo({ id: 'n2', matterId: 'm1', text: '{\\rtf1\\ansi{\\fonttbl{\\f0 Calibri;}}\\pard Offer: $110,000 made 2026-08-15 by Jane Doe\\par}', createdByUserId: 'user-9', createdDate: '2026-08-01T00:00:00Z' }, map)!;
    expect(b.text).toContain('Offer: $110,000 made 2026-08-15 by Jane Doe');
    expect(b.text).not.toContain('\\rtf');
  });
});

describe('files + folders', () => {
  it('joins fileExtension onto the name, maps folder/matter refs, flattens folder trees', () => {
    const f = adaptFile({ id: 'f1', name: 'Settlement Package', fileExtension: '.pdf', folder: { id: 'fo1' }, matter: { id: 'm1' }, from: 'jeff@pmlawny.com', to: 'adj@ins.com', dateCreated: '2026-07-01T00:00:00Z', sizeBytes: 1234, downloadInfo: { id: 'f1' } }, 'm1')!;
    expect(f.name).toBe('Settlement Package.pdf');
    expect(f.folderId).toBe('fo1');
    expect(f.from).toBe('jeff@pmlawny.com');
    const folders = adaptFolders(
      [{ id: 'root', folders: [{ id: 'a', name: 'Correspondence' }, { id: 'b', name: 'Settlement Package', folders: [{ id: 'c', name: 'Drafts' }] }], files: [] }],
      'm1',
    );
    expect(folders.map((x) => [x.id, x.name, x.parentId])).toEqual([
      ['a', 'Correspondence', 'root'],
      ['b', 'Settlement Package', 'root'],
      ['c', 'Drafts', 'b'],
    ]);
  });
});

describe('write DTOs', () => {
  it('encodes tasks with staffId + dueDateOnly and events with local times + timeZone', () => {
    expect(toTaskDto({ subject: 'Call adjuster', dueDate: '2026-09-05', assigneeIds: ['s1'], matterId: 'm1' }, 's1')).toEqual({
      staffId: 's1', subject: 'Call adjuster', matterId: 'm1', assigneeIds: ['s1'], dueDateOnly: '2026-09-05T00:00:00',
    });
    const ev = toEventDto({ subject: 'Call', startTime: '2026-09-03T14:00:00.000Z', endTime: '2026-09-03T15:00:00.000Z', timeZone: 'America/New_York', attendeeIds: ['s1'] });
    expect(ev).toMatchObject({ type: 'Normal', subject: 'Call', startTime: '2026-09-03T10:00:00', endTime: '2026-09-03T11:00:00', timeZone: 'America/New_York', attendees: ['s1'] });
  });
  it('staff adapter derives initials and tolerates sparse rows', () => {
    expect(adaptStaff({ id: 's', firstName: 'Jeffrey', lastName: 'Millman' })!.initials).toBe('JM');
    expect(adaptStaff({ id: 's', isDeleted: true })).toBeNull();
  });
});
