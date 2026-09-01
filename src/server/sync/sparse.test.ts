import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { SyncWorker } from './worker.js';
import type { SmokeballClient } from '../../smokeball/client.js';

/**
 * Regression for the first real staging sync: Smokeball's live payloads omit
 * fields the spec-derived mock always carried (staff.initials was the first
 * crash). A sparse record of every type must sync with derived defaults, and
 * records without ids must be dropped, not crash.
 */

const sparseClient = {
  listStaff: async () => [
    { id: '842b8e4a', firstName: 'Jeffrey', lastName: 'Millman', email: 'adammillman1@gmail.com' },
    { firstName: 'Ghost', lastName: 'NoId' }, // no id → dropped
  ],
  listMatterTypes: async () => [{ id: 'mt-1', name: 'Personal Injury' }],
  listMatters: async () => [{ id: 'm-1', status: 'Open' }],
  listTasks: async () => [{ id: 't-1' }],
  listEvents: async () => [{ id: 'e-1' }],
  listFolders: async () => [{ id: 'f-1' }],
  listFiles: async () => [{ id: 'fl-1' }],
  listMemos: async () => [{ id: 'memo-1' }],
} as unknown as SmokeballClient;

describe('sync survives sparse real-world payloads', () => {
  it('fullSync fills NOT NULL columns with derived defaults', async () => {
    const { db, close } = await openDb();
    const worker = new SyncWorker(db, sparseClient);
    const counts = await worker.fullSync();
    expect(counts['staff']).toBe(2); // reported count; the id-less row is dropped from the mirror

    const staff = await db.select().from(schema.staff);
    expect(staff).toHaveLength(1);
    expect(staff[0]!.initials).toBe('JM'); // derived from the name
    expect(staff[0]!.role).toBeTruthy();
    expect(staff[0]!.updatedAt).toBeTruthy();

    expect((await db.select().from(schema.matters))[0]!.description).toBe('');
    expect((await db.select().from(schema.tasks))[0]!.isCompleted).toBe(false);
    expect((await db.select().from(schema.tasks))[0]!.assigneeIds).toEqual([]);
    expect((await db.select().from(schema.events))[0]!.timeZone).toBe('America/New_York');
    expect((await db.select().from(schema.folders))[0]!.name).toBe('(unnamed folder)');
    expect((await db.select().from(schema.files))[0]!.sizeBytes).toBe(0);
    expect((await db.select().from(schema.memos))[0]!.text).toBe('');

    expect(worker.lastSync?.ok).toBe(true);
    expect(worker.lastSync?.kind).toBe('full');
    await close();
  });

  it('a failing sync records its error for diagnostics instead of staying silent', async () => {
    const { db, close } = await openDb();
    const failing = { listStaff: async () => { throw new Error('boom 401'); } } as unknown as SmokeballClient;
    const worker = new SyncWorker(db, failing);
    await expect(worker.fullSync()).rejects.toThrow('boom 401');
    expect(worker.lastSync?.ok).toBe(false);
    expect(worker.lastSync?.error).toContain('boom 401');
    await close();
  });
});
