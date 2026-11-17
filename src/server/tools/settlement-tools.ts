import { z } from 'zod';
import { getSettlementBoard as loadBoard, analyzeMatter } from '../settlement/engine.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';

/** Settlement tools — chat and the Settlements page share these, so the
 *  board and the conversation can never disagree. */

const boardSchema = z.object({
  limit: z.number().optional().describe('Max matters to return, ranked by most recent negotiation activity. Default all.'),
});

const getSettlementBoard: ToolDef = {
  name: 'get_settlement_board',
  description:
    'The settlement status board: every open matter with settlement activity, ranked by most recent negotiation. Each row: status (with reason; demand_made = a demand is noted but no offer yet), insurer, adjuster name/email/phone, claim number, policy limits, liens, demand, current offer (+date/by), injuries, follow-up task state, who negotiated last, and full citations. Use for "what am I negotiating", "top five cases", "which packages need follow-up". NEVER claim a package was sent unless status is sent_verified/sent_acknowledged — prepared_unverified means sending could not be verified (may have gone by mail). A row with `interpreted` fields had those values read from free-form notes rather than labelled ones — say "per the notes" for them.',
  paramsSchema: boardSchema,
  run: async (ctx, raw) => settlementBoardResult(ctx, boardSchema.parse(raw).limit, 40_000),
};

/** Shared by the chat tool and the Settle page (which waits less and polls). */
export async function settlementBoardResult(ctx: ToolContext, limit: number | undefined, maxWaitMs: number): Promise<ToolResult> {
  {
    const p = { limit };
    if (!ctx.smokeball) throw new Error('settlement analysis unavailable: no Smokeball connection');
    // Never hang a conversation (or the page) on a cold first read of a big
    // firm: past the wait, answer with what is ready and say it is partial.
    const res = await loadBoard(ctx.db, ctx.smokeball, ctx.fixedNowIso, maxWaitMs);
    const board = res.summaries;
    const rows = p.limit ? board.slice(0, p.limit) : board;
    return {
      data: {
        count: rows.length,
        ...(res.warming
          ? {
              warming: true,
              progress: { done: res.done, total: res.total },
              note: `PARTIAL: PAM is still reading the firm's matters (${res.done} of ${res.total} analyzed). Say so plainly and offer to check again in a few minutes — do not present this as the complete list.`,
            }
          : {}),
        matters: rows.map((s) => ({
          matterId: s.matterId,
          matter: s.matterLabel,
          status: s.status,
          statusReason: s.statusReason,
          ...s.facts,
          packageSentDate: s.packageSentDate,
          packageSentTo: s.packageSentTo,
          followUp: s.followUp,
          lastNegotiationAt: s.lastNegotiationAt,
          lastNegotiationBy: s.lastNegotiationBy,
        })),
      },
      citations: rows.flatMap((s) => s.citations),
      asOf: new Date().toISOString(),
    };
  }
}

const timelineSchema = z.object({
  matterId: z.string().describe('Matter id from search_matters or the board.'),
});

const getSettlementTimeline: ToolDef = {
  name: 'get_settlement_timeline',
  description:
    'The evidence-backed settlement timeline for one matter: package prepared → sent (only if verified by email evidence) → acknowledged → offers → follow-up tasks. Every entry cites its source record. "Sending could not be verified" is an honest, expected outcome for mail-only sends.',
  paramsSchema: timelineSchema,
  run: async (ctx, raw) => {
    const p = timelineSchema.parse(raw);
    if (!ctx.smokeball) throw new Error('settlement analysis unavailable: no Smokeball connection');
    const s = await analyzeMatter(ctx.db, ctx.smokeball, p.matterId, ctx.fixedNowIso);
    if (!s) {
      return { data: { error: `No matter with id ${p.matterId}` }, citations: [], asOf: new Date().toISOString() };
    }
    return {
      data: {
        matter: s.matterLabel,
        status: s.status,
        statusReason: s.statusReason,
        facts: s.facts,
        timeline: s.timeline.map((t) => ({ date: t.date.slice(0, 10), event: t.label })),
      },
      citations: s.citations,
      asOf: new Date().toISOString(),
    };
  },
};

export const SETTLEMENT_TOOLS: ToolDef[] = [getSettlementBoard, getSettlementTimeline];
