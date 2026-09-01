import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { TokenManager, normalizeTokenUrl } from '../smokeball/auth.js';
import { eq } from 'drizzle-orm';
import { openDb, schema } from './db/index.js';
import { SyncWorker, clearSyncedData } from './sync/worker.js';
import { anthropicLlm, pamApiKey, type LlmClient } from './agent/loop.js';
import { ensureKnowledgeAdditions, putSetting } from './identity.js';
import type { ToolContext } from './tools/types.js';
import { buildApp } from './app.js';

/**
 * PAM entrypoint. Boots against the mock Smokeball with golden data (default)
 * or a real/staging API when SMOKEBALL_BASE_URL + credentials are provided.
 */

const PORT = Number(process.env['PORT'] ?? 8787);

async function main() {
  const useReal = Boolean(process.env['SMOKEBALL_BASE_URL']);
  let baseUrl: string;
  let cleanupMock: (() => Promise<void>) | undefined;
  if (useReal) {
    baseUrl = process.env['SMOKEBALL_BASE_URL']!;
  } else {
    const mock = createMockSmokeball(buildGoldenDataset());
    baseUrl = await mock.listen();
    cleanupMock = mock.close;
    console.log(`[pam] mock Smokeball at ${baseUrl}`);
  }

  // Live OAuth when the dev-console credentials are present; static token
  // (the mock, or a hand-issued bearer) otherwise. docs/02 "Auth".
  const authUrl = process.env['SMOKEBALL_AUTH_URL']?.trim();
  const clientId = process.env['SMOKEBALL_CLIENT_ID']?.trim();
  let tokenProvider: TokenManager | undefined;
  if (useReal && authUrl && clientId) {
    tokenProvider = new TokenManager({
      tokenUrl: normalizeTokenUrl(authUrl),
      clientId,
      ...(process.env['SMOKEBALL_CLIENT_SECRET']?.trim()
        ? { clientSecret: process.env['SMOKEBALL_CLIENT_SECRET']!.trim() }
        : {}),
      ...(process.env['SMOKEBALL_REFRESH_TOKEN']?.trim()
        ? { refreshToken: process.env['SMOKEBALL_REFRESH_TOKEN']!.trim() }
        : {}),
      ...(process.env['SMOKEBALL_SCOPE']?.trim() ? { scope: process.env['SMOKEBALL_SCOPE']!.trim() } : {}),
    });
    console.log(`[pam] smokeball oauth: ${tokenProvider.grant} grant via ${normalizeTokenUrl(authUrl)}`);
  }

  const client = new SmokeballClient({
    baseUrl,
    apiKey: process.env['SMOKEBALL_API_KEY'] ?? 'mock-api-key',
    accessToken: process.env['SMOKEBALL_TOKEN'] ?? 'mock-token',
    ...(tokenProvider ? { tokenProvider } : {}),
    rps: useReal ? 4 : 50,
  });

  // PAM_DATA_DIR (a persistent disk in production) makes sessions, memories,
  // and Jeff's identity edits survive restarts; unset = in-memory (dev/tests).
  const { db, close: closeDb } = await openDb(process.env['PAM_DATA_DIR']);
  await ensureKnowledgeAdditions(db); // one-shot: teach an existing DB who Jeff is

  // Source-change guard: sync only upserts, so switching data sources (mock →
  // staging → production) must wipe the mirrored cache or old records linger.
  // PAM's own data (chat, settings, audit, memories) is untouched.
  const source = useReal ? new URL(baseUrl).host : 'mock';
  const prevSource = (
    await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'sync.source')).limit(1)
  )[0]?.value;
  if (prevSource !== undefined && prevSource !== source) {
    console.log(`[pam] data source changed (${prevSource} → ${source}) — clearing synced cache`);
    await clearSyncedData(db);
  }
  await putSetting(db, 'sync.source', source);

  const worker = new SyncWorker(db, client);

  const ctx: ToolContext = {
    db,
    currentStaffId: 's-jeff',
    smokeball: client,
    confirmations: new Map(),
    // Mock data is anchored; real data uses the live clock.
    ...(useReal ? {} : { fixedNowIso: GOLDEN_ANCHOR_ISO }),
  };

  let llm: LlmClient | undefined;
  if (pamApiKey()) llm = await anthropicLlm();

  // Bind the port BEFORE the first sync: a sync failure against the real API
  // must leave the server up (and /api/smokeball/verify reachable) rather
  // than crash-looping the deploy with no open port.
  const app = buildApp({ ctx, worker, llm, accessCode: process.env['PAM_ACCESS_CODE'] });
  const addr = await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[pam] serving at ${addr} (chat ${llm ? 'enabled' : 'DISABLED — no ANTHROPIC_API_KEY'})`);

  console.log('[pam] full sync…');
  if (useReal) {
    worker
      .fullSync()
      .then((c) => console.log('[pam] synced:', c))
      .catch((e) => console.error('[pam] full sync failed (server stays up; see /api/smokeball/verify):', e));
  } else {
    // The mock is local and deterministic — await it so tests and dev see
    // data the moment the port answers.
    console.log('[pam] synced:', await worker.fullSync());
  }
  const syncTimer = setInterval(() => {
    worker.incrementalSync().catch((e) => console.error('[pam] incremental sync failed:', e));
  }, 60_000);

  const shutdown = async () => {
    clearInterval(syncTimer);
    await app.close();
    await closeDb();
    await cleanupMock?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
