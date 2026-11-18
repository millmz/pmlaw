import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAUSE } from './listen-logic.js';

/** The microphone session, driven by a scripted recognizer. */

interface FakeRec {
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  started: boolean;
  stopped: boolean;
}
let recs: FakeRec[] = [];
const res = (isFinal: boolean, ...alts: string[]) => Object.assign({ isFinal, length: alts.length }, Object.fromEntries(alts.map((t, i) => [i, { transcript: t }])));
const say = (rec: FakeRec, ...results: unknown[]) => rec.onresult?.({ results });

const setup = async (ua = 'Mozilla/5.0 (Macintosh) Chrome/142') => {
  recs = [];
  class Rec {
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    lang = '';
    onresult = null;
    onerror = null;
    onend = null;
    onstart = null;
    onaudiostart = null;
    started = false;
    stopped = false;
    constructor() {
      recs.push(this as unknown as FakeRec);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.stopped = true;
    }
  }
  vi.stubGlobal('window', { SpeechRecognition: Rec });
  vi.stubGlobal('navigator', { userAgent: ua });
  const { startListening } = await import('./voice.js');
  const log: string[] = [];
  const session = startListening({
    onReady: () => log.push('ready'),
    onPartial: (t) => log.push(`partial:${t}`),
    onCommit: (t, alts) => log.push(`commit:${t}${alts.length ? ` | ${alts.join(' / ')}` : ''}`),
    onGiveUp: () => log.push('gave-up'),
    onError: (r) => log.push(`error:${r}`),
  })!;
  return { session, log };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the microphone session', () => {
  it('says "go" only when the mic is really open, and asks the recognizer for its other guesses', async () => {
    const { log } = await setup();
    expect(recs[0]!.started).toBe(true);
    expect(recs[0]!.maxAlternatives).toBe(3);
    expect(log).toEqual([]); // tapped, but not open yet — a word spoken now would be lost
    recs[0]!.onaudiostart!();
    expect(log).toEqual(['ready']);
  });

  it('a finished sentence is sent after a short pause; one that trails off is waited for', async () => {
    const a = await setup();
    recs[0]!.onaudiostart!();
    say(recs[0]!, res(true, "what's on my calendar tomorrow"));
    vi.advanceTimersByTime(PAUSE.complete - 50);
    expect(a.log.some((l) => l.startsWith('commit'))).toBe(false);
    vi.advanceTimersByTime(60);
    expect(a.log.at(-1)).toBe("commit:what's on my calendar tomorrow");

    const b = await setup();
    recs[0]!.onaudiostart!();
    say(recs[0]!, res(true, 'move my call with Boland to'));
    vi.advanceTimersByTime(PAUSE.complete + 400); // he is thinking of the date
    expect(b.log.some((l) => l.startsWith('commit'))).toBe(false);
    say(recs[0]!, res(true, 'move my call with Boland to'), res(true, ' next Tuesday'));
    vi.advanceTimersByTime(PAUSE.complete + 10);
    expect(b.log.at(-1)).toBe('commit:move my call with Boland to next Tuesday');
  });

  it('a recognizer that stops by itself mid-thought is reopened and the pieces joined (phones)', async () => {
    const { log } = await setup('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari');
    expect(recs[0]!.continuous).toBe(false); // one utterance per session on phones
    recs[0]!.onaudiostart!();
    say(recs[0]!, res(true, 'where do we stand on the'));
    recs[0]!.onend!(); // the phone decided he was done; the words say otherwise
    expect(recs).toHaveLength(2);
    expect(log.some((l) => l.startsWith('commit'))).toBe(false);
    say(recs[1]!, res(true, 'oak afore matter', 'Okafor matter'));
    recs[1]!.onend!();
    expect(log.at(-1)).toBe('commit:where do we stand on the oak afore matter | where do we stand on the Okafor matter');
  });

  it('tapping again sends what has been said right away; with nothing said it reports so', async () => {
    const a = await setup();
    recs[0]!.onaudiostart!();
    expect(a.session.finish()).toBe(false);
    say(recs[0]!, res(false, 'brief me on'));
    expect(a.session.finish()).toBe(true);
    expect(a.log.at(-1)).toBe('commit:brief me on');
    expect(recs[0]!.stopped).toBe(true);
  });

  it('a late error never throws away words already heard', async () => {
    const { log } = await setup();
    recs[0]!.onaudiostart!();
    say(recs[0]!, res(false, 'what is overdue'));
    recs[0]!.onerror!({ error: 'network' });
    expect(log.at(-1)).toBe('commit:what is overdue');
  });

  it('silence: the mic is reopened while time remains, then closes quietly; a blocked mic is explained', async () => {
    const a = await setup();
    recs[0]!.onaudiostart!();
    recs[0]!.onerror!({ error: 'no-speech' });
    recs[0]!.onend!(); // Chrome closes after a few silent seconds
    expect(recs).toHaveLength(2); // …so listen on
    vi.advanceTimersByTime(9100);
    expect(a.log.at(-1)).toBe('gave-up');

    const b = await setup();
    recs[0]!.onerror!({ error: 'not-allowed' });
    expect(b.log.at(-1)).toMatch(/^error:Microphone permission is blocked/);
  });
});
