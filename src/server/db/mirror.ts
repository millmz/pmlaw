import { inArray } from 'drizzle-orm';
import { schema, type Db } from './index.js';

/**
 * In-memory view of the small, hot mirror tables.
 *
 * Every question PAM answers used to re-read whole tables from disk —
 * including the ~20,000-row matter-type catalog — once for the snapshot and
 * again in each tool. On a small production box that was seconds per turn.
 * The rows only change when a sync or a confirmed write changes them, so
 * they are held in memory and dropped the moment the mirror moves
 * (`bumpMirror`). Notes and files are NOT held here: they are large, and
 * always read per matter.
 */

let version = 0;
/** Call after ANY write to matters, tasks, events, staff, or matter types. */
export function bumpMirror(): void {
  version++;
}
export const mirrorVersion = (): number => version;

interface Held {
  v: number;
  at: number;
  slots: Map<string, Promise<unknown>>;
}
const held = new WeakMap<object, Held>();
/** Belt and braces: even without a bump, nothing is served older than this. */
const MAX_AGE_MS = 60_000;

function memo<T>(db: Db, key: string, load: () => Promise<T>): Promise<T> {
  let h = held.get(db);
  if (!h || h.v !== version || Date.now() - h.at > MAX_AGE_MS) {
    h = { v: version, at: Date.now(), slots: new Map() };
    held.set(db, h);
  }
  let p = h.slots.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    h.slots.set(key, p);
    p.catch(() => h!.slots.delete(key));
  }
  return p;
}

type MatterType = typeof schema.matterTypes.$inferSelect;

export const mirror = {
  matters: (db: Db) => memo(db, 'matters', () => db.select().from(schema.matters)),
  tasks: (db: Db) => memo(db, 'tasks', () => db.select().from(schema.tasks)),
  /** Events carry `startMs` — parsing thousands of ISO dates per question
   *  was the single largest CPU cost on the calendar path. */
  events: (db: Db) =>
    memo(db, 'events', async () => (await db.select().from(schema.events)).map((e) => ({ ...e, startMs: Date.parse(e.startTime) }))),
  staff: (db: Db) => memo(db, 'staff', () => db.select().from(schema.staff)),
  /** Only the matter types some matter actually uses — never the catalog. */
  typesInUse: (db: Db) =>
    memo(db, 'types', async () => {
      const ids = [...new Set((await mirror.matters(db)).map((m) => m.matterTypeId).filter(Boolean))];
      const out = new Map<string, MatterType>();
      for (let i = 0; i < ids.length; i += 500) {
        for (const t of await db.select().from(schema.matterTypes).where(inArray(schema.matterTypes.id, ids.slice(i, i + 500)))) out.set(t.id, t);
      }
      return out;
    }),
  /** Derived values that are expensive to rebuild (e.g. the snapshot). */
  derived: <T>(db: Db, key: string, load: () => Promise<T>) => memo(db, `d:${key}`, load),
};
