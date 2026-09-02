import { describe, expect, it } from 'vitest';
import { TokenManager, normalizeTokenUrl } from './auth.js';

type FetchArgs = { url: string; init: RequestInit };

function fakeTokenServer(responses: Array<{ status: number; body: unknown }>) {
  const calls: FetchArgs[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, impl };
}

describe('normalizeTokenUrl', () => {
  it('accepts a bare domain, a domain with scheme, and a full token URL', () => {
    expect(normalizeTokenUrl('datastaging-auth.smokeball.com')).toBe(
      'https://datastaging-auth.smokeball.com/oauth2/token',
    );
    expect(normalizeTokenUrl('https://auth.smokeball.com/')).toBe('https://auth.smokeball.com/oauth2/token');
    expect(normalizeTokenUrl('https://auth.smokeball.com/oauth2/token')).toBe(
      'https://auth.smokeball.com/oauth2/token',
    );
  });
});

describe('TokenManager', () => {
  it('client_credentials: Basic auth header, form body, token cached until expiry', async () => {
    const srv = fakeTokenServer([{ status: 200, body: { access_token: 'tok-1', expires_in: 3600 } }]);
    const tm = new TokenManager({
      tokenUrl: 'https://auth.example/oauth2/token',
      clientId: 'cid',
      clientSecret: 'sec',
      fetchImpl: srv.impl,
    });
    expect(tm.grant).toBe('client_credentials');
    expect(await tm.getToken()).toBe('tok-1');
    expect(await tm.getToken()).toBe('tok-1'); // cached — no second call
    expect(srv.calls).toHaveLength(1);
    const { init } = srv.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    expect(String(init.body)).toContain('grant_type=client_credentials');
    expect(String(init.body)).toContain('client_id=cid');
  });

  it('refresh_token grant carries the refresh token in the body', async () => {
    const srv = fakeTokenServer([{ status: 200, body: { access_token: 'tok-r', expires_in: 3600 } }]);
    const tm = new TokenManager({
      tokenUrl: 'https://auth.example/oauth2/token',
      clientId: 'cid',
      refreshToken: 'refresh-abc',
      fetchImpl: srv.impl,
    });
    expect(tm.grant).toBe('refresh_token');
    expect(await tm.getToken()).toBe('tok-r');
    expect(String(srv.calls[0]!.init.body)).toContain('grant_type=refresh_token');
    expect(String(srv.calls[0]!.init.body)).toContain('refresh_token=refresh-abc');
  });

  it('invalidate() forces a fresh fetch (the 401-retry path)', async () => {
    const srv = fakeTokenServer([
      { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
      { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
    ]);
    const tm = new TokenManager({ tokenUrl: 'https://a/oauth2/token', clientId: 'c', fetchImpl: srv.impl });
    expect(await tm.getToken()).toBe('tok-1');
    tm.invalidate(true); // a 401: the token itself was rejected
    expect(await tm.getToken()).toBe('tok-2');
    expect(srv.calls).toHaveLength(2);
  });

  it('an expiring token is refreshed before the 60s safety margin', async () => {
    const srv = fakeTokenServer([
      { status: 200, body: { access_token: 'short', expires_in: 30 } }, // < margin
      { status: 200, body: { access_token: 'long', expires_in: 3600 } },
    ]);
    const tm = new TokenManager({ tokenUrl: 'https://a/oauth2/token', clientId: 'c', fetchImpl: srv.impl });
    expect(await tm.getToken()).toBe('short');
    expect(await tm.getToken()).toBe('long'); // 30s lifetime is inside the margin → refetch
  });

  it('concurrent callers share one in-flight token request', async () => {
    const srv = fakeTokenServer([{ status: 200, body: { access_token: 'tok', expires_in: 3600 } }]);
    const tm = new TokenManager({ tokenUrl: 'https://a/oauth2/token', clientId: 'c', fetchImpl: srv.impl });
    const [a, b, c] = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);
    expect([a, b, c]).toEqual(['tok', 'tok', 'tok']);
    expect(srv.calls).toHaveLength(1);
  });

  it('auth failures name the Cognito reason + a hint, and cool down instead of hammering', async () => {
    const srv = fakeTokenServer([{ status: 400, body: { error: 'invalid_client', error_description: 'secret-ish' } }]);
    const tm = new TokenManager({ tokenUrl: 'https://a/oauth2/token', clientId: 'c', fetchImpl: srv.impl });
    await expect(tm.getToken()).rejects.toThrow(/returned 400 \(invalid_client\) — the client id\/secret/);
    await expect(tm.getToken()).rejects.toThrow(/invalid_client/);
    await expect(tm.getToken()).rejects.not.toThrow(/secret-ish/);
    expect(srv.calls).toHaveLength(1); // second/third calls served from the cooldown, not the network
  });

  it('a fresh token is not invalidated by a scope-less 403 (no refresh storm)', async () => {
    const srv = fakeTokenServer([
      { status: 200, body: { access_token: 'young', expires_in: 3600 } },
      { status: 200, body: { access_token: 'second', expires_in: 3600 } },
    ]);
    const tm = new TokenManager({ tokenUrl: 'https://a/oauth2/token', clientId: 'c', fetchImpl: srv.impl });
    expect(await tm.getToken()).toBe('young');
    tm.invalidate(); // ignored: token is seconds old
    expect(await tm.getToken()).toBe('young');
    expect(srv.calls).toHaveLength(1);
  });
});
