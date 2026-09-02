import type {
  CalendarEvent,
  FileRecord,
  Folder,
  Matter,
  MatterType,
  Memo,
  Staff,
  Task,
} from '../core/types.js';

/**
 * Thin typed client for the Smokeball API surface PAM uses. Pointed at the
 * mock in dev/tests and at api.smokeball.com (or stagingapi) in production —
 * same code path either way (docs/06 Phase A).
 *
 * Built-in queue keeps us under Smokeball's 5 req/s / burst 5 limit and
 * retries once on 429 (docs/02 "Rate limits").
 */

import type { TokenProvider } from './auth.js';

export interface SmokeballConfig {
  baseUrl: string;
  apiKey: string;
  /** Static bearer (the mock, or a hand-issued token). */
  accessToken?: string;
  /** Live OAuth (production): overrides accessToken; 401s refresh and retry once. */
  tokenProvider?: TokenProvider;
  /** Requests per second budget; Smokeball grants 5. */
  rps?: number;
}

interface Paged<T> {
  value: T[];
  total?: number;
}

/** Real Smokeball rejects fractional seconds on date-time filters
 *  (staging 400: "not valid for UpdatedSince") — send second precision. */
const isoNoMillis = (iso: string): string => iso.replace(/\.\d+(?=(Z|[+-]\d{2}:?\d{2})?$)/, '');

export class SmokeballClient {
  private queue: Promise<void> = Promise.resolve();
  private stamps: number[] = [];
  private readonly rps: number;

  constructor(private cfg: SmokeballConfig) {
    this.rps = cfg.rps ?? 5;
  }

  /** Serialize requests through a token-bucket so bursts never exceed budget. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 1000);
      if (this.stamps.length >= this.rps) {
        const wait = 1000 - (now - this.stamps[0]!) + 5;
        await new Promise((r) => setTimeout(r, wait));
      }
      this.stamps.push(Date.now());
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(fn);
  }

  private async bearer(): Promise<string> {
    if (this.cfg.tokenProvider) return this.cfg.tokenProvider.getToken();
    return this.cfg.accessToken ?? '';
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.bearer();
    const res = await this.schedule(() =>
      fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.cfg.apiKey,
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    if (res.status === 429 && !retried) {
      await new Promise((r) => setTimeout(r, 1100));
      return this.request(method, path, body, true);
    }
    // 401: token aged out mid-flight. 403: scopes may have just been granted
    // in the dev console — scopes live inside the token, so only a fresh one
    // can pick them up. Either way: refresh once and retry.
    if ((res.status === 401 || res.status === 403) && this.cfg.tokenProvider && !retried) {
      this.cfg.tokenProvider.invalidate();
      return this.request(method, path, body, true);
    }
    if (!res.ok) {
      throw new Error(`smokeball ${method} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** Drain a paged endpoint completely. */
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const pageRes = await this.get<Paged<T>>(`${path}${sep}limit=${limit}&offset=${offset}`);
      out.push(...pageRes.value);
      if (pageRes.value.length < limit) return out;
      offset += limit;
    }
  }

  // ------------------------------------------------------------------ reads
  listStaff(): Promise<Staff[]> {
    return this.getAll<Staff>('/staff');
  }
  listMatterTypes(): Promise<MatterType[]> {
    return this.getAll<MatterType>('/mattertypes');
  }
  listMatters(params: { updatedSince?: string; status?: string } = {}): Promise<Matter[]> {
    const q = new URLSearchParams();
    if (params.updatedSince) q.set('LastUpdated', isoNoMillis(params.updatedSince));
    if (params.status) q.set('Status', params.status);
    const qs = q.toString();
    return this.getAll<Matter>(`/matters${qs ? `?${qs}` : ''}`);
  }
  listTasks(params: { updatedSince?: string; matterId?: string } = {}): Promise<Task[]> {
    const q = new URLSearchParams();
    if (params.updatedSince) q.set('LastUpdated', isoNoMillis(params.updatedSince));
    if (params.matterId) q.set('MatterId', params.matterId);
    const qs = q.toString();
    return this.getAll<Task>(`/tasks${qs ? `?${qs}` : ''}`);
  }
  listEvents(params: { updatedSince?: string; from?: string; to?: string } = {}): Promise<CalendarEvent[]> {
    const q = new URLSearchParams();
    // /events has no LastUpdated; its UpdatedSince accepts ISO *without* zone
    // ("YYYY-MM-DDThh:mm:ss"), per the spec example.
    if (params.updatedSince) q.set('UpdatedSince', isoNoMillis(params.updatedSince).replace(/Z$/, ''));
    if (params.from) q.set('From', params.from);
    if (params.to) q.set('To', params.to);
    const qs = q.toString();
    return this.getAll<CalendarEvent>(`/events${qs ? `?${qs}` : ''}`);
  }
  listFolders(matterId: string): Promise<Folder[]> {
    return this.getAll<Folder>(`/matters/${matterId}/folders`);
  }
  listFiles(matterId: string): Promise<FileRecord[]> {
    return this.getAll<FileRecord>(`/matters/${matterId}/files`);
  }
  listMemos(matterId: string): Promise<Memo[]> {
    return this.getAll<Memo>(`/matters/${matterId}/memos`);
  }
  async downloadFile(matterId: string, fileId: string): Promise<string> {
    const { downloadUrl } = await this.get<{ downloadUrl: string }>(
      `/matters/${matterId}/files/${fileId}/download`,
    );
    // Presigned URLs are absolute in production, path-relative in the mock.
    const url = downloadUrl.startsWith('http') ? downloadUrl : `${this.cfg.baseUrl}${downloadUrl}`;
    const res = await this.schedule(() => fetch(url));
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    return res.text();
  }
  searchFiles(query: string, matterIds?: string[]): Promise<{ value: FileRecord[] }> {
    return this.request('POST', '/search/files', { query, ...(matterIds ? { matterIds } : {}) });
  }

  // --------------------------------------------------------------- webhooks
  createWebhook(eventTypes: string[], callbackUrl: string): Promise<{ id: string; key: string }> {
    return this.request('POST', '/webhooks', { eventTypes, callbackUrl });
  }
  listWebhooks(): Promise<{ value: { id: string }[] }> {
    return this.get('/webhooks');
  }
  deleteWebhook(id: string): Promise<unknown> {
    return this.request('DELETE', `/webhooks/${id}`);
  }

  // ----------------------------------------------------------- async writes
  createTask(task: Partial<Task>, requestId?: string): Promise<{ requestId: string }> {
    return this.write('POST', '/tasks', task, requestId);
  }
  updateTask(id: string, patch: Partial<Task>, requestId?: string): Promise<{ requestId: string }> {
    return this.write('PUT', `/tasks/${id}`, patch, requestId);
  }
  createEvent(event: Partial<CalendarEvent>, requestId?: string): Promise<{ requestId: string }> {
    return this.write('POST', '/events', event, requestId);
  }

  private async write(
    method: string,
    path: string,
    body: unknown,
    requestId?: string,
    retried = false,
  ): Promise<{ requestId: string }> {
    const token = await this.bearer();
    const res = await this.schedule(() =>
      fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.cfg.apiKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(requestId ? { requestid: requestId } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    if (res.status === 401 && this.cfg.tokenProvider && !retried) {
      this.cfg.tokenProvider.invalidate();
      return this.write(method, path, body, requestId, true);
    }
    if (!res.ok && res.status !== 202) {
      throw new Error(`smokeball ${method} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { requestId: string };
  }
}
