import { describe, expect, it } from 'vitest';
import { openDb } from './db/index.js';
import { ensureKnowledgeAdditions, getKnowledge, putSetting } from './identity.js';

describe('knowledge personal-section migration', () => {
  it('appends the section to an edited pre-existing file, keeping the edits', async () => {
    const { db, close } = await openDb();
    await putSetting(db, 'knowledge.md', '# The firm\n\nCustom edits by Jeff.');
    await ensureKnowledgeAdditions(db);
    const after = await getKnowledge(db);
    expect(after).toContain('Custom edits by Jeff.');
    expect(after).toContain('University of Miami');
    await close();
  });

  it('never resurrects the section once Jeff deletes it (flag makes it one-shot)', async () => {
    const { db, close } = await openDb();
    await putSetting(db, 'knowledge.md', '# The firm\n\nOld file.');
    await ensureKnowledgeAdditions(db);
    await putSetting(db, 'knowledge.md', '# The firm\n\nNo canes here.');
    await ensureKnowledgeAdditions(db);
    expect(await getKnowledge(db)).not.toContain('University of Miami');
    await close();
  });

  it('fresh install: the default already carries the section exactly once', async () => {
    const { db, close } = await openDb();
    await ensureKnowledgeAdditions(db);
    const k = await getKnowledge(db);
    expect(k.match(/University of Miami/g)).toHaveLength(1);
    await close();
  });
});
