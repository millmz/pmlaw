import { DateTime } from 'luxon';
import type { LlmClient } from '../agent/loop.js';

/**
 * Fallback reader for free-form settlement notes.
 *
 * The regex parser understands the firm's labelled notes ("Demand: $250,000.
 * Offer: $110,000 made 7/21 by Kevin Boland"). Notes written as plain
 * sentences ("Boland came up to 45k on the 3rd, we're holding at 120")
 * defeat it, and the case silently drops off the board. For those — and only
 * those — a small model reads the notes.
 *
 * A model reading money figures in a legal file must not be trusted on its
 * word. Every value it returns is checked against the note text: an amount,
 * name, claim number, or date that does not literally appear in the notes is
 * discarded. The model can only point at what is written; it cannot add.
 */

export interface NoteInput {
  id: string;
  /** ISO timestamp of the note's last edit. */
  date: string;
  text: string;
}

export interface ModelNoteFacts {
  insurer?: string;
  claimNumber?: string;
  policyLimits?: string;
  adjusterName?: string;
  demand?: string;
  offer?: string;
  offerDateText?: string;
  offerBy?: string;
  defenseCounsel?: string;
  sourceNoteIds?: string[];
}

export type NoteReader = (notes: NoteInput[]) => Promise<ModelNoteFacts | null>;

const SYSTEM = `You read a plaintiff trial firm's internal matter notes and report the current settlement posture.

Output ONLY one JSON object, no prose, no code fence. Include a field only when the notes state it; omit it otherwise.

{
  "demand": "our side's most recent settlement demand, the amount exactly as written",
  "offer": "the other side's most recent settlement offer, the amount exactly as written",
  "offerDateText": "the date of that offer, copied exactly as it is written in the notes",
  "offerBy": "who made the offer, the name exactly as written",
  "insurer": "the insurance carrier, exactly as written",
  "adjusterName": "the adjuster's name, exactly as written",
  "claimNumber": "exactly as written",
  "policyLimits": "the policy limit amount, exactly as written",
  "defenseCounsel": "exactly as written",
  "sourceNoteIds": ["ids of the notes you took these from"]
}

Rules:
- Copy, never compute or infer. If an amount is written "45k", return "45k".
- When several offers or demands appear, report the most recent one.
- A plea offer, a fee, a lien, a medical bill, or a verdict is not a settlement offer or demand.
- If the notes do not state a settlement demand or offer in dollars, output {}.`;

export function llmNoteReader(llm: LlmClient): NoteReader {
  return async (notes) => {
    const body = notes
      .map((n) => `[note id=${n.id} edited=${n.date.slice(0, 10)}]\n${n.text}`)
      .join('\n\n')
      .slice(0, 14_000);
    const res = await llm.create(
      { system: [{ text: SYSTEM }], messages: [{ role: 'user', content: `${body}\n\nJSON object:` }], tools: [] },
      {},
    );
    const text = res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as ModelNoteFacts) : null;
    } catch {
      return null;
    }
  };
}

/** "$45,000", "45k", "1.5 million", "$1.2M" → dollars. */
export function parseAmount(raw: string): number | undefined {
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k|thousand|mm|mil|million|m)?\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === 'k' || unit === 'thousand' ? 1_000 : unit ? 1_000_000 : 1;
  return Math.round(n * mult);
}

export const formatAmount = (n: number): string => `$${n.toLocaleString('en-US')}`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this dollar amount literally appear in the text, in any of the ways
 *  an office writes it (45,000 · 45000 · 45k · 1.5 million)? */
export function amountAppears(n: number, text: string): boolean {
  const forms = new Set<string>([n.toLocaleString('en-US'), String(n)]);
  if (n >= 1_000 && n % 500 === 0 && n < 1_000_000) {
    const k = n / 1_000;
    for (const u of ['k', ' k', ' thousand']) forms.add(`${k}${u}`);
  }
  if (n >= 1_000_000 && n % 10_000 === 0) {
    const mm = n / 1_000_000;
    for (const u of ['m', ' m', 'mm', ' mil', ' million']) forms.add(`${mm}${u}`);
  }
  return [...forms].some((f) => new RegExp(`(?<![\\d.,])${esc(f)}(?![\\d]|,\\d|[a-z])`, 'i').test(text));
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface GuardedNoteFacts {
  facts: Omit<ModelNoteFacts, 'offerDateText' | 'sourceNoteIds'> & { offerDate?: string };
  sourceMemoIds: string[];
  /** Fields the model returned that the notes did not bear out. */
  rejected: string[];
}

/** Keep only what the notes literally say. */
export function guardModelFacts(
  raw: ModelNoteFacts,
  notes: NoteInput[],
  normalizeDate: (s: string, now?: DateTime) => string | undefined,
): GuardedNoteFacts {
  const all = notes.map((n) => n.text).join('\n');
  const hay = squash(all);
  const out: GuardedNoteFacts = { facts: {}, sourceMemoIds: [], rejected: [] };
  const amounts: number[] = [];

  for (const key of ['demand', 'offer', 'policyLimits'] as const) {
    const v = raw[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const n = parseAmount(v);
    if (n !== undefined && n >= 100 && amountAppears(n, all)) {
      out.facts[key] = formatAmount(n);
      if (key !== 'policyLimits') amounts.push(n);
    } else out.rejected.push(key);
  }
  for (const key of ['insurer', 'adjusterName', 'offerBy', 'defenseCounsel', 'claimNumber'] as const) {
    const v = raw[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const s = v.trim();
    if (s.length <= 80 && hay.includes(squash(s))) out.facts[key] = s;
    else out.rejected.push(key);
  }
  if (out.facts.offer && typeof raw.offerDateText === 'string' && raw.offerDateText.trim()) {
    const s = raw.offerDateText.trim();
    const src = notes.find((n) => squash(n.text).includes(squash(s)));
    // A date with no year means the year the note was written.
    const iso = src ? normalizeDate(s, DateTime.fromISO(src.date)) : undefined;
    if (iso) out.facts.offerDate = iso;
    else out.rejected.push('offerDateText');
  }
  // Attribution: the notes the model named (if real), else those carrying the figures.
  const known = new Set(notes.map((n) => n.id));
  const named = (Array.isArray(raw.sourceNoteIds) ? raw.sourceNoteIds : []).filter((id) => typeof id === 'string' && known.has(id));
  const carrying = notes.filter((n) => amounts.some((a) => amountAppears(a, n.text))).map((n) => n.id);
  out.sourceMemoIds = [...new Set(carrying.length ? carrying : named)];
  return out;
}
