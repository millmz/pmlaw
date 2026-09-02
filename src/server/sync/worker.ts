import { eq, getTableColumns, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { SmokeballClient } from '../../smokeball/client.js';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type {
  CalendarEvent,
  FileRecord,
  Folder,
  Matter,
  MatterType,
  Memo,
  Staff,
  Task,
} from '../../core/types.js';

/**
 * Sync worker (docs/01): mirrors Smokeball into the cache.
 *
 *  - fullSync: everything, throttled by the client's rate limiter.
 *  - incrementalSync: UpdatedSince cursors per record type.
 *  - applyWebhook: point updates pushed by Smokeball; idempotent because
 *    webhooks arrive unordered and duplicated (docs/02).
 */

/**
 * Wipe the synced mirror (and its cursors) — used when the data SOURCE
 * changes (mock → staging → production), because sync only upserts and would
 * otherwise leave the old source's records mixed into the new one's. Leaves
 * everything PAM owns herself: chat, settings, audit log, memories.
 */
export async function clearSyncedData(db: Db): Promise<void> {
  await db.delete(schema.memos);
  await db.delete(schema.files);
  await db.delete(schema.folders);
  await db.delete(schema.events);
  await db.delete(schema.tasks);
  await db.delete(schema.matters);
  await db.delete(schema.matterTypes);
  await db.delete(schema.staff);
  await db.delete(schema.syncState);
}

/**
 * Real Smokeball payloads omit fields the spec (and our golden data) always
 * carried — the first staging sync died on staff.initials being null. Every
 * mapper therefore treats its input as sparse and fills each NOT NULL column
 * with a derived or neutral default instead of crashing the sync.
 */
type Sparse<T> = { [K in keyof T]?: T[K] | null };

const nowIso = () => DateTime.utc().toISO()!;

const toStaffRow = (s: Sparse<Staff>) => ({
  id: s.id!,
  firstName: s.firstName ?? '',
  lastName: s.lastName ?? '',
  initials:
    s.initials ??
    (`${(s.firstName ?? '').charAt(0)}${(s.lastName ?? '').charAt(0)}`.toUpperCase() || '??'),
  email: s.email ?? '',
  role: s.role ?? 'attorney',
  updatedAt: s.updatedAt ?? nowIso(),
});

const toMatterTypeRow = (t: Sparse<MatterType>) => ({
  id: t.id!,
  name: t.name ?? '(unnamed type)',
  category: t.category ?? 'Other',
  location: t.location ?? 'NY',
});

const toTaskRow = (t: Sparse<Task>) => ({
  id: t.id!,
  matterId: t.matterId ?? null,
  subject: t.subject ?? '(untitled task)',
  note: t.note ?? null,
  assigneeIds: t.assigneeIds ?? [],
  dueDate: t.dueDate ?? null,
  isCompleted: t.isCompleted ?? false,
  completedAt: t.completedAt ?? null,
  createdById: t.createdById ?? '',
  createdAt: t.createdAt ?? nowIso(),
  updatedAt: t.updatedAt ?? nowIso(),
});

const toEventRow = (e: Sparse<CalendarEvent>) => ({
  id: e.id!,
  matterId: e.matterId ?? null,
  subject: e.subject ?? '(untitled event)',
  startTime: e.startTime ?? nowIso(),
  endTime: e.endTime ?? e.startTime ?? nowIso(),
  timeZone: e.timeZone ?? 'America/New_York',
  allDay: e.allDay ?? false,
  attendeeIds: e.attendeeIds ?? [],
  onOfficeCalendar: e.onOfficeCalendar ?? false,
  location: e.location ?? null,
  createdAt: e.createdAt ?? nowIso(),
  updatedAt: e.updatedAt ?? nowIso(),
});

const toMatterRow = (m: Sparse<Matter>) => ({
  id: m.id!,
  number: m.number ?? (m.id ?? '').slice(0, 8),
  status: m.status ?? 'Open',
  matterTypeId: m.matterTypeId ?? '',
  clientFirstName: m.clientFirstName ?? '',
  clientLastName: m.clientLastName ?? '',
  description: m.description ?? '',
  dateOfLoss: m.dateOfLoss ?? null,
  statuteDate: m.statuteDate ?? null,
  isInSuit: m.isInSuit ?? null,
  createdAt: m.createdAt ?? nowIso(),
  updatedAt: m.updatedAt ?? nowIso(),
});

const toFolderRow = (f: Sparse<Folder>) => ({
  id: f.id!,
  matterId: f.matterId ?? '',
  parentId: f.parentId ?? null,
  name: f.name ?? '(unnamed folder)',
  updatedAt: f.updatedAt ?? nowIso(),
});

const toFileRow = (f: Sparse<FileRecord>) => ({
  id: f.id!,
  matterId: f.matterId ?? '',
  folderId: f.folderId ?? null,
  name: f.name ?? '(unnamed file)',
  sizeBytes: f.sizeBytes ?? 0,
  emailFrom: f.from ?? null,
  emailTo: f.to ?? null,
  dateCreated: f.dateCreated ?? nowIso(),
  dateModified: f.dateModified ?? nowIso(),
});

const toMemoRow = (m: Sparse<Memo>) => ({
  id: m.id!,
  matterId: m.matterId ?? '',
  text: m.text ?? '',
  createdById: m.createdById ?? '',
  updatedById: m.updatedById ?? m.createdById ?? '',
  createdAt: m.createdAt ?? nowIso(),
  updatedAt: m.updatedAt ?? m.createdAt ?? nowIso(),
});

/** Records without an id can't be keyed — drop them rather than crash. */
const withIds = <T extends { id?: string | null }>(rows: T[]): T[] => rows.filter((r) => Boolean(r.id));

export interface SyncStatus {
  at: string;
  kind: 'full' | 'incremental';
  ok: boolean;
  error?: string;
  counts?: Record<string, number>;
}

export class SyncWorker {
  /** Last sync outcome, for diagnostics (/api/smokeball/verify). */
  lastSync: SyncStatus | null = null;

  constructor(
    private db: Db,
    private client: SmokeballClient,
  ) {}

  /** Batched multi-row upsert — a real tenant's /mattertypes is a ~20k-row
   *  global catalog, and one INSERT per row made the first sync crawl.
   *  Conflict updates take each column from EXCLUDED, so every batch is a
   *  single statement regardless of row count. */
  private async upsert<T extends { id: string }>(
    table: typeof schema.staff | typeof schema.matterTypes | typeof schema.matters | typeof schema.tasks | typeof schema.events | typeof schema.folders | typeof schema.files | typeof schema.memos,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    // A batch may not touch the same id twice (Postgres rejects it) — last wins.
    rows = [...new Map(rows.map((r) => [r['id'], r])).values()];
    const set: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(getTableColumns(table))) {
      if (key === 'id') continue;
      set[key] = key === 'syncedAt' ? sql`now()` : sql.raw(`excluded."${col.name}"`);
    }
    const BATCH = 400;
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db
        .insert(table)
        .values(rows.slice(i, i + BATCH) as never)
        .onConflictDoUpdate({ target: table.id, set: set as never });
    }
  }

  private async setCursor(recordType: string, iso: string): Promise<void> {
    await this.db
      .insert(schema.syncState)
      .values({ recordType, lastSyncedAt: iso })
      .onConflictDoUpdate({ target: schema.syncState.recordType, set: { lastSyncedAt: iso } });
  }

  private async getCursor(recordType: string): Promise<string | undefined> {
    const row = await this.db.query.syncState.findFirst({
      where: eq(schema.syncState.recordType, recordType),
    });
    return row?.lastSyncedAt;
  }

  /** Mirror everything. Returns per-type counts for logging/telemetry. */
  async fullSync(): Promise<Record<string, number>> {
    try {
      const counts = await this.fullSyncInner();
      this.lastSync = { at: nowIso(), kind: 'full', ok: true, counts };
      return counts;
    } catch (e) {
      this.lastSync = { at: nowIso(), kind: 'full', ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 500) };
      throw e;
    }
  }

  private async fullSyncInner(): Promise<Record<string, number>> {
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};

    const staffList: Staff[] = await this.client.listStaff();
    await this.upsert(schema.staff, withIds(staffList).map(toStaffRow));
    counts['staff'] = staffList.length;

    const types: MatterType[] = await this.client.listMatterTypes();
    await this.upsert(schema.matterTypes, withIds(types).map(toMatterTypeRow));
    counts['matterTypes'] = types.length;

    const matterList: Matter[] = await this.client.listMatters();
    await this.upsert(schema.matters, withIds(matterList).map(toMatterRow));
    counts['matters'] = matterList.length;

    const taskList: Task[] = await this.client.listTasks();
    await this.upsert(schema.tasks, withIds(taskList).map(toTaskRow));
    counts['tasks'] = taskList.length;

    const eventList: CalendarEvent[] = await this.client.listEvents();
    await this.upsert(schema.events, withIds(eventList).map(toEventRow));
    counts['events'] = eventList.length;

    // Per-matter resources: folders, file metadata, memos (open matters only —
    // closed matters keep their last-synced rows).
    let folderCount = 0;
    let fileCount = 0;
    let memoCount = 0;
    for (const m of matterList.filter((m) => m.status === 'Open')) {
      const [fs, fls, ms] = [
        await this.client.listFolders(m.id),
        await this.client.listFiles(m.id),
        await this.client.listMemos(m.id),
      ];
      await this.upsert(schema.folders, withIds(fs).map(toFolderRow));
      await this.upsert(schema.files, withIds(fls).map(toFileRow));
      await this.upsert(schema.memos, withIds(ms).map(toMemoRow));
      folderCount += fs.length;
      fileCount += fls.length;
      memoCount += ms.length;
    }
    counts['folders'] = folderCount;
    counts['files'] = fileCount;
    counts['memos'] = memoCount;

    for (const type of ['matters', 'tasks', 'events']) await this.setCursor(type, startedAt);
    return counts;
  }

  /** Pull only records changed since the last cursor. */
  async incrementalSync(): Promise<Record<string, number>> {
    try {
      const counts = await this.incrementalSyncInner();
      this.lastSync = { at: nowIso(), kind: 'incremental', ok: true, counts };
      return counts;
    } catch (e) {
      this.lastSync = { at: nowIso(), kind: 'incremental', ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 500) };
      throw e;
    }
  }

  private async incrementalSyncInner(): Promise<Record<string, number>> {
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};

    const matterCursor = await this.getCursor('matters');
    const changedMatters = await this.client.listMatters(
      matterCursor ? { updatedSince: matterCursor } : {},
    );
    await this.upsert(schema.matters, withIds(changedMatters).map(toMatterRow));
    counts['matters'] = changedMatters.length;

    const taskCursor = await this.getCursor('tasks');
    const changedTasks = await this.client.listTasks(taskCursor ? { updatedSince: taskCursor } : {});
    await this.upsert(schema.tasks, withIds(changedTasks).map(toTaskRow));
    counts['tasks'] = changedTasks.length;

    const eventCursor = await this.getCursor('events');
    const changedEvents = await this.client.listEvents(
      eventCursor ? { updatedSince: eventCursor } : {},
    );
    await this.upsert(schema.events, withIds(changedEvents).map(toEventRow));
    counts['events'] = changedEvents.length;

    // Refresh per-matter resources for any matter that changed.
    for (const m of changedMatters.filter((m) => m.status === 'Open')) {
      const memosList = await this.client.listMemos(m.id);
      await this.upsert(schema.memos, withIds(memosList).map(toMemoRow));
    }

    for (const type of ['matters', 'tasks', 'events']) await this.setCursor(type, startedAt);
    return counts;
  }

  /** Apply a webhook delivery. Idempotent; unknown types are ignored. */
  async applyWebhook(type: string, payload: unknown): Promise<void> {
    if (type.startsWith('task.')) {
      await this.upsert(schema.tasks, [toTaskRow(payload as Task)]);
    } else if (type.startsWith('event.')) {
      await this.upsert(schema.events, [toEventRow(payload as CalendarEvent)]);
    } else if (type.startsWith('matter.')) {
      await this.upsert(schema.matters, [toMatterRow(payload as Matter)]);
    } else if (type.startsWith('memo.')) {
      await this.upsert(schema.memos, [toMemoRow(payload as Memo)]);
    }
    // 'error' and unhandled types are surfaced by the caller's logging.
  }
}
