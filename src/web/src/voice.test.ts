import { describe, expect, it, vi } from 'vitest';
import {
  routeThroughAnalyserIfRunning,
  sanitizeForSpeech,
  shouldRouteThroughAnalyser,
  type AudioContextLike,
} from './voice.js';

describe('sanitizeForSpeech', () => {
  it('strips markdown, emoji, and symbols a voice would read aloud', () => {
    expect(sanitizeForSpeech('**Three filings** are due — earliest `Thursday` ⚖️ [link](http://x)')).toBe(
      'Three filings are due , earliest Thursday link',
    );
  });
  it('returns empty for decoration-only text', () => {
    expect(sanitizeForSpeech('*** ### 🎉')).toBe('');
  });
});

describe('the iOS suspended-AudioContext trap', () => {
  const makeCtx = (state: string): AudioContextLike & { srcCalls: number } => {
    const ctx = {
      state,
      destination: {},
      srcCalls: 0,
      createMediaElementSource(_el: unknown) {
        ctx.srcCalls++;
        return { connect: vi.fn() };
      },
      createAnalyser: () =>
        ({ fftSize: 0, connect: vi.fn() }) as unknown as AnalyserNode,
    };
    return ctx;
  };

  it('a suspended context is NEVER wired into the graph — audio must play straight out', () => {
    const ctx = makeCtx('suspended'); // iOS: created outside a user gesture
    const analyser = routeThroughAnalyserIfRunning(ctx, {});
    expect(analyser).toBeNull(); // no analyser…
    expect(ctx.srcCalls).toBe(0); // …and crucially, the element was never captured
    expect(shouldRouteThroughAnalyser('suspended')).toBe(false);
  });

  it('a running context gets the full analyser graph', () => {
    const ctx = makeCtx('running');
    const analyser = routeThroughAnalyserIfRunning(ctx, {});
    expect(analyser).not.toBeNull();
    expect(ctx.srcCalls).toBe(1);
  });

  it('a null context (no WebAudio at all) still plays straight out', () => {
    expect(routeThroughAnalyserIfRunning(null, {})).toBeNull();
  });

  it('graph wiring failure falls back to straight playback, not silence', () => {
    const ctx = makeCtx('running');
    ctx.createMediaElementSource = () => {
      throw new Error('already connected');
    };
    expect(routeThroughAnalyserIfRunning(ctx, {})).toBeNull();
  });
});
