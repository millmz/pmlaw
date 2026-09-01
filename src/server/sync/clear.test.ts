import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { clearSyncedData } from './worker.js';

const NOW = '2026-08-05T12:00:00Z';

describe('clearSyncedData (source-change guard)', () => {
  it('wipes the mirrored cache but leaves PAM-owned data alone', async () => {
    const { db, close } = await openDb();
    await db.insert(schema.staff).values({
      id: 's1', firstName: 'A', lastName: 'B', initials: 'AB', email: 'a@b.c', role: 'Attorney', updatedAt: NOW,
    });
    await db.insert(schema.matterTypes).values({
      id: 'mt1', name: 'PI', category: 'Personal Injury', location: 'NY',
    });
    await db.insert(schema.matters).values({
      id: 'm1', number: '1', status: 'Open', matterTypeId: 'mt1', clientFirstName: 'X', clientLastName: 'Y',
      description: 'd', isInSuit: false, createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(schema.tasks).values({
      id: 't1', subject: 'call', assigneeIds: ['s1'], isCompleted: false, createdById: 's1',
      createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(schema.syncState).values({ recordType: 'matters', lastSyncedAt: NOW });
    await db.insert(schema.appSettings).values({ key: 'identity.md', value: 'You are PAM.' });
    await db.insert(schema.auditLog).values({ actor: 's1', action: 'test', params: {}, result: 'ok' });

    await clearSyncedData(db);

    expect(await db.select().from(schema.staff)).toHaveLength(0);
    expect(await db.select().from(schema.matterTypes)).toHaveLength(0);
    expect(await db.select().from(schema.matters)).toHaveLength(0);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
    expect(await db.select().from(schema.syncState)).toHaveLength(0);
    // PAM's own records survive the wipe.
    expect(await db.select().from(schema.appSettings)).toHaveLength(1);
    expect(await db.select().from(schema.auditLog)).toHaveLength(1);
    await close();
  });
});
