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
  /** Drop the cached token (after a 401) so the next call fetches fresh. */
  invalidate(): void;
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

export class TokenManager implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(private cfg: OAuthConfig) {}

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
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
    const res = await f(this.cfg.tokenUrl, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) {
      // Bodies here can echo request details; keep the error short and safe.
      throw new Error(`smokeball auth: token endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) throw new Error('smokeball auth: response carried no access_token');
    this.token = json.access_token;
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
