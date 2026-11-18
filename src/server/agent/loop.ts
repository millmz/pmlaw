import { zodToJsonSchema } from 'zod-to-json-schema';
import { ALL_TOOLS, runTool, validateCitations } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { Citation } from '../tools/citations.js';
import { appNow } from '../../core/dates.js';
import { getIdentity, getKnowledge } from '../identity.js';
import { buildDynamicBlock, buildStableBlock, type SystemBlock } from './system-prompt.js';
import { memoryLines } from '../tools/memory-tools.js';
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
/** The model's own between-step notes. Passed back unchanged within a turn;
 *  never replayed into a later turn (see stripThinking). */
export interface LlmThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking?: string;
  [k: string]: unknown;
}
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | LlmThinkingBlock;

export interface LlmUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  /** Milliseconds to the first streamed character (text or note). */
  ttftMs?: number;
  ms?: number;
  usage?: LlmUsage;
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
  /** The short progress line the model writes before a lookup ("Pulling the
   *  Grasso file.") — spoken in the orb room so the wait is never silent. */
  onNote?: (delta: string) => void;
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
  /** Optional: warm the provider's prompt cache for this prefix. */
  prewarm?(params: { system: SystemBlock[]; tools: { name: string; description: string; input_schema: unknown }[] }): Promise<boolean>;
}

/** Test helper type: what a fake LLM captures about the system blocks. */
export type SystemBlockCapture = { cache: boolean; length: number; text: string }[];

/** Where a turn's time went — logged, shown in the orb's system check. */
export interface TurnTiming {
  prepMs: number;
  steps: { ttftMs: number; ms: number; tools: { name: string; ms: number }[]; cacheRead: number; input: number; output: number }[];
  totalMs: number;
}

export interface AgentTurnResult {
  text: string;
  citations: Citation[];
  citationsValid: boolean;
  toolCalls: { name: string; params: unknown }[];
  /** What each tool returned this turn — the orb room draws its panels from these. */
  toolResults: { name: string; params: unknown; data: unknown }[];
  messages: LlmMessage[];
  timing: TurnTiming;
}

export interface AgentTurnOptions {
  /** The answer will be spoken aloud: answer-first, plain sentences, brief. */
  voice?: boolean;
}

/** Thinking blocks are bound to the exact conversation that produced them.
 *  PAM's system prompt carries a live clock and snapshot, so every new turn
 *  is a different prefix — replaying an old block there is rejected on newer
 *  accounts. Within one turn they are kept; across turns they are dropped. */
export function stripThinking(history: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of history) {
    if (m.role !== 'assistant' || typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    const content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    out.push(content.length ? { ...m, content } : { ...m, content: [{ type: 'text', text: '(continuing)' }] });
  }
  return out;
}

/** Tools that change (or stage a change to) Smokeball run one at a time. */
const SERIAL_TOOL = /^(propose_|execute_|remember$|forget_)/;

const MAX_STEPS = 12; // newer models chain more tools per turn without drifting

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
  /** Called with what a tool returned (the orb room's panels). */
  onToolResult?: (name: string, params: unknown, data: unknown) => void;
}

export async function runAgentTurn(
  ctx: ToolContext,
  llm: LlmClient,
  history: LlmMessage[],
  userMessage: string,
  hooks: AgentHooks = {},
  opts: AgentTurnOptions = {},
): Promise<AgentTurnResult> {
  const t0 = performance.now();
  const messages: LlmMessage[] = [...stripThinking(history), { role: 'user', content: userMessage }];
  const tools = toolDefinitions();
  const [identity, knowledge, snapshot, memories] = await Promise.all([
    getIdentity(ctx.db),
    getKnowledge(ctx.db),
    buildSnapshot(ctx),
    memoryLines(ctx.db),
  ]);
  const system: SystemBlock[] = [
    { text: buildStableBlock(identity, knowledge), cache: true },
    {
      text: buildDynamicBlock({
        now: appNow(ctx.fixedNowIso),
        snapshot,
        memories,
        longConversation: history.length >= 28, // ~14 turns → drift checkpoint
        writesOff: ctx.writesEnabled === false,
        voice: opts.voice === true,
      }),
    },
  ];
  const citations: Citation[] = [];
  const toolCalls: { name: string; params: unknown }[] = [];
  const toolResults: AgentTurnResult['toolResults'] = [];
  const timing: TurnTiming = { prepMs: Math.round(performance.now() - t0), steps: [], totalMs: 0 };
  const finish = async (text: string): Promise<AgentTurnResult> => {
    const { valid } = await validateCitations(ctx.db, citations);
    timing.totalMs = Math.round(performance.now() - t0);
    return { text, citations, citationsValid: valid, toolCalls, toolResults, messages, timing };
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const s0 = performance.now();
    const res = await llm.create({ system, messages, tools }, { ...(hooks.onText ? { onText: hooks.onText } : {}), ...(hooks.onNote ? { onNote: hooks.onNote } : {}) });
    const stepTiming: TurnTiming['steps'][number] = {
      ttftMs: Math.round(res.ttftMs ?? 0),
      ms: Math.round(res.ms ?? performance.now() - s0),
      tools: [],
      cacheRead: res.usage?.cacheRead ?? 0,
      input: res.usage?.input ?? 0,
      output: res.usage?.output ?? 0,
    };
    timing.steps.push(stepTiming);
    const toolUses = res.content.filter((b): b is LlmToolUseBlock => b.type === 'tool_use');

    if (res.stopReason === 'refusal') {
      // The model declined (a safety classifier, sometimes on benign legal
      // facts). Say so plainly instead of going silent.
      const text = 'I wasn’t able to answer that one — the request was declined on my side. Try asking it a different way, or look in Smokeball directly.';
      hooks.onText?.(text);
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
      return finish(text);
    }

    if (res.stopReason !== 'tool_use' || toolUses.length === 0) {
      const text = res.content
        .filter((b): b is LlmTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      messages.push({ role: 'assistant', content: res.content });
      return finish(text);
    }

    messages.push({ role: 'assistant', content: res.content });
    const runOne = async (use: LlmToolUseBlock) => {
      const u0 = performance.now();
      hooks.onTool?.(use.name);
      toolCalls.push({ name: use.name, params: use.input });
      try {
        const result = await runTool(ctx, use.name, use.input);
        citations.push(...result.citations);
        toolResults.push({ name: use.name, params: use.input, data: result.data });
        hooks.onToolResult?.(use.name, use.input, result.data);
        return {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: JSON.stringify({ data: result.data, citations: result.citations, asOf: result.asOf }),
        };
      } catch (err) {
        return {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        };
      } finally {
        stepTiming.tools.push({ name: use.name, ms: Math.round(performance.now() - u0) });
      }
    };
    // Lookups run together; anything that stages or makes a change runs in order.
    const results = toolUses.some((u) => SERIAL_TOOL.test(u.name))
      ? await (async () => {
          const out = [];
          for (const use of toolUses) out.push(await runOne(use));
          return out;
        })()
      : await Promise.all(toolUses.map(runOne));
    messages.push({ role: 'user', content: results });
  }

  return finish('I hit my tool-call limit before finishing. Please try a narrower question.');
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

/** Model choice: env override, else the current Sonnet. */
export const PAM_MODEL = process.env['PAM_MODEL']?.trim() || 'claude-sonnet-5-5';

export interface AnthropicLlmOptions {
  /** How hard the model works per reply. PAM is a conversation, not a
   *  research task: `low` answers in a fraction of the time. */
  effort?: 'low' | 'medium' | 'high' | undefined;
  /** `between_tools` = no deliberation before speaking (fastest first word);
   *  the model still writes a short progress note before each lookup.
   *  Only Claude Sonnet 5.5 accepts it. `adaptive` = think when needed. */
  thinking?: 'between_tools' | 'adaptive' | 'off' | undefined;
  maxTokens?: number;
}

const defaultEffort = (): AnthropicLlmOptions['effort'] => {
  const e = process.env['PAM_EFFORT']?.trim().toLowerCase();
  return e === 'medium' || e === 'high' || e === 'low' ? e : 'low';
};

/** Production LLM client over the Anthropic SDK, with true delta streaming. */
export async function anthropicLlm(model = PAM_MODEL, opts: AnthropicLlmOptions = {}): Promise<LlmClient> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: pamApiKey() ?? null });
  const effort = opts.effort ?? defaultEffort();
  const want = opts.thinking ?? (process.env['PAM_THINKING']?.trim() || 'off');
  const wantsOff = want === 'between_tools' || want === 'off';
  // "Off" is spelled per model: `between_tools` on Sonnet 5.5 (the only model
  // that accepts it, and it rejects `disabled`); `disabled` on the models
  // that still allow it; adaptive at low effort everywhere else.
  const thinking = !wantsOff
    ? { type: 'adaptive' }
    : model.startsWith('claude-sonnet-5-5')
      ? { type: 'between_tools' }
      : /^claude-(sonnet-5|haiku-5-5|opus-5|opus-4)(?!-5)/.test(model)
        ? { type: 'disabled' }
        : { type: 'adaptive' };
  const shape = (params: Pick<Parameters<LlmClient['create']>[0], 'system' | 'tools'>) => ({
    model,
    thinking,
    output_config: { effort },
    // Block 1 carries cache_control (kept an hour — a law office asks in
    // bursts with long gaps); block 2 (date/snapshot) never does.
    system: params.system.map((b) =>
      b.cache
        ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const, ttl: '1h' } }
        : { type: 'text' as const, text: b.text },
    ),
    tools: params.tools,
  });
  return {
    async create(params, hooks) {
      const t0 = performance.now();
      let ttft: number | undefined;
      const mark = () => (ttft ??= performance.now() - t0);
      const stream = client.messages.stream({
        ...shape(params),
        max_tokens: opts.maxTokens ?? 4000,
        messages: params.messages,
      } as never);
      stream.on('text', (delta) => {
        mark();
        hooks?.onText?.(delta);
      });
      stream.on('thinking', (delta) => {
        if (!delta) return;
        mark();
        hooks?.onNote?.(delta);
      });
      const res = await stream.finalMessage();
      const u = res.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
      const stop = res.stop_reason as string | null;
      return {
        content: res.content as unknown as LlmContentBlock[],
        stopReason: (stop === 'tool_use' ? 'tool_use' : stop === 'refusal' ? 'refusal' : stop === 'max_tokens' ? 'max_tokens' : 'end_turn') as LlmResponse['stopReason'],
        ttftMs: ttft ?? performance.now() - t0,
        ms: performance.now() - t0,
        usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
      };
    },
    /** Write the stable prefix (tools + identity + rules) to the prompt
     *  cache without generating anything — so the first real question after
     *  a quiet spell does not pay to re-read it. */
    async prewarm(params) {
      try {
        await client.messages.create({
          ...shape(params),
          max_tokens: 0,
          messages: [{ role: 'user', content: 'warmup' }],
        } as never);
        return true;
      } catch {
        return false;
      }
    },
  };
}
