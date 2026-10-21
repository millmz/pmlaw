import { sanitizeForSpeech, speak, stopSpeaking, type TtsPath } from './voice.js';

/**
 * Streamed speech: PAM starts talking on her first complete sentence instead
 * of after the whole reply. Text deltas feed a segmenter; each sentence joins
 * an ordered queue; the queue plays one at a time and PREFETCHES the next
 * clip while the current one plays, so sentence boundaries don't gap.
 *
 * Barge-in / stop empties the queue and cancels audio. The first-word time is
 * recorded for diagnostics ("time to first word").
 */

// ------------------------------------------------------------ segmenter

/** Pure sentence splitter for streamed text. Returns completed sentences and
 *  the unfinished remainder. Avoids splitting on decimals ("$1.5"), common
 *  abbreviations, and initials ("R. Calloway"). */
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Hon|St|No|Jr|Sr|vs|v|Esq|Inc|Co|Ave|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;

export function segmentSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    // Candidate end: terminal punctuation followed by whitespace (or a newline).
    const m = rest.match(/[.!?…]["”’)]?(?=\s)|\n+/);
    if (!m || m.index === undefined) break;
    const end = m.index + m[0].length;
    const head = rest.slice(0, end);
    const trimmed = head.trim();
    const before = rest.slice(0, m.index + 1);
    const isDecimal = /\d\.$/.test(before) && /^\s*\d/.test(rest.slice(m.index + 1));
    const isInitial = /\b[A-Z]\.$/.test(before);
    if ((ABBREV.test(before) || isDecimal || isInitial) && !m[0].includes('\n')) {
      // Not a real boundary — look past it.
      const next = rest.slice(end).match(/[.!?…]["”’)]?(?=\s)|\n+/);
      if (!next || next.index === undefined) break;
      const end2 = end + next.index + next[0].length;
      const t2 = rest.slice(0, end2).trim();
      if (t2) sentences.push(t2);
      rest = rest.slice(end2);
      continue;
    }
    if (trimmed) sentences.push(trimmed);
    rest = rest.slice(end);
  }
  return { sentences, rest };
}

/** Very short fragments sound choppy — merge them into the next sentence. */
export function mergeShort(sentences: string[], minChars = 24): string[] {
  const out: string[] = [];
  let carry = '';
  for (const s of sentences) {
    const joined = carry ? `${carry} ${s}` : s;
    if (joined.length < minChars) {
      carry = joined;
      continue;
    }
    out.push(joined);
    carry = '';
  }
  if (carry) out.push(carry);
  return out;
}

// ------------------------------------------------------------------ queue

export interface SpeechQueueHooks {
  onFirstWord?: (msAfterStart: number) => void;
  onIdle?: () => void; // queue drained and input closed
}

/**
 * Ordered speech queue. `push(text)` accepts streamed deltas; `close()` says
 * no more text is coming (flushes the remainder); `cancel()` stops now.
 * Playback uses voice.speak per clip; prefetch is achieved by letting the
 * TTS fetch of clip N+1 start while clip N plays (speak() fetches first,
 * then plays — so we kick the next fetch via a warm call when a clip begins).
 */
export class SpeechQueue {
  private buffer = '';
  private pending: string[] = [];
  private playing = false;
  private closed = false;
  private cancelled = false;
  private startedAt = performance.now();
  private firstWordReported = false;
  private prefetched = new Map<string, Promise<void>>();

  constructor(
    private hooks: SpeechQueueHooks = {},
    private speakImpl: (text: string, onEnd: () => void) => Promise<TtsPath> = speak,
    private prefetchImpl: (text: string) => Promise<void> = prefetchTts,
    private stopImpl: () => void = stopSpeaking,
  ) {}

  push(delta: string): void {
    if (this.cancelled) return;
    this.buffer += delta;
    const { sentences, rest } = segmentSentences(this.buffer);
    this.buffer = rest;
    if (sentences.length) {
      this.pending.push(...mergeShort(sentences));
      this.warmNext();
      this.kick();
    }
  }

  close(): void {
    if (this.cancelled) return;
    this.closed = true;
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.pending.push(tail);
    if (!this.playing && this.pending.length === 0) this.hooks.onIdle?.();
    else {
      this.warmNext();
      this.kick();
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.pending = [];
    this.buffer = '';
    this.playing = false;
    this.stopImpl();
  }

  get isActive(): boolean {
    return this.playing || this.pending.length > 0;
  }

  /** Warm the clip that will play next so sentence gaps are ~0. */
  private warmNext(): void {
    const next = this.pending[0];
    if (next && !this.prefetched.has(next)) this.prefetched.set(next, this.prefetchImpl(next).catch(() => undefined));
  }

  private kick(): void {
    if (this.playing || this.cancelled) return;
    const next = this.pending.shift();
    if (!next) {
      if (this.closed) this.hooks.onIdle?.();
      return;
    }
    this.playing = true;
    this.warmNext();
    void this.speakImpl(next, () => {
      this.playing = false;
      if (!this.cancelled) this.kick();
    }).then(() => {
      if (!this.firstWordReported) {
        this.firstWordReported = true;
        this.hooks.onFirstWord?.(performance.now() - this.startedAt);
      }
    });
  }
}

/** Server-side TTS has an in-memory clip cache keyed on text; asking for a
 *  clip ahead of time makes the real `speak` a cache hit. */
export async function prefetchTts(text: string): Promise<void> {
  const clean = sanitizeForSpeech(text);
  if (!clean) return;
  await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean, prefetch: true }),
  });
}
