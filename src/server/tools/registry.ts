import { eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import type { Citation } from './citations.js';
import { READ_TOOLS } from './read-tools.js';
import { SETTLEMENT_TOOLS } from './settlement-tools.js';
import { WRITE_TOOLS } from './write-tools.js';
import type { ToolContext, ToolResult } from './types.js';

/** The complete closed tool registry. Capability list = exactly this. */
export const ALL_TOOLS = [...READ_TOOLS, ...SETTLEMENT_TOOLS, ...WRITE_TOOLS];

/** Run a tool by name with validation + audit logging. */
export async function runTool(ctx: ToolContext, name: string, params: unknown): Promise<ToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  const result = await tool.run(ctx, params);
  await ctx.db.insert(schema.auditLog).values({
    actor: ctx.currentStaffId,
    action: `tool:${name}`,
    params: params as Record<string, unknown>,
    result: `ok (${result.citations.length} citations)`,
  });
  return result;
}

/** Citation-integrity check (docs/04 "hallucination canary"). */
export async function validateCitations(
  db: Db,
  citations: Citation[],
): Promise<{ valid: boolean; missing: Citation[] }> {
  const missing: Citation[] = [];
  for (const c of citations) {
    const table =
      c.kind === 'matter' ? schema.matters
      : c.kind === 'task' ? schema.tasks
      : c.kind === 'event' ? schema.events
      : c.kind === 'file' ? schema.files
      : c.kind === 'memo' ? schema.memos
      : schema.staff;
    const row = await db.select({ id: table.id }).from(table).where(eq(table.id, c.id)).limit(1);
    if (row.length === 0) missing.push(c);
  }
  return { valid: missing.length === 0, missing };
}
