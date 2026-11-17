import { DateTime } from 'luxon';
import type { CalendarEvent, FileRecord, Folder, Matter, MatterType, Memo, Staff, Task } from '../core/types.js';

/**
 * The boundary between Smokeball's real wire shapes and PAM's core types.
 *
 * The real API (vendor/smokeball-openapi.json) differs from the spec-derived
 * mock in a dozen ways the empty staging tenant never showed: tasks carry
 * `assignees` refs and `dueDateOnly`, events carry `attendees` refs and
 * zone-less times + IANA `timeZone`, matters point at `clients` contact refs
 * instead of names, memos ship RTF `text` + `plainText`, `lastUpdated` is
 * sometimes .NET ticks, and every record has `isDeleted`. Everything PAM
 * reads passes through here, and everything it writes is encoded here — so
 * the mock can emit the real shapes and the whole test suite exercises this
 * layer on every run.
 */

export interface Ref {
  id: string;
}
type Raw = Record<string, unknown>;

const TICKS_EPOCH_MS_OFFSET = 62135596800000; // ms between 0001-01-01 and 1970-01-01
/** .NET ticks (100ns since 0001-01-01 UTC) → ISO. */
export function ticksToIso(ticks: number | string): string {
  const n = typeof ticks === 'string' ? Number(ticks) : ticks;
  return new Date(n / 10_000 - TICKS_EPOCH_MS_OFFSET).toISOString();
}
export function isoToTicks(iso: string): number {
  return Math.round((new Date(iso).getTime() + TICKS_EPOCH_MS_OFFSET) * 10_000);
}

/** lastUpdated may be ISO, zone-less ISO, or ticks (number / numeric string). */
export function anyStampToIso(v: unknown, fallback: string): string {
  if (typeof v === 'number') return ticksToIso(v);
  if (typeof v === 'string' && /^\d{15,}$/.test(v)) return ticksToIso(v);
  if (typeof v === 'string' && v) {
    const d = DateTime.fromISO(v, { zone: 'utc' });
    if (d.isValid) return d.toUTC().toISO()!;
  }
  return fallback;
}

const refId = (v: unknown): string | undefined =>
  v && typeof v === 'object' && typeof (v as Ref).id === 'string' ? (v as Ref).id : undefined;
const refIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(refId).filter((x): x is string => Boolean(x)) : [];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const dateOnly = (v: unknown): string | undefined => {
  const s = str(v);
  return s ? s.slice(0, 10) : undefined;
};
/** A real calendar date or nothing — for values found by key-name search,
 *  where "N/A" or a free-text note must not pass as a date. */
const strictDate = (v: unknown): string | undefined => {
  const s = str(v)?.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return DateTime.fromISO(s.slice(0, 10)).isValid ? s.slice(0, 10) : undefined;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const d = DateTime.fromObject({ year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) });
    return d.isValid ? d.toISODate()! : undefined;
  }
  return undefined;
};
const nowIso = () => DateTime.utc().toISO()!;

/** True when a record is already in PAM's core shape (mock passthrough / tests). */
const isCore = (raw: Raw, coreKey: string, dtoKey: string) => coreKey in raw && !(dtoKey in raw);

// ------------------------------------------------------------------ reads

export function adaptStaff(raw: Raw): Staff | null {
  if (raw['isDeleted'] === true) return null;
  const firstName = str(raw['firstName']) ?? '';
  const lastName = str(raw['lastName']) ?? '';
  return {
    id: String(raw['id']),
    firstName,
    lastName,
    initials: str(raw['initials']) ?? `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() ?? '??',
    email: str(raw['email']) ?? '',
    role: (str(raw['role']) ?? 'attorney') as Staff['role'],
    updatedAt: anyStampToIso(raw['updatedAt'] ?? raw['lastUpdated'], nowIso()),
  };
}
/** Real staff carry a `userId` distinct from `id`; memos reference users. */
export const staffUserId = (raw: Raw): string | undefined => str(raw['userId']);

export function adaptMatterType(raw: Raw): MatterType | null {
  if (raw['isDeleted'] === true) return null;
  return {
    id: String(raw['id']),
    name: str(raw['name']) ?? '(unnamed type)',
    category: str(raw['category']) ?? 'Other',
    location: (str(raw['location']) ?? 'NY') as MatterType['location'],
  };
}

export function adaptTask(raw: Raw): Task | null {
  if (raw['isDeleted'] === true) return null;
  if (isCore(raw, 'assigneeIds', 'assignees')) return raw as unknown as Task;
  const created = str(raw['createdDate']) ?? nowIso();
  const matterId = refId(raw['matter']) ?? str(raw['matterId']);
  const due = dateOnly(raw['dueDateOnly']) ?? dateOnly(raw['dueDate']);
  const completed = str(raw['completedDateOnly']) ?? str(raw['completedDate']);
  const note = str(raw['note']);
  return {
    id: String(raw['id']),
    ...(matterId ? { matterId } : {}),
    subject: str(raw['subject']) ?? '(untitled task)',
    ...(note ? { note } : {}),
    assigneeIds: refIds(raw['assignees']),
    ...(due ? { dueDate: due } : {}),
    isCompleted: raw['isCompleted'] === true,
    ...(completed ? { completedAt: completed } : {}),
    createdById: refId(raw['createdBy']) ?? '',
    createdAt: created,
    updatedAt: anyStampToIso(raw['lastUpdated'], created),
  };
}

export function adaptEvent(raw: Raw): CalendarEvent | null {
  if (raw['isDeleted'] === true) return null;
  if (isCore(raw, 'attendeeIds', 'attendees')) return raw as unknown as CalendarEvent;
  const tz = str(raw['timeZone']) ?? 'America/New_York';
  // Real times are zone-less local in `timeZone`; make them absolute.
  const abs = (v: unknown): string | undefined => {
    const s = str(v);
    if (!s) return undefined;
    const d = DateTime.fromISO(s, { zone: tz });
    return d.isValid ? d.toISO()! : undefined;
  };
  const start = abs(raw['startTime']) ?? nowIso();
  const matterId = refId(raw['matter']) ?? str(raw['matterId']);
  const location = str(raw['location']);
  const updated = anyStampToIso(raw['lastUpdated'], start);
  return {
    id: String(raw['id']),
    ...(matterId ? { matterId } : {}),
    subject: str(raw['subject']) ?? '(untitled event)',
    startTime: start,
    endTime: abs(raw['endTime']) ?? start,
    timeZone: tz,
    allDay: raw['allDay'] === true,
    attendeeIds: refIds(raw['attendees']),
    // The real API has no office-calendar flag; nothing is court-listed until
    // a mapping is confirmed on live data.
    onOfficeCalendar: raw['onOfficeCalendar'] === true,
    ...(location ? { location } : {}),
    createdAt: str(raw['createdAt']) ?? updated,
    updatedAt: updated,
  };
}

/** Client names come from /contacts — the sync resolves refs via `resolveContact`. */
export interface AdaptedMatter extends Matter {
  clientContactIds: string[];
  title?: string;
}
/** First value under a key matching `key` (searched a few levels deep) that
 *  `read` accepts. Layout/custom data is nested differently per tenant. */
export function findItem<T>(node: unknown, key: RegExp, read: (v: unknown) => T | undefined, depth = 0): T | undefined {
  if (!node || typeof node !== 'object' || depth > 4) return undefined;
  const entries: [string, unknown][] = Array.isArray(node)
    ? node.flatMap((n) => {
        // [{ name|key|label: 'Statute Date', value: '…' }] — a common layout shape.
        const o = n as Raw;
        const k = o && typeof o === 'object' ? (str(o['name']) ?? str(o['key']) ?? str(o['label'])) : undefined;
        return k !== undefined && 'value' in o ? [[k, o['value']] as [string, unknown]] : [['', n] as [string, unknown]];
      })
    : Object.entries(node as Raw);
  for (const [k, v] of entries) {
    if (k && key.test(k)) {
      const got = read(v);
      if (got !== undefined) return got;
    }
  }
  for (const [, v] of entries) {
    if (v && typeof v === 'object') {
      const got = findItem(v, key, read, depth + 1);
      if (got !== undefined) return got;
    }
  }
  return undefined;
}

export function adaptMatter(raw: Raw): AdaptedMatter | null {
  if (raw['isDeleted'] === true) return null;
  if (isCore(raw, 'clientLastName', 'clients')) return { ...(raw as unknown as Matter), clientContactIds: [] };
  const opened = str(raw['openedDate']) ?? nowIso();
  const items = (raw['items'] ?? {}) as Raw; // layout/custom data — key names to confirm on live data
  const title = str(raw['title']);
  // Exact keys first; then a search by key NAME through the layout data —
  // each tenant's layouts name these fields in their own words.
  const dateOfLoss =
    dateOnly(items['dateOfLoss'] ?? items['DateOfLoss']) ??
    findItem(items, /date.?of.?(loss|accident|incident|injury|occurrence)|(accident|incident|loss|injury).?date|^dol\b/i, strictDate);
  const statuteDate =
    dateOnly(items['statuteDate'] ?? items['StatuteOfLimitations']) ??
    findItem(items, /statute|limitation|^sol\b|^sol.?date/i, strictDate);
  const isInSuit: unknown =
    typeof items['isInSuit'] === 'boolean'
      ? items['isInSuit']
      : findItem(items, /in.?suit|suit.?filed|index.?(no|num)|date.?(suit.?)?filed|docket.?(no|num)/i, (v) =>
          v === true || (typeof v === 'string' && v.trim() !== '' && !/^(no|false|n\/a|none)$/i.test(v.trim())) ? true : undefined,
        );
  return {
    id: String(raw['id']),
    number: str(raw['number']) ?? String(raw['id']).slice(0, 8),
    status: (str(raw['status']) ?? 'Open') as Matter['status'],
    matterTypeId: refId(raw['matterType']) ?? str(raw['matterTypeId']) ?? '',
    clientFirstName: '',
    // Until the contact resolves, the matter title stands in for the client.
    clientLastName: title ?? '',
    description: str(raw['description']) ?? '',
    ...(dateOfLoss ? { dateOfLoss } : {}),
    ...(statuteDate ? { statuteDate } : {}),
    ...(typeof isInSuit === 'boolean' ? { isInSuit } : {}),
    createdAt: opened,
    updatedAt: anyStampToIso(raw['lastUpdated'] ?? raw['versionId'], opened),
    clientContactIds: refIds(raw['clients']),
    ...(title ? { title } : {}),
  };
}

/** Best-effort person/company name from a /contacts/{id} payload. */
export function adaptContactName(raw: Raw): { firstName: string; lastName: string } | null {
  const person = raw['person'] as Raw | undefined;
  if (person) {
    return { firstName: str(person['firstName']) ?? '', lastName: str(person['lastName']) ?? '' };
  }
  const company = raw['company'] as Raw | undefined;
  if (company && str(company['name'])) return { firstName: '', lastName: str(company['name'])! };
  return null;
}

const stripRtf = (s: string): string =>
  s
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export function adaptMemo(raw: Raw, userToStaff: (userId: string) => string): Memo | null {
  if (raw['isDeleted'] === true) return null;
  if (isCore(raw, 'createdById', 'createdByUserId')) return raw as unknown as Memo;
  const created = str(raw['createdDate']) ?? nowIso();
  const text = str(raw['plainText']) ?? (str(raw['text'])?.startsWith('{\\rtf') ? stripRtf(str(raw['text'])!) : str(raw['text'])) ?? '';
  const createdBy = str(raw['createdByUserId']);
  const updatedBy = str(raw['updatedByUserId']) ?? createdBy;
  return {
    id: String(raw['id']),
    matterId: str(raw['matterId']) ?? refId(raw['matter']) ?? '',
    text,
    createdById: createdBy ? userToStaff(createdBy) : '',
    updatedById: updatedBy ? userToStaff(updatedBy) : '',
    createdAt: created,
    updatedAt: anyStampToIso(raw['lastUpdated'], created),
  };
}

export function adaptFile(raw: Raw, matterId: string): FileRecord | null {
  if (raw['isDeleted'] === true || raw['isCancelled'] === true) return null;
  if (isCore(raw, 'dateCreated', 'downloadInfo') && !('folder' in raw)) return raw as unknown as FileRecord;
  const ext = str(raw['fileExtension']) ?? '';
  const base = str(raw['name']) ?? '(unnamed file)';
  const name = ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? `${base}${ext}` : base;
  const folderId = refId(raw['folder']) ?? str(raw['folderId']);
  const from = str(raw['from']);
  const to = str(raw['to']);
  const created = str(raw['dateCreated']) ?? nowIso();
  return {
    id: String(raw['id']),
    matterId: refId(raw['matter']) ?? str(raw['matterId']) ?? matterId,
    ...(folderId ? { folderId } : {}),
    name,
    sizeBytes: typeof raw['sizeBytes'] === 'number' ? raw['sizeBytes'] : 0,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    dateCreated: created,
    dateModified: str(raw['dateModified']) ?? created,
  };
}

/** /documents/folders returns root nodes holding a `folders` list (possibly
 *  nested) — flatten to PAM's folder rows. Core-shaped rows pass through. */
export function adaptFolders(raws: Raw[], matterId: string): Folder[] {
  const out: Folder[] = [];
  const walk = (node: Raw, parentId?: string) => {
    const name = str(node['name']);
    const id = str(node['id']);
    if (id && name) {
      const pid = str(node['parentId']) ?? parentId;
      out.push({ id, matterId, ...(pid ? { parentId: pid } : {}), name, updatedAt: anyStampToIso(node['lastUpdated'], nowIso()) });
    }
    for (const child of (node['folders'] as Raw[] | undefined) ?? []) walk(child, id);
  };
  for (const r of raws) {
    if (isCore(r, 'updatedAt', 'folders') && str(r['name'])) out.push(r as unknown as Folder);
    else walk(r);
  }
  return out;
}

// ----------------------------------------------------------------- writes

/** POST /tasks body (TaskDto): staffId is REQUIRED — the acting staff member. */
export function toTaskDto(task: Partial<Task>, staffId: string): Raw {
  return {
    staffId,
    ...(task.subject !== undefined ? { subject: task.subject } : {}),
    ...(task.note !== undefined ? { note: task.note } : {}),
    ...(task.matterId !== undefined ? { matterId: task.matterId } : {}),
    ...(task.assigneeIds !== undefined ? { assigneeIds: task.assigneeIds } : {}),
    ...(task.dueDate !== undefined ? { dueDateOnly: `${task.dueDate}T00:00:00` } : {}),
    ...(task.isCompleted !== undefined ? { isCompleted: task.isCompleted } : {}),
  };
}

/** POST /events body (EventDto): zone-less local times + IANA timeZone. */
export function toEventDto(ev: Partial<CalendarEvent>): Raw {
  const tz = ev.timeZone ?? 'America/New_York';
  const local = (iso?: string) => (iso ? DateTime.fromISO(iso).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined);
  return {
    type: 'Normal',
    ...(ev.subject !== undefined ? { subject: ev.subject } : {}),
    ...(ev.matterId !== undefined ? { matterId: ev.matterId } : {}),
    ...(ev.location !== undefined ? { location: ev.location } : {}),
    ...(ev.allDay !== undefined ? { allDay: ev.allDay } : {}),
    ...(ev.attendeeIds !== undefined ? { attendees: ev.attendeeIds } : {}),
    ...(ev.startTime ? { startTime: local(ev.startTime) } : {}),
    ...(ev.endTime ? { endTime: local(ev.endTime) } : {}),
    timeZone: tz,
  };
}
