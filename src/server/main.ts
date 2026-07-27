import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from './db/index.js';
import { SyncWorker } from './sync/worker.js';
import { composeMorningBrief } from './demo/brief.js';
import { anthropicLlm, runAgentTurn, type LlmClient, type LlmMessage } from './agent/loop.js';
import type { ToolContext } from './tools/read-tools.js';

/**
 * PAM dev server. Boots against the mock Smokeball with golden data (default)
 * or a real/staging API when SMOKEBALL_BASE_URL + credentials are provided.
 * Chat requires ANTHROPIC_API_KEY; the /api/brief endpoint and the UI's
 * morning-brief panel are fully functional without it.
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

  const client = new SmokeballClient({
    baseUrl,
    apiKey: process.env['SMOKEBALL_API_KEY'] ?? 'mock-api-key',
    accessToken: process.env['SMOKEBALL_TOKEN'] ?? 'mock-token',
    rps: useReal ? 4 : 50,
  });

  const { db, close: closeDb } = await openDb();
  const worker = new SyncWorker(db, client);
  console.log('[pam] full sync…');
  console.log('[pam] synced:', await worker.fullSync());
  const syncTimer = setInterval(() => {
    worker.incrementalSync().catch((e) => console.error('[pam] incremental sync failed:', e));
  }, 60_000);

  const ctx: ToolContext = {
    db,
    currentStaffId: 's-jeff',
    // Mock data is anchored; real data uses the live clock.
    ...(useReal ? {} : { fixedNowIso: GOLDEN_ANCHOR_ISO }),
  };

  let llm: LlmClient | undefined;
  if (process.env['ANTHROPIC_API_KEY']) llm = await anthropicLlm();

  const sessions = new Map<string, LlmMessage[]>();
  const app = Fastify({ logger: false });

  // Webhook receiver — Smokeball pushes changes straight into the cache.
  app.post('/webhooks/smokeball', async (req) => {
    const { type, payload } = req.body as { type: string; payload: unknown };
    await worker.applyWebhook(type, payload);
    return {};
  });

  app.get('/api/brief', async () => {
    const brief = await composeMorningBrief(ctx);
    return brief;
  });

  app.post('/api/chat', async (req, reply) => {
    if (!llm) {
      return reply.code(501).send({
        error:
          'Chat needs ANTHROPIC_API_KEY set. The morning brief (left panel) works without it.',
      });
    }
    const { sessionId, message } = req.body as { sessionId?: string; message: string };
    const sid = sessionId ?? randomUUID();
    const history = sessions.get(sid) ?? [];
    const turn = await runAgentTurn(ctx, llm, history, message);
    sessions.set(sid, turn.messages);
    return {
      sessionId: sid,
      text: turn.text,
      citations: turn.citations,
      citationsValid: turn.citationsValid,
    };
  });

  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html'),
    'utf8',
  );
  app.get('/', async (_req, reply) => reply.type('text/html').send(html));

  const addr = await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[pam] serving at ${addr} (chat ${llm ? 'enabled' : 'DISABLED — no ANTHROPIC_API_KEY'})`);

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
