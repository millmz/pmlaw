import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_ANCHOR_ISO } from '../../core/golden.js';
import { createMockSmokeball, type MockSmokeball } from '../../smokeball/mock/server.js';
import { SmokeballClient } from '../../smokeball/client.js';
import { openDb, type Db } from '../db/index.js';
import { SyncWorker } from '../sync/worker.js';
import type { ToolContext } from '../tools/read-tools.js';
import { runAgentTurn, toolDefinitions, type LlmClient, type LlmResponse } from './loop.js';

let mock: MockSmokeball;
let db: Db;
let closeDb: () => Promise<void>;
let ctx: ToolContext;

beforeAll(async () => {
  mock = createMockSmokeball(buildGoldenDataset());
  const base = await mock.listen();
  const client = new SmokeballClient({ baseUrl: base, apiKey: 'mock-api-key', accessToken: 'mock-token', rps: 200 });
  const opened = await openDb();
  db = opened.db;
  closeDb = opened.close;
  await new SyncWorker(db, client).fullSync();
  ctx = { db, currentStaffId: 's-jeff', fixedNowIso: GOLDEN_ANCHOR_ISO };
});

afterAll(async () => {
  await mock.close();
  await closeDb();
});

/** Scripted LLM: emits each canned response in order. */
const scripted = (responses: LlmResponse[]): LlmClient => {
  let i = 0;
  return {
    async create() {
      const r = responses[i];
      if (!r) throw new Error('script exhausted');
      i++;
      return r;
    },
  };
};

describe('agent loop', () => {
  it('exposes the full tool registry with JSON-schema inputs', () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([
      'get_calendar_events',
      'get_tasks',
      'search_matters',
      'get_matter_overview',
      'find_stalled_matters',
      'list_firm_staff',
    ]);
    const cal = defs[0]!.input_schema as { properties: Record<string, unknown> };
    expect(Object.keys(cal.properties)).toContain('scope');
  });

  it('runs a two-tool morning-brief turn, threads results, and collects valid citations', async () => {
    const llm = scripted([
      {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'get_calendar_events', input: { scope: 'today' } },
          { type: 'tool_use', id: 'tu-2', name: 'get_tasks', input: { status: 'overdue' } },
        ],
      },
      {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Good morning Jeff — three events today; two overdue items need decisions.' }],
      },
    ]);
    const turn = await runAgentTurn(ctx, llm, [], 'What does my day look like?');
    expect(turn.text).toContain('Good morning');
    expect(turn.toolCalls.map((c) => c.name)).toEqual(['get_calendar_events', 'get_tasks']);
    // 6 events + 3 overdue tasks cited, all real records:
    expect(turn.citations.length).toBe(9);
    expect(turn.citationsValid).toBe(true);
    // Tool results were threaded back as tool_result blocks:
    const toolResultMsg = turn.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('surfaces tool errors to the model instead of crashing the turn', async () => {
    const llm = scripted([
      {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'get_matter_overview', input: {} }], // missing matterId
      },
      {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'I need to search for the matter first — which client?' }],
      },
    ]);
    const turn = await runAgentTurn(ctx, llm, [], 'Give me the overview');
    expect(turn.text).toContain('which client');
    const resultBlocks = turn.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: string } => (b as { type: string }).type === 'tool_result');
    expect(resultBlocks[0]!.content).toContain('error');
  });

  it('stops at the step limit with an honest message', async () => {
    const infinite: LlmClient = {
      async create() {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'x', name: 'list_firm_staff', input: {} }],
        };
      },
    };
    const turn = await runAgentTurn(ctx, infinite, [], 'loop forever');
    expect(turn.toolCalls.length).toBe(8);
    expect(turn.text).toContain('tool-call limit');
  });
});
