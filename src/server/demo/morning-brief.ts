import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import { composeMorningBrief } from './brief.js';

/**
 * Walking-skeleton demo (docs/06 Phase A exit): boot the mock Smokeball,
 * sync the cache, compose Jeff's morning brief from the tool layer, print it.
 * Run with: pnpm demo
 */
async function main() {
  console.log('Starting mock Smokeball…');
  const mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();

  console.log('Syncing cache…');
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 50 });
  const { db, close } = await openDb();
  const counts = await new SyncWorker(db, client).fullSync();
  console.log(
    'Synced:',
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', '),
  );

  const { text } = await composeMorningBrief({
    db,
    currentStaffId: 's-jeff',
    fixedNowIso: GOLDEN_ANCHOR_ISO,
  });

  console.log('\n═══ PAM — MORNING BRIEF · Jeff Millman ═══\n');
  console.log(text);

  await close();
  await mock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
