import { eq, getTableColumns, getTableName, inArray, sql } from 'drizzle-orm';
import { bumpMirror } from '../db/mirror.js';
import { DateTime } from 'luxon';
import type { SmokeballClient } from '../../smokeball/client.js';
import { adaptEvent, adaptMatter, adaptMemo, adaptTask } from '../../smokeball/adapt.js';
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
  await db.delete(schema.derived);
  bumpMirror();
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
  /** Non-fatal problems (e.g. a per-matter resource the app lacks a scope for). */
  warnings?: string[];
}

export interface SyncProgress {
  kind: 'full' | 'incremental';
  phase: string;
  done: number;
  total: number;
  startedAt: string;
}

type PerMatterKind = 'memos' | 'layouts' | 'files' | 'folders';
/** Matters whose custom fields are read per pass while the one-time catch-up runs. */
const FACTS_BACKFILL_PER_PASS = 40;
/** Per-matter resources refreshed in the background each incremental pass. */
const ROLLING_REFRESH_PER_PASS = 4;
const MATTER_TYPE_CATALOG_TTL_DAYS = 7;
const EVENT_HISTORY_YEARS = 2;

export class SyncWorker {
  /** Last sync outcome, for diagnostics (/api/smokeball/verify). */
  lastSync: SyncStatus | null = null;
  /** When any sync last succeeded — drives the "Synced" pill. */
  lastOkAt: string | null = null;
  /** Set while a sync is running. */
  progress: SyncProgress | null = null;
  /** Last webhook delivery seen, for diagnostics. */
  lastWebhook: { at: string; type: string } | null = null;

  /** True while the very first full read of this source is under way. */
  firstRun = false;
  /** Set whenever a sync actually changed the mirror — lets dependants
   *  (the settlement board warm-up) skip work when nothing moved. */
  private dirty = true;
  takeDirty(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }

  private running: Promise<unknown> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshedAt = new Map<string, number>();
  private pendingMatterIds = new Set<string>();
  /** A resource that keeps failing (missing scope) is skipped for the rest of a run. */
  private failures = new Map<PerMatterKind, { streak: number; total: number; sample: string }>();
  private disabled = new Set<PerMatterKind>();

  constructor(
    private db: Db,
    private client: SmokeballClient,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

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
    this.dirty = true;
    bumpMirror();
    const set: Record<string, unknown> = {};
    // Statute date, date of loss and suit status come from a matter's
    // layouts, not from the matter list — a list sync must never blank them.
    const keep = table === schema.matters ? new Set(['dateOfLoss', 'statuteDate', 'isInSuit']) : new Set<string>();
    for (const [key, col] of Object.entries(getTableColumns(table))) {
      if (key === 'id') continue;
      set[key] =
        key === 'syncedAt'
          ? sql`now()`
          : keep.has(key)
            ? sql.raw(`coalesce(excluded."${col.name}", "${getTableName(table)}"."${col.name}")`)
            : sql.raw(`excluded."${col.name}"`);
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

  /** True once a full sync has run to completion against the current source
   *  (a full sync interrupted by a restart starts over — cheaply, since the
   *  matter-type catalog is kept). */
  async hasMirror(): Promise<boolean> {
    return Boolean(await this.getCursor('full'));
  }

  // ------------------------------------------------------------ exclusivity

  /** One sync at a time. A full sync waits its turn; an incremental pass that
   *  finds a sync already running is skipped (the running one covers it and
   *  the next pass picks up anything newer from the cursor). */
  private async exclusive<T>(kind: 'full' | 'incremental', fn: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
    if (kind === 'incremental' && this.running) return { skipped: 1 };
    while (this.running) await this.running.catch(() => undefined);
    this.failures.clear();
    this.disabled.clear();
    const run = (async () => {
      try {
        const counts = await fn();
        const warnings = this.warnings();
        this.lastSync = { at: nowIso(), kind, ok: true, counts, ...(warnings.length ? { warnings } : {}) };
        this.lastOkAt = this.lastSync.at;
        return counts;
      } catch (e) {
        this.lastSync = { at: nowIso(), kind, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 500) };
        throw e;
      } finally {
        this.progress = null;
        this.firstRun = false;
      }
    })();
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  private warnings(): string[] {
    return [...this.failures.entries()]
      .filter(([, f]) => f.total > 0)
      .map(([kind, f]) => `${kind}: ${f.total} matter(s) could not be read${this.disabled.has(kind) ? ' (skipped for the rest of the run — likely a missing scope)' : ''} — ${f.sample}`);
  }

  private setProgress(kind: 'full' | 'incremental', phase: string, done = 0, total = 0): void {
    this.progress = { kind, phase, done, total, startedAt: this.progress?.startedAt ?? nowIso() };
  }

  /** A list filter the real API might reject (format/unsupported) must never
   *  cost us the whole sync: on failure, fall back to the unfiltered call. */
  private async filtered<T>(what: string, withFilter: () => Promise<T>, without: () => Promise<T>): Promise<T> {
    try {
      return await withFilter();
    } catch (e) {
      console.error(`[pam] ${what}: filtered list failed (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — retrying unfiltered`);
      return without();
    }
  }

  // --------------------------------------------------- per-matter resources

  /** Refresh one matter's notes, files, and folders. Each resource is
   *  isolated: a failure is recorded, never thrown, and a resource that fails
   *  three times running (a missing scope) is skipped until the next run. */
  private async refreshMatter(matterId: string, counts?: Record<string, number>): Promise<void> {
    const one = async (kind: PerMatterKind, fn: () => Promise<number>) => {
      if (this.disabled.has(kind)) return;
      const f = this.failures.get(kind) ?? { streak: 0, total: 0, sample: '' };
      try {
        const n = await fn();
        f.streak = 0;
        if (counts) counts[kind] = (counts[kind] ?? 0) + n;
      } catch (e) {
        f.streak++;
        f.total++;
        f.sample = String(e instanceof Error ? e.message : e).slice(0, 160);
        if (f.streak >= 3) this.disabled.add(kind);
      }
      this.failures.set(kind, f);
    };
    // Only what actually changed is written: on a real firm most refreshes
    // find nothing new, and a disk write per matter per resource is what
    // made the first read slow. Rows gone upstream are removed — a stale
    // "Offer:" note must not live on the settlement board forever.
    // Notes first: they are the settlement source of truth.
    await one('memos', async () => {
      const ms = await this.client.listMemos(matterId);
      const have = new Map(
        (await this.db.select({ id: schema.memos.id, v: schema.memos.updatedAt }).from(schema.memos).where(eq(schema.memos.matterId, matterId))).map((r) => [r.id, r.v]),
      );
      await this.upsert(schema.memos, withIds(ms).filter((m) => !have.has(m.id) || have.get(m.id) !== m.updatedAt).map(toMemoRow));
      const keep = new Set(ms.map((m) => m.id));
      const gone = [...have.keys()].filter((id) => !keep.has(id));
      if (gone.length) {
        this.dirty = true;
        await this.db.delete(schema.memos).where(inArray(schema.memos.id, gone));
      }
      return ms.length;
    });
    await one('layouts', () => this.refreshFacts(matterId));
    await one('files', async () => {
      const fls = await this.client.listFiles(matterId);
      const have = new Map(
        (await this.db.select({ id: schema.files.id, v: schema.files.dateModified }).from(schema.files).where(eq(schema.files.matterId, matterId))).map((r) => [r.id, r.v]),
      );
      await this.upsert(schema.files, withIds(fls).filter((f) => !have.has(f.id) || have.get(f.id) !== f.dateModified).map(toFileRow));
      const keep = new Set(fls.map((f) => f.id));
      const gone = [...have.keys()].filter((id) => !keep.has(id));
      if (gone.length) {
        this.dirty = true;
        await this.db.delete(schema.files).where(inArray(schema.files.id, gone));
      }
      return fls.length;
    });
    await one('folders', async () => {
      const fs = await this.client.listFolders(matterId);
      const have = new Map(
        (await this.db.select({ id: schema.folders.id, v: schema.folders.name }).from(schema.folders).where(eq(schema.folders.matterId, matterId))).map((r) => [r.id, r.v]),
      );
      await this.upsert(schema.folders, withIds(fs).filter((f) => !have.has(f.id) || have.get(f.id) !== f.name).map(toFolderRow));
      return fs.length;
    });
    this.refreshedAt.set(matterId, Date.now());
  }

  /** A matter's custom fields (statute date, date of loss, in suit). Only
   *  what the layouts actually hold is written; nothing is ever blanked. */
  private async refreshFacts(matterId: string): Promise<number> {
    const facts = await this.client.matterFacts(matterId);
    if (Object.keys(facts).length === 0) return 0;
    const cur = (
      await this.db
        .select({ dateOfLoss: schema.matters.dateOfLoss, statuteDate: schema.matters.statuteDate, isInSuit: schema.matters.isInSuit })
        .from(schema.matters)
        .where(eq(schema.matters.id, matterId))
    )[0];
    if (!cur) return 0;
    const changed = (Object.keys(facts) as (keyof typeof facts)[]).some((k) => cur[k] !== facts[k]);
    if (changed) {
      await this.db.update(schema.matters).set(facts).where(eq(schema.matters.id, matterId));
      this.dirty = true;
      bumpMirror();
    }
    return 1;
  }

  /** One-time catch-up for a mirror built before custom fields were read:
   *  a batch per pass, injury matters first, until every open matter is done. */
  private factsQueue: string[] | null = null;
  private async backfillFacts(skip: Set<string>, counts: Record<string, number>): Promise<void> {
    if (this.disabled.has('layouts') || (await this.getCursor('layouts'))) return;
    if (!this.factsQueue) {
      const types = new Map((await this.db.select({ id: schema.matterTypes.id, category: schema.matterTypes.category }).from(schema.matterTypes)).map((t) => [t.id, t.category ?? '']));
      const open = (await this.db.select({ id: schema.matters.id, status: schema.matters.status, type: schema.matters.matterTypeId }).from(schema.matters)).filter((m) => m.status === 'Open');
      const injury = (m: (typeof open)[number]) => (/injur|malpractice|negligen|accident/i.test(types.get(m.type) ?? '') ? 0 : 1);
      this.factsQueue = open.sort((a, b) => injury(a) - injury(b)).map((m) => m.id);
    }
    for (const id of this.factsQueue.splice(0, FACTS_BACKFILL_PER_PASS)) {
      if (skip.has(id) || this.disabled.has('layouts')) continue;
      const f = this.failures.get('layouts') ?? { streak: 0, total: 0, sample: '' };
      try {
        counts['layouts'] = (counts['layouts'] ?? 0) + (await this.refreshFacts(id));
        f.streak = 0;
      } catch (e) {
        f.streak++;
        f.total++;
        f.sample = String(e instanceof Error ? e.message : e).slice(0, 160);
        if (f.streak >= 3) this.disabled.add('layouts');
      }
      this.failures.set('layouts', f);
    }
    if (this.factsQueue.length === 0 && !this.disabled.has('layouts')) {
      await this.setCursor('layouts', DateTime.utc().toISO()!);
      this.factsQueue = null;
    }
  }
  /** Progress of that catch-up, for the health report. */
  get factsBackfill(): { pending: number } | 'unavailable' | null {
    if (this.disabled.has('layouts')) return 'unavailable';
    return this.factsQueue ? { pending: this.factsQueue.length } : null;
  }

  // -------------------------------------------------------------- full sync

  /** Mirror everything. Returns per-type counts for logging/telemetry. */
  fullSync(): Promise<Record<string, number>> {
    return this.exclusive('full', () => this.fullSyncInner());
  }

  private async fullSyncInner(): Promise<Record<string, number>> {
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};
    this.firstRun = !(await this.hasMirror());

    this.setProgress('full', 'staff');
    const staffList: Staff[] = await this.client.listStaff();
    await this.upsert(schema.staff, withIds(staffList).map(toStaffRow));
    counts['staff'] = staffList.length;

    // The matter-type catalog is ~20k global rows that rarely change —
    // re-read it at most weekly.
    this.setProgress('full', 'matter types');
    const typesCursor = await this.getCursor('mattertypes');
    const typesFresh =
      typesCursor !== undefined &&
      DateTime.fromISO(typesCursor) > DateTime.utc().minus({ days: MATTER_TYPE_CATALOG_TTL_DAYS }) &&
      (await this.db.select({ id: schema.matterTypes.id }).from(schema.matterTypes).limit(1)).length > 0;
    if (typesFresh) {
      counts['matterTypes'] = 0;
    } else {
      const types: MatterType[] = await this.client.listMatterTypes();
      await this.upsert(schema.matterTypes, withIds(types).map(toMatterTypeRow));
      counts['matterTypes'] = types.length;
      await this.setCursor('mattertypes', startedAt);
    }

    // Matters land immediately under their title; client names are their own
    // phase below. (Names already resolved on an earlier sync are kept.)
    this.setProgress('full', 'matters');
    const adapted = await this.client.listMattersAdapted();
    const known = new Map(
      (await this.db.select({ id: schema.matters.id, first: schema.matters.clientFirstName, last: schema.matters.clientLastName }).from(schema.matters)).map(
        (r) => [r.id, r],
      ),
    );
    const needName: { id: string; contactId: string; open: boolean }[] = [];
    const matterList: Matter[] = adapted.map(({ clientContactIds, title: _t, ...m }) => {
      const contactId = clientContactIds[0];
      if (!contactId || m.clientFirstName) return m; // already carries a real name
      const prev = known.get(m.id);
      if (prev && (prev.first !== '' || prev.last !== m.clientLastName)) {
        return { ...m, clientFirstName: prev.first, clientLastName: prev.last };
      }
      needName.push({ id: m.id, contactId, open: m.status === 'Open' });
      return m;
    });
    await this.upsert(schema.matters, withIds(matterList).map(toMatterRow));
    counts['matters'] = matterList.length;

    // Open tasks only: years of completed tasks are noise at firm scale.
    // (Completions arrive later through the incremental LastUpdated pass.)
    this.setProgress('full', 'tasks');
    const taskList: Task[] = await this.filtered(
      'tasks',
      () => this.client.listTasks({ isCompleted: false }),
      () => this.client.listTasks(),
    );
    await this.upsert(schema.tasks, withIds(taskList).map(toTaskRow));
    counts['tasks'] = taskList.length;

    this.setProgress('full', 'calendar');
    const from = DateTime.utc().minus({ years: EVENT_HISTORY_YEARS }).toISO()!;
    const eventList: CalendarEvent[] = await this.filtered(
      'events',
      () => this.client.listEvents({ from }),
      () => this.client.listEvents(),
    );
    await this.upsert(schema.events, withIds(eventList).map(toEventRow));
    counts['events'] = eventList.length;

    // The docket is usable from here on — record the cursors now so a crash
    // or restart during the long per-matter walks doesn't start from zero.
    for (const type of ['matters', 'tasks', 'events']) await this.setCursor(type, startedAt);

    // Client names: one /contacts call per matter, open matters first. If
    // the app cannot read contacts at all, stop asking — titles stand in.
    needName.sort((a, b) => Number(b.open) - Number(a.open));
    let named = 0;
    let misses = 0;
    for (const [i, n] of needName.entries()) {
      this.setProgress('full', 'client names', i, needName.length);
      const name = await this.client.clientNameFor(n.contactId);
      if (name) {
        named++;
        misses = 0;
        await this.db
          .update(schema.matters)
          .set({ clientFirstName: name.firstName, clientLastName: name.lastName })
          .where(eq(schema.matters.id, n.id));
        bumpMirror();
      } else if (++misses >= 5 && named === 0) {
        break;
      }
    }
    counts['clientNames'] = named;

    // Per-matter resources (open matters only — closed matters keep their
    // last-synced rows).
    const open = matterList.filter((m) => m.status === 'Open');
    counts['memos'] = 0;
    counts['files'] = 0;
    counts['folders'] = 0;
    for (const [i, m] of open.entries()) {
      this.setProgress('full', 'notes & documents', i, open.length);
      await this.refreshMatter(m.id, counts);
    }
    if (!this.disabled.has('layouts')) await this.setCursor('layouts', startedAt);
    await this.setCursor('full', startedAt);
    return counts;
  }

  // ------------------------------------------------------- incremental sync

  /** Pull only records changed since the last cursor. */
  incrementalSync(): Promise<Record<string, number>> {
    return this.exclusive('incremental', () => this.incrementalSyncInner());
  }

  private async incrementalSyncInner(): Promise<Record<string, number>> {
    const startedAt = DateTime.utc().toISO()!;
    const counts: Record<string, number> = {};
    this.setProgress('incremental', 'changes');

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

    // Per-matter resources: every changed matter, every matter a webhook
    // pointed at, plus a few of the least-recently-refreshed open matters so
    // notes and documents never go stale for long (a new note does not
    // necessarily bump its matter's LastUpdated).
    const targets = new Set<string>(changedMatters.filter((m) => m.status === 'Open').map((m) => m.id));
    for (const id of this.pendingMatterIds) targets.add(id);
    this.pendingMatterIds.clear();
    const openIds = (await this.db.select({ id: schema.matters.id, status: schema.matters.status }).from(schema.matters))
      .filter((m) => m.status === 'Open')
      .map((m) => m.id);
    const stale = openIds
      .filter((id) => !targets.has(id))
      .sort((a, b) => (this.refreshedAt.get(a) ?? 0) - (this.refreshedAt.get(b) ?? 0))
      .slice(0, ROLLING_REFRESH_PER_PASS);
    for (const id of stale) targets.add(id);
    for (const id of targets) await this.refreshMatter(id, counts);
    await this.backfillFacts(targets, counts);

    for (const type of ['matters', 'tasks', 'events']) await this.setCursor(type, startedAt);
    return counts;
  }

  // --------------------------------------------------------------- webhooks

  /** Coalesce a burst of deliveries into one incremental sync shortly after. */
  requestSync(delayMs = 300): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.incrementalSync().catch((e) => console.error('[pam] webhook-triggered sync failed:', e instanceof Error ? e.message : e));
    }, delayMs);
  }

  /**
   * Production path for a delivery: the payload is NOT trusted as a full
   * record (real shapes vary by event) — deletions are applied by id, and
   * everything else triggers a prompt incremental sync from the API. When the
   * payload names a matter (note/file/matter events), that matter's notes and
   * documents are refreshed in that same pass.
   */
  async handleWebhook(type: string, payload: unknown): Promise<void> {
    this.lastWebhook = { at: nowIso(), type };
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const id = typeof p['id'] === 'string' ? p['id'] : undefined;
    if (/\.deleted$/.test(type) && id) {
      const table = type.startsWith('task.') ? schema.tasks : type.startsWith('memo.') ? schema.memos : type.startsWith('matter.') ? schema.matters : type.startsWith('event.') ? schema.events : null;
      if (table) {
        await this.db.delete(table).where(eq(table.id, id));
        bumpMirror();
      }
      return;
    }
    const nested = p['matter'] && typeof p['matter'] === 'object' ? (p['matter'] as Record<string, unknown>)['id'] : undefined;
    const matterId =
      typeof p['matterId'] === 'string' ? p['matterId'] : typeof nested === 'string' ? nested : type.startsWith('matter') ? id : undefined;
    if (matterId && /^(memo|files|matter)/.test(type)) this.pendingMatterIds.add(matterId);
    this.requestSync();
  }

  /** Apply a webhook delivery. Idempotent; unknown types are ignored. Payloads
   *  may arrive in the real wire shape — the adapter decodes either. */
  async applyWebhook(type: string, payload: unknown): Promise<void> {
    const raw = (payload ?? {}) as Record<string, unknown>;
    if (type.startsWith('task.')) {
      const t = adaptTask(raw);
      if (t) await this.upsert(schema.tasks, [toTaskRow(t)]);
    } else if (type.startsWith('event.')) {
      const e = adaptEvent(raw);
      if (e) await this.upsert(schema.events, [toEventRow(e)]);
    } else if (type.startsWith('matter.')) {
      const m = adaptMatter(raw);
      if (m) await this.upsert(schema.matters, [toMatterRow(m)]);
    } else if (type.startsWith('memo.')) {
      const m = adaptMemo(raw, (u) => u);
      if (m) await this.upsert(schema.memos, [toMemoRow(m)]);
    }
    // 'error' and unhandled types are surfaced by the caller's logging.
  }
}
