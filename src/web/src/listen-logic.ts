/**
 * The judgment calls of listening, kept pure so they can be tested:
 * what was actually said (recognizers repeat themselves), whether the
 * speaker has finished (a pause is not always the end), and whether the
 * "question" is just PAM hearing herself.
 */

export interface RecogAlt {
  transcript: string;
  confidence?: number;
}
export interface RecogResult {
  isFinal: boolean;
  length?: number;
  [index: number]: RecogAlt | undefined;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Join two pieces of speech without doubling: Android's recognizer reports
 *  each "final" as everything said so far, others report only the new part. */
function join(acc: string, next: string): string {
  const a = norm(acc);
  const n = norm(next);
  if (!n) return acc;
  if (!a) return next.trim();
  if (n.startsWith(a)) return next.trim(); // cumulative: the new one replaces
  if (a.endsWith(n)) return acc; // a repeat of the tail
  return `${acc.trim()} ${next.trim()}`;
}

/**
 * Rebuild the utterance from a recognition event. The event carries EVERY
 * result so far, so text is rebuilt each time (appending re-added earlier
 * phrases: "what's on what's on my calendar"). Also returns the other ways
 * the recognizer thinks the whole utterance may have gone — PAM uses those
 * to recover a misheard name.
 */
export function readResults(results: ArrayLike<RecogResult>): { final: string; interim: string; alternatives: string[] } {
  let final = '';
  let interim = '';
  const variants: string[] = ['', ''];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const top = r[0]?.transcript ?? '';
    if (r.isFinal) {
      final = join(final, top);
      for (let k = 0; k < variants.length; k++) variants[k] = join(variants[k]!, r[k + 1]?.transcript ?? top);
    } else interim = join(interim, top);
  }
  const seen = new Set([norm(final)]);
  const alternatives: string[] = [];
  for (const v of variants) {
    const key = norm(v);
    if (key && !seen.has(key)) {
      seen.add(key);
      alternatives.push(v.trim());
    }
  }
  return { final: final.trim(), interim: interim.trim(), alternatives };
}

/** Words a sentence does not end on — a pause after one is a breath, not the end. */
const TRAILING_OFF = new Set(
  ('a an the and or but so because if when while that which who whose to of on in at for with about from by as than into onto over under ' +
    'my our your his her their its this these those is are was were be been am do does did has have had will would can could should may might ' +
    "what's where's who's how's what where which how whether between before after during until regarding re versus vs v mr mrs ms dr judge").split(' '),
);
/** Short things that ARE complete on their own. */
const COMPLETE_ALONE = /^(yes|yeah|yep|no|nope|okay|ok|sure|confirm|confirmed|go ahead|do it|cancel|stop|never mind|thanks|thank you|that's all|repeat that|again|what|why|when|continue|go on|more|the rest)$/;

export const PAUSE = { complete: 700, completeInterim: 1250, short: 1300, trailingOff: 2300 } as const;

/**
 * How long a silence should last before what was heard is sent. Shorter
 * when the sentence sounds finished; much longer when it plainly is not
 * ("move my call with Boland to…"). `settled` = the recognizer has marked
 * everything final (it has itself heard a pause).
 */
export function pauseBeforeSending(text: string, settled: boolean): number {
  const t = norm(text);
  if (!t) return PAUSE.short;
  const words = t.split(' ');
  if (COMPLETE_ALONE.test(t)) return settled ? PAUSE.complete : PAUSE.completeInterim;
  if (TRAILING_OFF.has(words[words.length - 1]!)) return PAUSE.trailingOff;
  if (words.length <= 2) return PAUSE.short;
  return settled ? PAUSE.complete : PAUSE.completeInterim;
}

/** True when the sentence plainly is not finished (used to keep listening
 *  when the recognizer ends on its own mid-thought). */
export const soundsUnfinished = (text: string): boolean => {
  const words = norm(text).split(' ');
  return words.length > 0 && TRAILING_OFF.has(words[words.length - 1]!) && !COMPLETE_ALONE.test(norm(text));
};

/** Did the microphone just hear PAM's own voice? True when most of what was
 *  "said" is a run of words she spoke a moment ago. */
export function isEcho(heard: string, lastSpoken: string): boolean {
  const h = norm(heard).split(' ').filter(Boolean);
  const said = ` ${norm(lastSpoken)} `;
  if (h.length < 3 || said.length < 12) return false;
  if (said.includes(` ${h.join(' ')} `)) return true;
  // Count heard word-pairs that occur in what she said.
  let hits = 0;
  for (let i = 0; i + 1 < h.length; i++) if (said.includes(` ${h[i]} ${h[i + 1]} `)) hits++;
  return hits / (h.length - 1) >= 0.75;
}
