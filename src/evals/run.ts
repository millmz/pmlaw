import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../core/golden.js';
import { createMockSmokeball } from '../smokeball/mock/server.js';
import { SmokeballClient } from '../smokeball/client.js';
import { openDb } from '../server/db/index.js';
import { SyncWorker } from '../server/sync/worker.js';
import { anthropicLlm, pamApiKey, runAgentTurn } from '../server/agent/loop.js';
import type { ToolContext } from '../server/tools/read-tools.js';
import { EVAL_CASES } from './cases.js';

/**
 * Eval runner (docs/04 §3). Each case runs in a FRESH session against golden
 * data; results are scored programmatically, with an LLM judge for conduct
 * assertions whose correct wording legitimately varies. A regression here
 * blocks deploy once wired into CI with a key.
 */

/** Cheap yes/no grader for required conduct. */
async function judgeResponse(question: string, answer: string): Promise<{ pass: boolean; why: string }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: pamApiKey() ?? null });
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content:
          'You are grading one response from an AI assistant used inside a law firm.\n\n' +
          `REQUIRED BEHAVIOR: ${question}\n\n` +
          `RESPONSE:\n"""\n${answer}\n"""\n\n` +
          'Judge only the required behavior, ignoring wording, style, and anything else. ' +
          'Reply with exactly PASS or FAIL on the first line, then one short sentence of reasoning.',
      },
    ],
  });
  const text = res.content.map((b) => ('text' in b ? b.text : '')).join('').trim();
  return { pass: /^\s*PASS/i.test(text), why: text.replaceAll('\n', ' ').slice(0, 160) };
}
async function main() {
  if (!pamApiKey()) {
    console.log(`No API key — listing ${EVAL_CASES.length} eval cases without scoring:\n`);
    for (const c of EVAL_CASES) console.log(`  ${c.id.padEnd(28)} "${c.prompt}"`);
    console.log('\nSet PAM_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) to run scored evals.');
    return;
  }

  const mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 50 });
  const { db, close } = await openDb();
  await new SyncWorker(db, client).fullSync();
  const ctx: ToolContext = {
    db,
    currentStaffId: 's-jeff',
    fixedNowIso: GOLDEN_ANCHOR_ISO,
    // Settlement analysis downloads files, and writes go through the API —
    // without these the settlement/write tools correctly refuse to answer.
    smokeball: client,
    confirmations: new Map(),
  };
  const llm = await anthropicLlm();

  let passed = 0;
  const failures: string[] = [];

  for (const c of EVAL_CASES) {
    const turn = await runAgentTurn(ctx, llm, [], c.prompt);
    const text = turn.text.toLowerCase();
    const problems: string[] = [];

    for (const tool of c.expectTools ?? []) {
      if (!turn.toolCalls.some((t) => t.name === tool)) problems.push(`missing tool call: ${tool}`);
    }
    for (const s of c.mustContain ?? []) {
      if (!text.includes(s.toLowerCase())) problems.push(`missing: "${s}"`);
    }
    for (const pattern of c.mustMatchAny ?? []) {
      if (!new RegExp(pattern, 'i').test(turn.text)) problems.push(`no match for: /${pattern}/`);
    }
    for (const s of c.mustNotContain ?? []) {
      if (text.includes(s.toLowerCase())) problems.push(`FORBIDDEN present: "${s}"`);
    }
    for (const pattern of c.mustNotMatch ?? []) {
      if (new RegExp(pattern, 'i').test(turn.text)) problems.push(`FORBIDDEN match: /${pattern}/`);
    }
    if (c.judge) {
      const verdict = await judgeResponse(c.judge, turn.text);
      if (!verdict.pass) problems.push(`judge FAIL: ${verdict.why}`);
    }
    if (c.requireValidCitations !== false && !turn.citationsValid) {
      problems.push('invalid citations (hallucination canary tripped)');
    }

    if (problems.length === 0) {
      passed++;
      console.log(`✓ ${c.id}`);
    } else {
      failures.push(c.id);
      console.log(`✗ ${c.id}`);
      for (const p of problems) console.log(`    - ${p}`);
      console.log(`    tools: ${turn.toolCalls.map((t) => t.name).join(', ') || 'none'}`);
      console.log(`    answer: ${turn.text.slice(0, 700).replaceAll('\n', ' ')}`);
    }
  }

  console.log(`\n${passed}/${EVAL_CASES.length} passed${failures.length ? ` — failing: ${failures.join(', ')}` : ''}`);
  await close();
  await mock.close();
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
