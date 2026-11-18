import { describe, expect, it } from 'vitest';
import { isEcho, pauseBeforeSending, PAUSE, readResults, soundsUnfinished } from './listen-logic.js';

const r = (isFinal: boolean, ...alts: string[]) => Object.assign({ isFinal, length: alts.length }, Object.fromEntries(alts.map((t, i) => [i, { transcript: t }])));

describe('what was actually said', () => {
  it('never repeats an earlier phrase when a later event arrives', () => {
    expect(readResults([r(true, "what's on")])).toMatchObject({ final: "what's on", interim: '' });
    expect(readResults([r(true, "what's on"), r(false, ' my calendar')])).toMatchObject({ final: "what's on", interim: 'my calendar' });
    expect(readResults([r(true, "what's on"), r(true, ' my calendar')]).final).toBe("what's on my calendar");
  });
  it('Android reports each final as everything so far — taken as a replacement, not appended', () => {
    const got = readResults([r(true, 'where'), r(true, 'where do we'), r(true, 'where do we stand on Grasso')]);
    expect(got.final).toBe('where do we stand on Grasso');
  });
  it('keeps the recognizer’s other guesses at the whole utterance, distinct from the first', () => {
    const got = readResults([r(true, 'where do we stand on', 'where do we stand on'), r(true, ' oak afore', ' Okafor', ' okay for')]);
    expect(got.final).toBe('where do we stand on oak afore');
    expect(got.alternatives).toEqual(['where do we stand on Okafor', 'where do we stand on okay for']);
    expect(readResults([r(true, 'brief me')]).alternatives).toEqual([]);
  });
});

describe('has he finished speaking?', () => {
  it('a finished sentence is sent quickly', () => {
    expect(pauseBeforeSending("what's on my calendar tomorrow", true)).toBe(PAUSE.complete);
    expect(pauseBeforeSending('where do we stand on Grasso', false)).toBe(PAUSE.completeInterim);
  });
  it('a sentence that trails off is waited for — the pause is a breath', () => {
    for (const t of ['move my call with Boland to', 'what is the status of the', 'create a task for Isabel and', "where do we stand on Hughes versus", 'put a call with judge']) {
      expect(pauseBeforeSending(t, true), t).toBe(PAUSE.trailingOff);
      expect(soundsUnfinished(t), t).toBe(true);
    }
  });
  it('one-word answers that are whole on their own go at once; other fragments get a moment', () => {
    for (const t of ['yes', 'Go ahead.', 'confirm', 'no', 'thanks']) expect(pauseBeforeSending(t, true), t).toBe(PAUSE.complete);
    expect(pauseBeforeSending('Grasso', true)).toBe(PAUSE.short);
    expect(pauseBeforeSending('the Tran', true)).toBe(PAUSE.short);
    expect(soundsUnfinished('what')).toBe(false);
  });
});

describe('hearing herself', () => {
  const said = 'Grasso is in negotiation: Kevin Boland at Apex Mutual offered a hundred ten thousand against your two fifty demand. Want the rest?';
  it('her own words coming back through the microphone are not a question', () => {
    expect(isEcho('want the rest', said)).toBe(true);
    expect(isEcho('offered a hundred ten thousand against your two fifty', said)).toBe(true);
    expect(isEcho('Apex Mutual offered a hundred and ten thousand against your two fifty demand', said)).toBe(true);
  });
  it('a real reply is, even when it reuses a word or two of hers', () => {
    expect(isEcho('yes give me the rest', said)).toBe(false);
    expect(isEcho('what did Boland say about the authorizations', said)).toBe(false);
    expect(isEcho('yes', said)).toBe(false);
  });
});
