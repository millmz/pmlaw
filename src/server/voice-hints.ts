import { closestNames, editDistance, nameSimilarity } from '../core/fuzzy.js';
import { mirror } from './db/mirror.js';
import type { ToolContext } from './tools/types.js';

/**
 * Helping PAM hear names.
 *
 * A speech recognizer knows English, not this firm. It writes "grass oh"
 * for Grasso, "oak afore" for Okafor, "fountain a" for Fontana — and a
 * question about a client becomes a question about nobody. For a SPOKEN
 * question, the transcript is compared against the names the firm actually
 * has on file (clients, staff, and the adjusters, carriers and counsel in
 * its settlement notes); close matches are handed to the model as a note:
 * "this may have been that". The model decides — nothing is rewritten
 * behind its back, and it is told to say which file it pulled.
 */

interface VocabEntry {
  name: string;
  kind: 'client' | 'staff' | 'adjuster' | 'carrier' | 'counsel';
}

/** Ordinary words of the trade — never "corrected" into somebody's name. */
const COMMON = new Set(
  (
    'a about adjuster after again all also am an and any appointment appointments are around as ask at back be been before brief briefing but by call calls calendar can case cases ' +
    'check claim client clients conference could court create date day days demand deposition did do docket does done due email event events file files find first five for four ' +
    'from get give go going good got had has have hearing help her him his how in is it its just know last late later latest left let like list look made make many matter matters ' +
    'me meeting mine monday friday tuesday wednesday thursday saturday sunday more morning most move much my need negotiating negotiation new next no not note notes now of off offer ' +
    'offers office on one only open or other our out over overdue package pam please policy pull put read ready remind reminder reschedule rest right say schedule second see send ' +
    'sent set settle settlement should show since so some stand standing start status still suit take task tasks tell than thank thanks that the their them then there these they ' +
    'thing things think this those three time to today tomorrow top trial two under until up update us was we week weeks well went were what when where which who whose why will ' +
    'with would yes yesterday yet you your limits lien liens insurance carrier statute plaintiff defendant motion judge versus regarding where\'s what\'s who\'s how\'s'
  ).split(' '),
);

export async function firmVocabulary(ctx: ToolContext): Promise<VocabEntry[]> {
  return mirror.derived(ctx.db, 'voice-vocab', async () => {
    const out = new Map<string, VocabEntry>();
    const add = (raw: string | null | undefined, kind: VocabEntry['kind']) => {
      const name = (raw ?? '').replace(/\(.*?\)/g, '').trim();
      // A real name: letters, not too long, not a sentence, not an everyday word.
      if (name.length < 3 || name.length > 40 || !/^[A-Za-z][A-Za-z.'& -]*$/.test(name)) return;
      if (COMMON.has(name.toLowerCase())) return;
      const key = name.toLowerCase();
      if (!out.has(key)) out.set(key, { name, kind });
    };
    for (const s of await mirror.staff(ctx.db)) {
      add(s.firstName, 'staff');
      add(s.lastName, 'staff');
    }
    const matters = await mirror.matters(ctx.db);
    // Open matters first, so on a tie the live client wins.
    for (const m of [...matters].sort((a, b) => Number(b.status === 'Open') - Number(a.status === 'Open'))) {
      add(m.clientLastName, 'client');
      if (m.clientFirstName) add(m.clientFirstName, 'client');
    }
    try {
      const { peekSettlementBoard } = await import('./settlement/engine.js');
      for (const s of peekSettlementBoard(ctx.db) ?? []) {
        for (const full of [s.facts.adjusterName, s.facts.offerBy]) {
          add(full, 'adjuster');
          add(full?.split(/\s+/).at(-1), 'adjuster');
        }
        add(s.facts.insurer, 'carrier');
        add(s.facts.defenseCounsel?.split(',')[0], 'counsel');
      }
    } catch {
      /* the board is optional context */
    }
    return [...out.values()];
  });
}

const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
const squash = (s: string): string => s.toLowerCase().replace(/'s\b/g, '').replace(/[^a-z]/g, '');

export interface NameHint {
  heard: string;
  name: string;
  kind: VocabEntry['kind'];
  score: number;
}

/** Stretches of the transcript that sound like a name on file but are not
 *  spelled like one. Pure. */
export function nameHints(transcript: string, vocab: VocabEntry[]): NameHint[] {
  const words = tokens(transcript);
  const exact = new Set(vocab.map((v) => squash(v.name)));
  const best = new Map<string, NameHint>();
  // On a near-tie the longer stretch wins: "grass oh" explains more of what
  // was heard than "grass" does.
  const rank = (h: { heard: string; score: number }) => h.score + 0.03 * h.heard.split(' ').length;
  const offer = (hint: NameHint) => {
    const prev = best.get(hint.name);
    if (!prev || rank(hint) > rank(prev)) best.set(hint.name, hint);
  };
  const consider = (heard: string, minScore: number) => {
    for (const { item, score } of closestNames(heard, vocab, (v) => [v.name], minScore, 2)) offer({ heard, name: item.name, kind: item.kind, score });
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (exact.has(squash(w))) continue; // heard correctly — nothing to fix
    // One word: must be name-like (not an everyday word) and a close match.
    // A SHORT word must be close in spelling, not merely in sound — "bill"
    // sounds like Bell and "knee" like Cohen, and neither is a client.
    if (!COMMON.has(w) && w.length >= 4) {
      if (squash(w).length >= 6) consider(w, 0.8);
      else {
        for (const v of vocab) {
          const target = squash(v.name);
          const spell = 1 - editDistance(squash(w), target) / Math.max(squash(w).length, target.length);
          if (spell >= 0.8) offer({ heard: w, name: v.name, kind: v.kind, score: spell });
        }
      }
    }
    // Two or three words run together ("grass oh", "oak a for"): at least
    // one of them must be an unusual word, and the whole must sound right.
    for (const n of [2, 3]) {
      const gram = words.slice(i, i + n);
      if (gram.length < n || gram.some((g) => exact.has(squash(g)))) continue;
      if (gram.every((g) => COMMON.has(g)) && n === 2) continue;
      if (gram.filter((g) => !COMMON.has(g)).length === 0 && gram.join('').length < 6) continue;
      const joined = gram.join('');
      for (const v of vocab) {
        const target = squash(v.name);
        if (Math.abs(target.length - joined.length) > 3) continue;
        const score = nameSimilarity(joined, target);
        if (score >= (n === 2 ? 0.8 : 0.84)) offer({ heard: gram.join(' '), name: v.name, kind: v.kind, score });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
}

/** The note the model gets for a spoken question, or '' when the transcript
 *  needs no help. */
export async function voiceInputNote(ctx: ToolContext, transcript: string, alternatives: string[] = []): Promise<string> {
  const vocab = await firmVocabulary(ctx);
  const hints = nameHints(transcript, vocab);
  // A second guess that contains a name on file, where the first does not, is strong evidence.
  const exactIn = (text: string) => vocab.filter((v) => tokens(text).some((t) => squash(t) === squash(v.name))).map((v) => v.name);
  const have = new Set(exactIn(transcript));
  const alts = alternatives
    .map((a) => a.trim().slice(0, 300))
    .filter((a) => a && a.toLowerCase() !== transcript.toLowerCase())
    .slice(0, 3);
  const altNames = [...new Set(alts.flatMap(exactIn))].filter((n) => !have.has(n));
  if (hints.length === 0 && alts.length === 0) return '';
  const lines = ['# This question was spoken — the transcript may contain mishearings', `Heard: "${transcript}"`];
  if (alts.length) lines.push(`The recognizer's other guesses: ${alts.map((a) => `"${a}"`).join('; ')}`);
  if (altNames.length) lines.push(`Names on file that appear in those other guesses: ${altNames.join(', ')}`);
  if (hints.length) lines.push(`Names on file that sound like part of what was heard: ${hints.map((h) => `"${h.heard}" ≈ ${h.name} (${h.kind})`).join('; ')}`);
  lines.push(
    'Recognizers do not know this firm\'s names. If one of these fits the question, take it as what he said and answer — mentioning the name you understood ("On Okafor: …") so a wrong guess is caught at once. If none fits, or two fit equally, ask which he meant. Never mention this note.',
  );
  return lines.join('\n');
}
