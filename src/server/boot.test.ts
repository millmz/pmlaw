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

describe('pairAuthUrl (an API host only accepts its own environment\'s tokens)', () => {
  it('production API + leftover staging auth → production auth, and says so', async () => {
    const { pairAuthUrl } = await import('./boot.js');
    const r = pairAuthUrl('https://api.smokeball.com', 'https://datastaging-auth.smokeball.com');
    expect(r.authUrl).toBe('https://auth.smokeball.com');
    expect(r.corrected).toMatch(/other environment/);
  });
  it('fills in a missing auth URL; staging pairs with staging', async () => {
    const { pairAuthUrl } = await import('./boot.js');
    expect(pairAuthUrl('https://api.smokeball.com', '').authUrl).toBe('https://auth.smokeball.com');
    expect(pairAuthUrl('stagingapi.smokeball.com', 'auth.smokeball.com/oauth2/token').authUrl).toBe('https://datastaging-auth.smokeball.com');
  });
  it('leaves a correct pair, an unknown auth host, and an unknown API host alone', async () => {
    const { pairAuthUrl } = await import('./boot.js');
    expect(pairAuthUrl('https://api.smokeball.com', 'auth.smokeball.com')).toEqual({ authUrl: 'auth.smokeball.com' });
    expect(pairAuthUrl('https://api.smokeball.com', 'https://auth.smokeball.co.uk')).toEqual({ authUrl: 'https://auth.smokeball.co.uk' });
    expect(pairAuthUrl('http://127.0.0.1:8787', undefined)).toEqual({ authUrl: undefined });
  });
});
