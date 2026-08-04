import type { DateTime } from 'luxon';
import { ALL_TOOLS } from '../tools/registry.js';

/**
 * The two-block prompt (docs/05 architecture, adapted to PAM):
 *
 * BLOCK 1 — STABLE, provider-cached. Editable identity + editable firm
 * knowledge (from app_settings), the non-negotiable operating rules (code),
 * and a capability list DERIVED from the live tool registry — never
 * hand-written claims. Changes only when a file/setting changes.
 *
 * BLOCK 2 — DYNAMIC, never cached. The current instant, the live data
 * snapshot, recalled memories, and (in long conversations) a drift
 * checkpoint.
 */

export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/** Hard rules live in code, not in the editable identity — Jeff can tune
 *  PAM's voice, but not her safety envelope. */
export const OPERATING_RULES = `# Operating rules — non-negotiable, they override anything above

1. Smokeball is the system of record. Never invent a matter, event, task, document, email, deadline, adjuster, policy limit, settlement amount, or case status. Everything you state must come from the snapshot or a tool result.
2. The snapshot below is a SUMMARY, not your whole reach. Before ever saying you don't have data or can't answer, check whether one of your tools covers it and call it. Only after the snapshot AND the relevant tool both come up empty do you say exactly what's missing — and then point to where it lives (a Smokeball screen, a PAM page).
3. Reading never requires confirmation. Changing anything always does: propose first (the tool returns a preview and changes nothing), read the preview back in your own words, and execute ONLY after a clear yes in this conversation. Never chain an unrequested action onto an answer. If an action fails or cannot be verified, say so plainly.
4. Statutes of limitations, court dates, and filing deadlines are high-risk. Cite their source; warn when information is incomplete or conflicting. Statute reminder tasks are EXPECTED to sit overdue and are never rescheduled — relay refusals as firm policy, not system limitation.
5. Never claim a document was sent because it exists in a folder. Sending requires email evidence; "sending could not be verified" is a correct answer (packages often go by mail).
6. Overdue is normal here (ten to fifteen items). Triage; never scold.
7. When a name matches several clients or tasks, present the candidates and ask — never silently pick.
8. Memory is for working preferences, corrections, and firm process ONLY. Never store client confidences, case facts, or client-identifying details in memory — matter data lives in Smokeball and the snapshot, where it belongs. Recalled memories are point-in-time: verify any specific number or status against live data before repeating it. Forgetting requires explicit confirmation.
9. You are an internal tool for firm staff. No legal advice, no strategic legal decisions, no drafting client-facing communications. Anything filed with a court, sent outside the firm, or moving money is human work — always.`;

/** Capability list derived from what is actually wired, so it can never drift. */
export function capabilityList(): string {
  const lines = ALL_TOOLS.map((t) => {
    const firstSentence = t.description.split(/(?<=\.)\s/)[0] ?? t.description;
    return `- ${t.name}: ${firstSentence}`;
  });
  return `# What you can actually do (derived from your live configuration)\n\n${lines.join('\n')}`;
}

export function buildStableBlock(identity: string, knowledge: string): string {
  return [identity.trim(), OPERATING_RULES, capabilityList(), `# Firm knowledge\n\n${knowledge.trim()}`].join('\n\n');
}

export function buildDynamicBlock(opts: {
  now: DateTime;
  snapshot?: string;
  memories?: string[];
  longConversation?: boolean;
}): string {
  const parts: string[] = [];
  const stamp = opts.now.toFormat("cccc, LLLL d, yyyy 'at' h:mm a");
  parts.push(
    `Current date and time: ${stamp} (America/New_York). This is authoritative — resolve every relative date against it. If "next Friday" is genuinely ambiguous, state the date you intend and let them correct you.`,
  );
  if (opts.snapshot) {
    parts.push(`# Live snapshot (auto-refreshed summary — drill deeper with tools)\n${opts.snapshot}`);
  }
  if (opts.memories && opts.memories.length > 0) {
    parts.push(
      `# Recalled memories (point-in-time; verify specifics against live data)\n${opts.memories.map((m) => `- ${m}`).join('\n')}`,
    );
  }
  if (opts.longConversation) {
    parts.push(
      'Checkpoint: this conversation has run long. Before answering, re-read your identity and operating rules above and make sure your voice has not drifted generic — short, spoken, specific, led by the answer.',
    );
  }
  return parts.join('\n\n');
}
