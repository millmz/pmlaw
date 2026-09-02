/**
 * Smokeball OAuth (AWS Cognito) token management — docs/02 "Auth":
 * access tokens live 60 minutes, refresh tokens 30 days, and every API call
 * needs `x-api-key` + `Authorization: Bearer`. This manager keeps a cached
 * token, refreshes it ~60s before expiry, single-flights concurrent
 * refreshes, and supports both grants a private app may hold:
 *
 *   client_credentials  — machine-to-machine (preferred; no user consent)
 *   refresh_token       — per-user grant obtained once via browser consent
 *
 * The mock path never touches this: a static token still works via
 * SmokeballConfig.accessToken.
 */

export interface TokenProvider {
  getToken(): Promise<string>;
  /** Drop the cached token so the next call fetches fresh. `force` (a 401:
   *  the token itself was rejected) always drops it; a soft invalidate (a
   *  403: maybe a scope was just granted) is ignored for a very young token. */
  invalidate(force?: boolean): void;
}

export interface OAuthConfig {
  /** Full token endpoint, e.g. https://datastaging-auth.smokeball.com/oauth2/token */
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  /** Present → refresh_token grant; absent → client_credentials. */
  refreshToken?: string;
  scope?: string;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

/** What each Cognito reason code usually means for a Smokeball app. */
const AUTH_HINTS: Record<string, string> = {
  invalid_client: ' — the client id/secret pair is wrong or was regenerated in the Developer Console; re-copy both.',
  unauthorized_client: ' — this app is not allowed the client-credentials grant; check "Client Grant" on the app in the console.',
  invalid_scope: ' — a requested scope is not enabled for this app; unset SMOKEBALL_SCOPE or match it to the console.',
  invalid_grant: ' — the grant/refresh token was rejected; for client credentials, re-check the secret.',
  invalid_request: ' — the token request itself was malformed; check SMOKEBALL_AUTH_URL points at the auth domain.',
};

/** Don't re-invalidate a token younger than this: a 403 from an endpoint we
 *  simply lack a scope for must not turn into a token-refresh storm. */
const MIN_TOKEN_AGE_FOR_INVALIDATE_MS = 30_000;
/** After the token endpoint fails, wait this long before asking it again. */
const FAILURE_COOLDOWN_MS = 15_000;

export class TokenManager implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private issuedAt = 0;
  private inflight: Promise<string> | null = null;
  private lastFailure: { at: number; error: Error } | null = null;

  constructor(private cfg: OAuthConfig) {}

  invalidate(force = false): void {
    if (!force && this.token && Date.now() - this.issuedAt < MIN_TOKEN_AGE_FOR_INVALIDATE_MS) return;
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (this.lastFailure && Date.now() - this.lastFailure.at < FAILURE_COOLDOWN_MS) throw this.lastFailure.error;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Which grant this manager will use — surfaced in diagnostics. */
  get grant(): 'refresh_token' | 'client_credentials' {
    return this.cfg.refreshToken ? 'refresh_token' : 'client_credentials';
  }

  private async fetchToken(): Promise<string> {
    const f = this.cfg.fetchImpl ?? fetch;
    const body = new URLSearchParams();
    if (this.cfg.refreshToken) {
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', this.cfg.refreshToken);
    } else {
      body.set('grant_type', 'client_credentials');
      if (this.cfg.scope) body.set('scope', this.cfg.scope);
    }
    body.set('client_id', this.cfg.clientId);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (this.cfg.clientSecret) {
      headers['authorization'] =
        'Basic ' + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    }
    let res: Response;
    try {
      res = await f(this.cfg.tokenUrl, { method: 'POST', headers, body: body.toString() });
    } catch (e) {
      const err = new Error(`smokeball auth: could not reach the token endpoint (${String(e instanceof Error ? e.message : e).slice(0, 80)})`);
      this.lastFailure = { at: Date.now(), error: err };
      throw err;
    }
    if (!res.ok) {
      // Surface Cognito's reason code (invalid_client / invalid_scope /
      // unauthorized_client / invalid_grant) — it names the fix and carries
      // no secret. Never echo the rest of the body.
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      const reason = typeof json.error === 'string' ? ` (${json.error})` : '';
      const err = new Error(`smokeball auth: token endpoint returned ${res.status}${reason}${AUTH_HINTS[json.error ?? ''] ?? ''}`);
      this.lastFailure = { at: Date.now(), error: err };
      throw err;
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      const err = new Error('smokeball auth: response carried no access_token');
      this.lastFailure = { at: Date.now(), error: err };
      throw err;
    }
    this.lastFailure = null;
    this.token = json.access_token;
    this.issuedAt = Date.now();
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

/** Accepts a bare Cognito domain or a full token URL; returns the token URL. */
export function normalizeTokenUrl(authUrlOrDomain: string): string {
  let u = authUrlOrDomain.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return /\/oauth2\/token$/.test(u) ? u : `${u}/oauth2/token`;
}
