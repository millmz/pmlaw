import { zodToJsonSchema } from 'zod-to-json-schema';
import { ALL_TOOLS, runTool, validateCitations } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { Citation } from '../tools/citations.js';
import { appNow } from '../../core/dates.js';
import { getIdentity, getKnowledge } from '../identity.js';
import { buildDynamicBlock, buildStableBlock, type SystemBlock } from './system-prompt.js';
import { buildSnapshot } from './snapshot.js';

/**
 * The agent loop (docs/01): Claude calls tools from the closed registry until
 * it has an answer. The LLM is injected behind a minimal interface so tests
 * and the walking-skeleton demo run with a scripted fake, and production uses
 * the Anthropic SDK — same loop either way.
 */

// Minimal shapes for the slice of the Messages API the loop touches.
export interface LlmTextBlock {
  type: 'text';
  text: string;
}
export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock;

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | (
        | LlmContentBlock
        | { type: 'tool_result'; tool_use_id: string; content: string }
      )[];
}

export interface LlmHooks {
  /** Called with incremental text as the model produces it (streaming UIs). */
  onText?: (delta: string) => void;
}

export interface LlmClient {
  create(
    params: {
      /** Two blocks: [0] stable+cacheable, [1] dynamic (docs/05 architecture). */
      system: SystemBlock[];
      messages: LlmMessage[];
      tools: { name: string; description: string; input_schema: unknown }[];
    },
    hooks?: LlmHooks,
  ): Promise<LlmResponse>;
}

/** Test helper type: what a fake LLM captures about the system blocks. */
export type SystemBlockCapture = { cache: boolean; length: number; text: string }[];

export interface AgentTurnResult {
  text: string;
  citations: Citation[];
  citationsValid: boolean;
  toolCalls: { name: string; params: unknown }[];
  messages: LlmMessage[];
}

const MAX_STEPS = 8;

export function toolDefinitions(): { name: string; description: string; input_schema: unknown }[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.paramsSchema, { target: 'openApi3' }),
  }));
}

export interface AgentHooks extends LlmHooks {
  /** Called when a tool is about to run (progress UIs). */
  onTool?: (name: string) => void;
}

export async function runAgentTurn(
  ctx: ToolContext,
  llm: LlmClient,
  history: LlmMessage[],
  userMessage: string,
  hooks: AgentHooks = {},
): Promise<AgentTurnResult> {
  const messages: LlmMessage[] = [...history, { role: 'user', content: userMessage }];
  const tools = toolDefinitions();
  const [identity, knowledge, snapshot] = [
    await getIdentity(ctx.db),
    await getKnowledge(ctx.db),
    await buildSnapshot(ctx),
  ];
  const system: SystemBlock[] = [
    { text: buildStableBlock(identity, knowledge), cache: true },
    {
      text: buildDynamicBlock({
        now: appNow(ctx.fixedNowIso),
        snapshot,
        longConversation: history.length >= 28, // ~14 turns → drift checkpoint
      }),
    },
  ];
  const citations: Citation[] = [];
  const toolCalls: { name: string; params: unknown }[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm.create(
      { system, messages, tools },
      hooks.onText ? { onText: hooks.onText } : {},
    );
    const toolUses = res.content.filter((b): b is LlmToolUseBlock => b.type === 'tool_use');

    if (res.stopReason !== 'tool_use' || toolUses.length === 0) {
      const text = res.content
        .filter((b): b is LlmTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const { valid } = await validateCitations(ctx.db, citations);
      messages.push({ role: 'assistant', content: res.content });
      return { text, citations, citationsValid: valid, toolCalls, messages };
    }

    messages.push({ role: 'assistant', content: res.content });
    const results: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];
    for (const use of toolUses) {
      hooks.onTool?.(use.name);
      toolCalls.push({ name: use.name, params: use.input });
      try {
        const result = await runTool(ctx, use.name, use.input);
        citations.push(...result.citations);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ data: result.data, citations: result.citations, asOf: result.asOf }),
        });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  const { valid } = await validateCitations(ctx.db, citations);
  return {
    text: 'I hit my tool-call limit before finishing. Please try a narrower question.',
    citations,
    citationsValid: valid,
    toolCalls,
    messages,
  };
}

/** The API key for PAM's own Anthropic calls. PAM_ANTHROPIC_API_KEY takes
 *  precedence because managed environments (e.g. Claude Code cloud sessions)
 *  reserve/strip the plain ANTHROPIC_API_KEY name. Values are trimmed
 *  (paste artifacts) and empty strings ignored, and the WRONG-vendor guard
 *  skips a variable that plainly holds a non-Anthropic key rather than
 *  letting it shadow a good one. */
export function pamApiKey(): string | undefined {
  return pamApiKeyInfo().key;
}

export interface KeyInfo {
  key?: string;
  source: 'PAM_ANTHROPIC_API_KEY' | 'ANTHROPIC_API_KEY' | 'none';
  prefix: string;
  length: number;
  looksAnthropic: boolean;
  /** Variables that were present but skipped, with why — the audit trail. */
  skipped: string[];
}

export function pamApiKeyInfo(): KeyInfo {
  const skipped: string[] = [];
  for (const name of ['PAM_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'] as const) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const key = raw.trim();
    if (!key) {
      skipped.push(`${name}: present but empty`);
      continue;
    }
    if (!key.startsWith('sk-ant-')) {
      skipped.push(`${name}: does not look like an Anthropic key (starts "${key.slice(0, 4)}…") — skipped so it can't shadow a good one`);
      continue;
    }
    return { key, source: name, prefix: key.slice(0, 7), length: key.length, looksAnthropic: true, skipped };
  }
  return { source: 'none', prefix: '', length: 0, looksAnthropic: false, skipped };
}

/** Production LLM client over the Anthropic SDK, with true delta streaming. */
export async function anthropicLlm(model = 'claude-sonnet-5'): Promise<LlmClient> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: pamApiKey() ?? null });
  return {
    async create(params, hooks) {
      const stream = client.messages.stream({
        model,
        max_tokens: 4000,
        // Block 1 carries cache_control; block 2 (date/snapshot) never does.
        system: params.system.map((b) =>
          b.cache
            ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } }
            : { type: 'text' as const, text: b.text },
        ),
        messages: params.messages as never,
        tools: params.tools as never,
      });
      if (hooks?.onText) stream.on('text', (delta) => hooks.onText!(delta));
      const res = await stream.finalMessage();
      return {
        content: res.content as LlmContentBlock[],
        stopReason: (res.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn') as LlmResponse['stopReason'],
      };
    },
  };
}
