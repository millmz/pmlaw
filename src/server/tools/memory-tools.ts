import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '../db/index.js';
import type { ToolDef } from './types.js';

/**
 * PAM's memory (docs/03 privilege rule, Operating Rule 8): working
 * preferences, corrections, and firm process ONLY. The model is told the
 * rule; this file ENFORCES it — a memory that mentions a client, a matter
 * number, or a dollar figure is refused mechanically, whatever the model
 * intended. Matter data lives in Smokeball and the snapshot, where it belongs.
 */

export const MEMORY_TYPES = ['preference', 'process', 'correction', 'pointer'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

const MATTER_NUMBER_RE = /\b\d{2}-\d{4}\b/;
const MONEY_RE = /\$\s?\d|\b\d{1,3}(,\d{3})+(\.\d+)?\b|\b\d+k\b/i;
const CASE_FACT_RE =
  /\b(plaintiff|defendant|adjuster said|policy limit|demand of|offer of|settle(d|ment) for|diagnos|injur(y|ies|ed)|surgery|liability|deposition of)\b/i;

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

/** Refuse anything that smells like a client confidence or case fact. */
export async function privilegeGuard(db: Db, text: string): Promise<GuardVerdict> {
  if (MATTER_NUMBER_RE.test(text)) return { ok: false, reason: 'it contains a matter number' };
  if (MONEY_RE.test(text)) return { ok: false, reason: 'it contains a dollar figure' };
  if (CASE_FACT_RE.test(text)) return { ok: false, reason: 'it reads like a case fact' };
  const matters = await db.select({ f: schema.matters.clientFirstName, l: schema.matters.clientLastName }).from(schema.matters);
  const lower = text.toLowerCase();
  for (const m of matters) {
    for (const name of [m.l, m.f]) {
      const n = name.trim().toLowerCase();
      if (n.length < 3) continue;
      if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
        return { ok: false, reason: `it names a client (${name})` };
      }
    }
  }
  return { ok: true };
}

export async function saveMemory(
  db: Db,
  m: { type: MemoryType; hook: string; body: string; taughtBy: string },
): Promise<{ id: string } | { refused: string }> {
  const verdict = await privilegeGuard(db, `${m.hook} ${m.body}`);
  if (!verdict.ok) {
    await db.insert(schema.auditLog).values({
      actor: m.taughtBy,
      action: 'memory:save:REFUSED_PRIVILEGE',
      params: { hook: m.hook.slice(0, 80) },
      result: verdict.reason ?? 'refused',
    });
    return {
      refused:
        `Not stored — ${verdict.reason}. Memory holds working preferences and firm process only; ` +
        'client details live in Smokeball, where they belong.',
    };
  }
  const id = randomUUID();
  await db.insert(schema.memories).values({ id, type: m.type, hook: m.hook, body: m.body, taughtBy: m.taughtBy });
  await db.insert(schema.auditLog).values({
    actor: m.taughtBy,
    action: 'memory:save',
    params: { id, type: m.type, hook: m.hook },
    result: 'saved',
  });
  return { id };
}

export async function listMemories(db: Db, limit = 60) {
  return db.select().from(schema.memories).orderBy(desc(schema.memories.createdAt)).limit(limit);
}

/** Lines for the dynamic prompt block. */
export async function memoryLines(db: Db): Promise<string[]> {
  const rows = await listMemories(db, 40);
  return rows.map((r) => `[${r.type}] ${r.hook} — ${r.body}`);
}

// ---------------------------------------------------------------- tools

const rememberSchema = z.object({
  type: z.enum(MEMORY_TYPES).describe('preference (how he likes things), process (how the firm does things), correction (something you got wrong and how to do it right), pointer (where something lives).'),
  hook: z.string().min(3).max(120).describe('One-line searchable summary, e.g. "Prefers dates spoken as weekday + day".'),
  body: z.string().min(3).max(600).describe('The memory itself, in plain words. NO client names, matter numbers, dollar figures, or case facts.'),
});

const remember: ToolDef = {
  name: 'remember',
  description:
    'Save a durable working memory: a preference, a firm process, a correction, or a pointer to where something lives. ONLY for how the user likes things done — never client confidences, case facts, amounts, or identifying details (those are refused mechanically). Say what you saved in one short sentence.',
  paramsSchema: rememberSchema,
  run: async (ctx, raw) => {
    const p = rememberSchema.parse(raw);
    const asOf = new Date().toISOString();
    const res = await saveMemory(ctx.db, { ...p, taughtBy: ctx.currentStaffId });
    return { data: 'refused' in res ? { refused: true, reason: res.refused } : { saved: true, id: res.id, hook: p.hook }, citations: [], asOf };
  },
};

const recallSchema = z.object({
  query: z.string().optional().describe('Words to look for in memory hooks/bodies. Omit to list everything remembered.'),
});

const recallMemories: ToolDef = {
  name: 'recall_memories',
  description:
    'List what you have been taught (preferences, process, corrections, pointers). Your most relevant memories are already in your context; use this to search all of them or to show the user everything you remember.',
  paramsSchema: recallSchema,
  run: async (ctx, raw) => {
    const p = recallSchema.parse(raw);
    const asOf = new Date().toISOString();
    let rows = await listMemories(ctx.db, 200);
    if (p.query) {
      const q = p.query.toLowerCase();
      rows = rows.filter((r) => `${r.hook} ${r.body}`.toLowerCase().includes(q));
    }
    return {
      data: {
        count: rows.length,
        memories: rows.map((r) => ({ id: r.id, type: r.type, hook: r.hook, body: r.body, taughtBy: r.taughtBy, savedAt: r.createdAt })),
      },
      citations: [],
      asOf,
    };
  },
};

const forgetSchema = z.object({
  memoryId: z.string().describe('The id of the memory to delete (from recall_memories).'),
});

const forgetMemory: ToolDef = {
  name: 'forget_memory',
  description:
    'Delete one memory permanently. Call ONLY after the user explicitly confirms which memory to forget in this conversation.',
  paramsSchema: forgetSchema,
  run: async (ctx, raw) => {
    const p = forgetSchema.parse(raw);
    const asOf = new Date().toISOString();
    const rows = await ctx.db.select().from(schema.memories).where(eq(schema.memories.id, p.memoryId));
    if (rows.length === 0) return { data: { error: 'No memory with that id.' }, citations: [], asOf };
    await ctx.db.delete(schema.memories).where(eq(schema.memories.id, p.memoryId));
    await ctx.db.insert(schema.auditLog).values({
      actor: ctx.currentStaffId,
      action: 'memory:forget',
      params: { id: p.memoryId, hook: rows[0]!.hook },
      result: 'deleted',
    });
    return { data: { forgotten: true, hook: rows[0]!.hook }, citations: [], asOf };
  },
};

export const MEMORY_TOOLS: ToolDef[] = [remember, recallMemories, forgetMemory];
