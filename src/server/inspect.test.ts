import { describe, expect, it } from 'vitest';
import { shapeOf } from './inspect.js';
import { looksLikeCourt } from '../core/dates.js';

describe('shapeOf (keys only, never values)', () => {
  it('replaces every primitive with a type name and keeps structure', () => {
    const shape = shapeOf({
      id: 'b471682e',
      number: 'FUS-124',
      title: 'Smith v. Jones',
      openedDate: '2022-04-23T14:00:00Z',
      versionId: '637771038395217729',
      lastUpdated: 637847425252027400,
      isLead: false,
      clients: [{ id: 'c1', href: '/x' }],
      items: { dateOfLoss: '2024-01-02T00:00:00', StatuteOfLimitations: '2027-01-02T00:00:00', nested: { deep: 1 } },
      nothing: null,
    });
    expect(shape).toEqual({
      id: 'string',
      number: 'string',
      title: 'string',
      openedDate: 'date-string',
      versionId: 'ticks-string',
      lastUpdated: 'ticks',
      isLead: 'boolean',
      clients: [{ id: 'string', href: 'string' }],
      items: { dateOfLoss: 'date-string', StatuteOfLimitations: 'date-string', nested: { deep: 'number' } },
      nothing: 'null',
    });
    expect(JSON.stringify(shape)).not.toContain('Smith');
    expect(JSON.stringify(shape)).not.toContain('FUS');
  });
});

describe('looksLikeCourt (court list without an office-calendar flag)', () => {
  it('reads court appearances from subject/location', () => {
    expect(looksLikeCourt('JTM Hector Vasquez Town of Clarkstown Justice Court Judge Kafinas')).toBe(true);
    expect(looksLikeCourt('Compliance conference', null)).toBe(true);
    expect(looksLikeCourt('Status', 'Rockland County Supreme Court, Part 12')).toBe(true);
    expect(looksLikeCourt('Sentencing - People v. Doe')).toBe(true);
    expect(looksLikeCourt('Call with Frank re Tran settlement posture')).toBe(false);
    expect(looksLikeCourt('Deposition - Tran v. Northline - defense counsel offices')).toBe(false);
  });
});
