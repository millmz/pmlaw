import { zodToJsonSchema } from 'zod-to-json-schema';
import { READ_TOOLS, runTool, validateCitations, type ToolContext } from '../tools/read-tools.js';
import type { Citation } from '../tools/citations.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

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

export interface LlmClient {
  create(params: {
    system: string;
    messages: LlmMessage[];
    tools: { name: string; description: string; input_schema: unknown }[];
  }): Promise<LlmResponse>;
}

export interface AgentTurnResult {
  text: string;
  citations: Citation[];
  citationsValid: boolean;
  toolCalls: { name: string; params: unknown }[];
  messages: LlmMessage[];
}

const MAX_STEPS = 8;

export function toolDefinitions(): { name: string; description: string; input_schema: unknown }[] {
  return READ_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.paramsSchema, { target: 'openApi3' }),
  }));
}

export async function runAgentTurn(
  ctx: ToolContext,
  llm: LlmClient,
  history: LlmMessage[],
  userMessage: string,
): Promise<AgentTurnResult> {
  const messages: LlmMessage[] = [...history, { role: 'user', content: userMessage }];
  const tools = toolDefinitions();
  const citations: Citation[] = [];
  const toolCalls: { name: string; params: unknown }[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm.create({ system: SYSTEM_PROMPT, messages, tools });
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

/** Production LLM client over the Anthropic SDK. */
export async function anthropicLlm(model = 'claude-sonnet-5'): Promise<LlmClient> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return {
    async create(params) {
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
        messages: params.messages as never,
        tools: params.tools as never,
      });
      return {
        content: res.content as LlmContentBlock[],
        stopReason: (res.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn') as LlmResponse['stopReason'],
      };
    },
  };
}
