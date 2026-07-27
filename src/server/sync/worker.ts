import { eq, sql } from 'drizzle-orm';
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

const toTaskRow = (t: Task) => ({
  id: t.id,
  matterId: t.matterId ?? null,
  subject: t.subject,
  note: t.note ?? null,
  assigneeIds: t.assigneeIds,
  dueDate: t.dueDate ?? null,
  isCompleted: t.isCompleted,
  completedAt: t.completedAt ?? null,
  createdById: t.createdById,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const toEventRow = (e: CalendarEvent) => ({
  id: e.id,
  matterId: e.matterId ?? null,
  subject: e.subject,
  startTime: e.startTime,
  endTime: e.endTime,
  timeZone: e.timeZone,
  allDay: e.allDay,
  attendeeIds: e.attendeeIds,
  onOfficeCalendar: e.onOfficeCalendar,
  location: e.location ?? null,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

const toMatterRow = (m: Matter) => ({
  id: m.id,
  number: m.number,
  status: m.status,
  matterTypeId: m.matterTypeId,
  clientFirstName: m.clientFirstName,
  clientLastName: m.clientLastName,
  description: m.description,
  dateOfLoss: m.dateOfLoss ?? null,
  statuteDate: m.statuteDate ?? null,
  isInSuit: m.isInSuit ?? null,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

export class SyncWorker {
  constructor(
    private db: Db,
    private client: SmokeballClient,
  ) {}

  private async upsert<T extends { id: string }>(
    table: typeof schema.staff | typeof schema.matterTypes | typeof schema.matters | typeof schema.tasks | typeof schema.events | typeof schema.folders | typeof schema.files | typeof schema.memos,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.db
        .insert(table)
        .values(row as never)
        .onConflictDoUpdate({
          target: table.id,
          set: { ...row, syncedAt: sql`now()` } as never,
        });
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
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};

    const staffList: Staff[] = await this.client.listStaff();
    await this.upsert(schema.staff, staffList.map((s) => ({ ...s })));
    counts['staff'] = staffList.length;

    const types: MatterType[] = await this.client.listMatterTypes();
    await this.upsert(schema.matterTypes, types.map((t) => ({ ...t })));
    counts['matterTypes'] = types.length;

    const matterList: Matter[] = await this.client.listMatters();
    await this.upsert(schema.matters, matterList.map(toMatterRow));
    counts['matters'] = matterList.length;

    const taskList: Task[] = await this.client.listTasks();
    await this.upsert(schema.tasks, taskList.map(toTaskRow));
    counts['tasks'] = taskList.length;

    const eventList: CalendarEvent[] = await this.client.listEvents();
    await this.upsert(schema.events, eventList.map(toEventRow));
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
      await this.upsert(
        schema.folders,
        fs.map((f: Folder) => ({ id: f.id, matterId: f.matterId, parentId: f.parentId ?? null, name: f.name, updatedAt: f.updatedAt })),
      );
      await this.upsert(
        schema.files,
        fls.map((f: FileRecord) => ({
          id: f.id,
          matterId: f.matterId,
          folderId: f.folderId ?? null,
          name: f.name,
          sizeBytes: f.sizeBytes,
          emailFrom: f.from ?? null,
          emailTo: f.to ?? null,
          dateCreated: f.dateCreated,
          dateModified: f.dateModified,
        })),
      );
      await this.upsert(
        schema.memos,
        ms.map((memo: Memo) => ({ ...memo })),
      );
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
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};

    const matterCursor = await this.getCursor('matters');
    const changedMatters = await this.client.listMatters(
      matterCursor ? { updatedSince: matterCursor } : {},
    );
    await this.upsert(schema.matters, changedMatters.map(toMatterRow));
    counts['matters'] = changedMatters.length;

    const taskCursor = await this.getCursor('tasks');
    const changedTasks = await this.client.listTasks(taskCursor ? { updatedSince: taskCursor } : {});
    await this.upsert(schema.tasks, changedTasks.map(toTaskRow));
    counts['tasks'] = changedTasks.length;

    const eventCursor = await this.getCursor('events');
    const changedEvents = await this.client.listEvents(
      eventCursor ? { updatedSince: eventCursor } : {},
    );
    await this.upsert(schema.events, changedEvents.map(toEventRow));
    counts['events'] = changedEvents.length;

    // Refresh per-matter resources for any matter that changed.
    for (const m of changedMatters.filter((m) => m.status === 'Open')) {
      const memosList = await this.client.listMemos(m.id);
      await this.upsert(schema.memos, memosList.map((memo: Memo) => ({ ...memo })));
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
      const memo = payload as Memo;
      await this.upsert(schema.memos, [{ ...memo }]);
    }
    // 'error' and unhandled types are surfaced by the caller's logging.
  }
}
