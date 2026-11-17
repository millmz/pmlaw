/** Small boot helpers, kept pure for testing. */

/** Add https:// when the scheme was omitted; strip trailing slashes. */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

/** Reject if `p` hasn't settled within `ms` — the loser keeps running, but
 *  boot moves on instead of hanging forever with no open port. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not complete within ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The documented US host pairs: an API host only accepts tokens minted by
 *  its own environment's auth host. */
const AUTH_FOR_API: Record<string, string> = {
  'api.smokeball.com': 'auth.smokeball.com',
  'stagingapi.smokeball.com': 'datastaging-auth.smokeball.com',
};

/**
 * Staging credentials at the production auth host (or the reverse) can never
 * work — the failure is a bare `invalid_client` that looks like a bad
 * secret. When the API host is a known one and the auth URL is missing or
 * is the OTHER environment's, use the matching auth host and say so. An
 * auth URL we do not recognize is left alone.
 */
export function pairAuthUrl(baseUrl: string, authUrl: string | undefined): { authUrl: string | undefined; corrected?: string } {
  const host = (u: string) => {
    try {
      return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).host.toLowerCase();
    } catch {
      return '';
    }
  };
  const want = AUTH_FOR_API[host(baseUrl)];
  if (!want) return { authUrl };
  const have = authUrl?.trim() ? host(authUrl) : '';
  if (have === want) return { authUrl };
  const known = Object.values(AUTH_FOR_API);
  if (have === '' || known.includes(have)) {
    return {
      authUrl: `https://${want}`,
      corrected: have === '' ? `SMOKEBALL_AUTH_URL was empty — using ${want} (the auth host for ${host(baseUrl)})` : `SMOKEBALL_AUTH_URL was ${have}, which belongs to the other environment — using ${want} (the auth host for ${host(baseUrl)})`,
    };
  }
  return { authUrl };
}
