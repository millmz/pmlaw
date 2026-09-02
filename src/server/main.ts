import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { TokenManager, normalizeTokenUrl } from '../smokeball/auth.js';
import { eq } from 'drizzle-orm';
import { openDb, schema } from './db/index.js';
import { SyncWorker, clearSyncedData } from './sync/worker.js';
import { anthropicLlm, pamApiKey, type LlmClient } from './agent/loop.js';
import { ensureKnowledgeAdditions, putSetting } from './identity.js';
import { normalizeBaseUrl, withTimeout } from './boot.js';
import { resolveCurrentStaffId } from './staff.js';
import type { ToolContext } from './tools/types.js';
import { buildApp } from './app.js';
import { rename } from 'node:fs/promises';

/**
 * PAM entrypoint. Boots against the mock Smokeball with golden data (default)
 * or a real/staging API when SMOKEBALL_BASE_URL + credentials are provided.
 */

const PORT = Number(process.env['PORT'] ?? 8787);

const bootT0 = Date.now();
const phase = (name: string) => console.log(`[pam] boot: ${name} (+${Date.now() - bootT0}ms)`);
process.on('unhandledRejection', (e) => console.error('[pam] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[pam] uncaught exception:', e));

/**
 * Open the database, surviving a data dir wedged by an earlier crash loop:
 * if the open (including migrations) stalls or fails, the directory is moved
 * aside — preserved for inspection, never deleted — and a fresh one is
 * created. The mirror rebuilds on the next sync; only unsaved local edits to
 * settings/chat since the last good boot would be lost.
 */
async function openDbResilient(dataDir: string | undefined) {
  if (!dataDir) return openDb();
  try {
    // A real recovery on Render's disk was observed at ~29s — the margin
    // must comfortably clear that, since losing the race renames the dir.
    return await withTimeout(openDb(dataDir), 120_000, `database open at ${dataDir}`);
  } catch (e) {
    const backup = `${dataDir}.wedged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.error(`[pam] boot: ${String(e instanceof Error ? e.message : e)}`);
    console.error(`[pam] boot: moving the data dir to ${backup} and starting fresh — synced data rebuilds on the next sync`);
    await rename(dataDir, backup);
    return openDb(dataDir);
  }
}

async function main() {
  const useReal = Boolean(process.env['SMOKEBALL_BASE_URL']);
  let baseUrl: string;
  let cleanupMock: (() => Promise<void>) | undefined;
  if (useReal) {
    baseUrl = normalizeBaseUrl(process.env['SMOKEBALL_BASE_URL']!);
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
  phase('opening database');
  const { db, close: closeDb } = await openDbResilient(process.env['PAM_DATA_DIR']);
  phase('database open');
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
  phase('source guard done');

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
  phase('llm ready');

  // Bind the port BEFORE the first sync: a sync failure against the real API
  // must leave the server up (and /api/smokeball/verify reachable) rather
  // than crash-looping the deploy with no open port.
  const app = buildApp({ ctx, worker, llm, accessCode: process.env['PAM_ACCESS_CODE'] });
  phase('app built, binding port');
  const addr = await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[pam] serving at ${addr} (chat ${llm ? 'enabled' : 'DISABLED — no ANTHROPIC_API_KEY'})`);

  // Against a real tenant, "Jeff" is a UUID, not the golden 's-jeff' — after
  // every sync, re-resolve who the current user is in the mirror.
  const refreshStaff = async () => {
    const resolved = await resolveCurrentStaffId(db, ctx.currentStaffId);
    if (resolved !== ctx.currentStaffId) {
      console.log(`[pam] current staff resolved to ${resolved}`);
      ctx.currentStaffId = resolved;
    }
  };

  console.log('[pam] full sync…');
  if (useReal) {
    worker
      .fullSync()
      .then(async (c) => {
        console.log('[pam] synced:', c);
        await refreshStaff();
      })
      .catch((e) => console.error('[pam] full sync failed (server stays up; see /api/smokeball/verify):', e));
  } else {
    // The mock is local and deterministic — await it so tests and dev see
    // data the moment the port answers.
    console.log('[pam] synced:', await worker.fullSync());
  }
  const syncTimer = setInterval(() => {
    worker
      .incrementalSync()
      .then(refreshStaff)
      .catch((e) => console.error('[pam] incremental sync failed:', e));
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
