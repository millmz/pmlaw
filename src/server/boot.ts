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
