import { DateTime } from 'luxon';
import type { CalendarEvent, FileRecord, Folder, Matter, MatterType, Memo, Staff, Task } from '../../core/types.js';
import { isoToTicks } from '../adapt.js';

/**
 * Core → real wire shape, so the mock answers with exactly what
 * api.smokeball.com answers with (per vendor/smokeball-openapi.json) and every
 * test drives the adapter layer. The golden dataset stays in core types.
 */

const ref = (id: string) => ({ id, href: `/ref/${id}`, relation: 'related', method: 'GET' });
const base = (id: string) => ({ id, href: `/${id}`, relation: 'self', method: 'GET', isDeleted: false });

export const contactIdFor = (matterId: string) => `contact-${matterId}`;
export const userIdFor = (staffId: string) => `user-${staffId}`;

export const staffToDto = (s: Staff) => ({
  ...base(s.id),
  firstName: s.firstName,
  lastName: s.lastName,
  initials: s.initials,
  email: s.email,
  role: s.role,
  userId: userIdFor(s.id),
  enabled: true,
  former: false,
  lastUpdated: s.updatedAt,
});

export const matterTypeToDto = (t: MatterType) => ({
  ...base(t.id),
  name: t.name,
  category: t.category,
  location: t.location,
  type: 0,
});

export const matterToDto = (m: Matter) => ({
  ...base(m.id),
  number: m.number,
  title: `${m.clientLastName}, ${m.clientFirstName} - ${m.description}`,
  description: m.description,
  status: m.status,
  matterType: ref(m.matterTypeId),
  clients: [ref(contactIdFor(m.id))],
  openedDate: m.createdAt,
  versionId: String(isoToTicks(m.updatedAt)),
  // Custom/layout data — the real key names get confirmed on live data.
  items: {
    ...(m.dateOfLoss ? { dateOfLoss: m.dateOfLoss } : {}),
    ...(m.statuteDate ? { statuteDate: m.statuteDate } : {}),
    ...(m.isInSuit !== undefined ? { isInSuit: m.isInSuit } : {}),
  },
});

export const contactToDto = (m: Matter) => ({
  ...base(contactIdFor(m.id)),
  person: { firstName: m.clientFirstName, lastName: m.clientLastName },
  lastUpdated: m.updatedAt,
});

export const taskToDto = (t: Task) => ({
  ...base(t.id),
  ...(t.matterId ? { matter: ref(t.matterId) } : { matter: null }),
  assignees: t.assigneeIds.map(ref),
  createdBy: ref(t.createdById),
  subject: t.subject,
  note: t.note ?? null,
  isCompleted: t.isCompleted,
  dueDate: t.dueDate ? `${t.dueDate}T12:00:00Z` : null,
  dueDateOnly: t.dueDate ? `${t.dueDate}T00:00:00` : null,
  completedDateOnly: t.completedAt ?? null,
  createdDate: t.createdAt,
  lastUpdated: isoToTicks(t.updatedAt), // tasks: ticks, per spec example
});

export const eventToDto = (e: CalendarEvent) => {
  const local = (iso: string) => DateTime.fromISO(iso).setZone(e.timeZone).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  return {
    ...base(e.id),
    ...(e.matterId ? { matter: ref(e.matterId) } : { matter: null }),
    attendees: e.attendeeIds.map(ref),
    subject: e.subject,
    location: e.location ?? null,
    allDay: e.allDay,
    type: 'Normal',
    startTime: local(e.startTime),
    endTime: local(e.endTime),
    timeZone: e.timeZone,
    lastUpdated: DateTime.fromISO(e.updatedAt).toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    // Not in the real API — carried so golden court-list behavior survives
    // the mock; the adapter only honors it when present.
    onOfficeCalendar: e.onOfficeCalendar,
  };
};

export const memoToDto = (m: Memo) => ({
  ...base(m.id),
  matterId: m.matterId,
  title: m.text.split('\n')[0]?.slice(0, 40) ?? '',
  text: `{\\rtf1\\ansi{\\fonttbl{\\f0 Calibri;}}\\pard ${m.text}\\par}`,
  plainText: m.text,
  createdDate: m.createdAt,
  lastUpdated: m.updatedAt,
  createdByUserId: userIdFor(m.createdById),
  updatedByUserId: userIdFor(m.updatedById),
});

export const fileToDto = (f: FileRecord) => {
  const dot = f.name.lastIndexOf('.');
  const ext = dot > 0 ? f.name.slice(dot) : '';
  return {
    ...base(f.id),
    matter: ref(f.matterId),
    folder: f.folderId ? ref(f.folderId) : null,
    name: ext ? f.name.slice(0, dot) : f.name,
    fileExtension: ext,
    to: f.to ?? null,
    from: f.from ?? null,
    dateCreated: f.dateCreated,
    dateModified: f.dateModified,
    sizeBytes: f.sizeBytes,
    downloadInfo: ref(f.id),
    isUploaded: true,
    isCancelled: false,
  };
};

/** /documents/folders answers with root nodes carrying a `folders` list. */
export const foldersToDto = (folders: Folder[], files: FileRecord[]) => [
  {
    ...base('root'),
    folders: folders.map((f) => ({ ...base(f.id), name: f.name, parentId: f.parentId ?? null, lastUpdated: f.updatedAt })),
    files: files.filter((f) => !f.folderId).map(fileToDto),
  },
];
