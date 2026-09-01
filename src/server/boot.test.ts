import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, withTimeout } from './boot.js';

describe('normalizeBaseUrl', () => {
  it('adds https:// when the scheme was omitted and strips trailing slashes', () => {
    expect(normalizeBaseUrl('stagingapi.smokeball.com')).toBe('https://stagingapi.smokeball.com');
    expect(normalizeBaseUrl('https://api.smokeball.com/')).toBe('https://api.smokeball.com');
    expect(normalizeBaseUrl('  https://api.smokeball.com//  ')).toBe('https://api.smokeball.com');
  });
});

describe('withTimeout', () => {
  it('resolves a fast promise and rejects a stalled one with a named error', async () => {
    await expect(withTimeout(Promise.resolve(7), 100, 'quick')).resolves.toBe(7);
    const never = new Promise(() => undefined);
    await expect(withTimeout(never, 30, 'database open')).rejects.toThrow(
      'database open did not complete within 30ms',
    );
  });

  it('propagates the underlying rejection when it loses no race', async () => {
    await expect(withTimeout(Promise.reject(new Error('real failure')), 100, 'x')).rejects.toThrow('real failure');
  });
});
