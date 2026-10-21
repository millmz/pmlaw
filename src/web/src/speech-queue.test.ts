import { describe, expect, it } from 'vitest';
import { SpeechQueue, mergeShort, segmentSentences } from './speech-queue.js';

describe('segmentSentences (streamed text → spoken sentences)', () => {
  it('splits on terminal punctuation followed by space, keeps the remainder', () => {
    const r = segmentSentences('Three filings are due this week. The earliest is Thursday. Want me to');
    expect(r.sentences).toEqual(['Three filings are due this week.', 'The earliest is Thursday.']);
    expect(r.rest).toBe(' Want me to');
  });
  it('does not split on decimals, abbreviations, or initials', () => {
    expect(segmentSentences('The offer is $1.5 million from Mr. Boland. Next up').sentences).toEqual([
      'The offer is $1.5 million from Mr. Boland.',
    ]);
    expect(segmentSentences('Defense counsel is R. Calloway in Nanuet. Then').sentences).toEqual([
      'Defense counsel is R. Calloway in Nanuet.',
    ]);
  });
  it('treats newlines as boundaries and handles questions/exclamations', () => {
    const r = segmentSentences('Done — verified in Smokeball.\nAnything else? Go Canes! ');
    expect(r.sentences).toEqual(['Done — verified in Smokeball.', 'Anything else?', 'Go Canes!']);
  });
  it('holds an incomplete trailing sentence until more text arrives', () => {
    const r = segmentSentences('Boland called at 2');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('Boland called at 2');
  });
});

describe('mergeShort', () => {
  it('folds tiny fragments into the following sentence', () => {
    expect(mergeShort(['Yes.', 'The deposition is Tuesday at ten.', 'Ok.'])).toEqual([
      'Yes. The deposition is Tuesday at ten.',
      'Ok.',
    ]);
  });
});

describe('SpeechQueue', () => {
  const makeSpeaker = () => {
    const spoken: string[] = [];
    let release: (() => void) | null = null;
    const speakImpl = async (text: string, onEnd: () => void) => {
      spoken.push(text);
      release = onEnd;
      return 'elevenlabs' as const;
    };
    return { spoken, speakImpl, finish: () => release?.(), prefetched: [] as string[] };
  };

  it('speaks the first full sentence while the rest is still streaming, in order, then goes idle', async () => {
    const s = makeSpeaker();
    let idle = 0;
    let ttfw = -1;
    const q = new SpeechQueue(
      { onIdle: () => idle++, onFirstWord: (ms) => (ttfw = ms) },
      s.speakImpl,
      async (t) => {
        s.prefetched.push(t);
      },
      () => undefined,
    );
    q.push('Three filings are due ');
    q.push('this week. The earliest is ');
    await Promise.resolve();
    expect(s.spoken).toEqual(['Three filings are due this week.']); // started before the reply finished
    q.push('Thursday. Want me to pull them up?');
    q.close();
    expect(s.prefetched).toContain('The earliest is Thursday.'); // next clip warmed while #1 plays
    s.finish();
    await Promise.resolve();
    s.finish();
    await Promise.resolve();
    s.finish();
    await Promise.resolve();
    expect(s.spoken).toEqual([
      'Three filings are due this week.',
      'The earliest is Thursday.',
      'Want me to pull them up?',
    ]);
    expect(idle).toBe(1);
    expect(ttfw).toBeGreaterThanOrEqual(0);
  });

  it('cancel empties the queue and nothing more is spoken (barge-in)', async () => {
    const s = makeSpeaker();
    let stopped = 0;
    const q = new SpeechQueue({}, s.speakImpl, async () => undefined, () => stopped++);
    q.push('First sentence here. Second sentence here. Third one here.');
    await Promise.resolve();
    expect(s.spoken).toHaveLength(1);
    q.cancel();
    s.finish();
    await Promise.resolve();
    expect(s.spoken).toHaveLength(1);
    expect(q.isActive).toBe(false);
    expect(stopped).toBe(1);
  });

  it('close() with no sentence boundary still speaks the tail', async () => {
    const s = makeSpeaker();
    let idle = 0;
    const q = new SpeechQueue({ onIdle: () => idle++ }, s.speakImpl, async () => undefined, () => undefined);
    q.push('Nothing due today');
    q.close();
    await Promise.resolve();
    expect(s.spoken).toEqual(['Nothing due today']);
    s.finish();
    expect(idle).toBe(1);
  });
});
