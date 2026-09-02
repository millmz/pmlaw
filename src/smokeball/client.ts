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
import {
  adaptContactName,
  adaptEvent,
  adaptFile,
  adaptFolders,
  adaptMatter,
  adaptMatterType,
  adaptMemo,
  adaptStaff,
  adaptTask,
  staffUserId,
  toEventDto,
  toTaskDto,
} from './adapt.js';

type Raw = Record<string, unknown>;

/** What a 202 hands back: the mock's requestId and/or the real API's Link (id + href). */
export interface WriteReceipt {
  requestId?: string;
  id?: string;
  href?: string;
}

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
  /** Real memos reference USER ids; staff rows carry the mapping. Filled by listStaff. */
  private userToStaff = new Map<string, string>();
  /** Client names resolve via /contacts — cached for the process lifetime;
   *  null = unresolvable (no scope / not found), so we don't retry forever. */
  private contactNames = new Map<string, { firstName: string; lastName: string } | null>();
  private contactsWarned = false;

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
  // Every read goes through adapt.ts: real wire shapes in, core types out.
  private present<T>(xs: (T | null)[]): T[] {
    return xs.filter((x): x is T => x !== null);
  }

  async listStaff(): Promise<Staff[]> {
    const raws = await this.getAll<Raw>('/staff');
    for (const r of raws) {
      const uid = staffUserId(r);
      if (uid && typeof r['id'] === 'string') this.userToStaff.set(uid, r['id']);
    }
    return this.present(raws.map(adaptStaff));
  }
  async listMatterTypes(): Promise<MatterType[]> {
    return this.present((await this.getAll<Raw>('/mattertypes')).map(adaptMatterType));
  }
  async listMatters(params: { updatedSince?: string; status?: string } = {}): Promise<Matter[]> {
    const q = new URLSearchParams();
    if (params.updatedSince) q.set('LastUpdated', isoNoMillis(params.updatedSince));
    if (params.status) q.set('Status', params.status);
    const qs = q.toString();
    const matters = this.present((await this.getAll<Raw>(`/matters${qs ? `?${qs}` : ''}`)).map(adaptMatter));
    // Real matters name clients only by contact ref — resolve the first one.
    for (const m of matters) {
      const contactId = m.clientContactIds[0];
      if (!contactId || m.clientFirstName) continue;
      const name = await this.contactName(contactId);
      if (name) {
        m.clientFirstName = name.firstName;
        m.clientLastName = name.lastName;
      }
    }
    return matters.map(({ clientContactIds: _c, title: _t, ...core }) => core);
  }
  private async contactName(contactId: string): Promise<{ firstName: string; lastName: string } | null> {
    const hit = this.contactNames.get(contactId);
    if (hit !== undefined) return hit;
    try {
      const name = adaptContactName(await this.get<Raw>(`/contacts/${contactId}`));
      this.contactNames.set(contactId, name);
      return name;
    } catch (e) {
      if (!this.contactsWarned) {
        this.contactsWarned = true;
        console.error(
          `[smokeball] /contacts lookup failed (${String(e instanceof Error ? e.message : e).slice(0, 120)}) — ` +
            'matters will show their title instead of the client name until contacts/read is granted.',
        );
      }
      this.contactNames.set(contactId, null);
      return null;
    }
  }
  async listTasks(params: { updatedSince?: string; matterId?: string } = {}): Promise<Task[]> {
    const q = new URLSearchParams();
    if (params.updatedSince) q.set('LastUpdated', isoNoMillis(params.updatedSince));
    if (params.matterId) q.set('MatterId', params.matterId);
    const qs = q.toString();
    return this.present((await this.getAll<Raw>(`/tasks${qs ? `?${qs}` : ''}`)).map(adaptTask));
  }
  async listEvents(params: { updatedSince?: string; from?: string; to?: string } = {}): Promise<CalendarEvent[]> {
    const q = new URLSearchParams();
    // /events has no LastUpdated; its UpdatedSince accepts ISO *without* zone
    // ("YYYY-MM-DDThh:mm:ss"), per the spec example.
    if (params.updatedSince) q.set('UpdatedSince', isoNoMillis(params.updatedSince).replace(/Z$/, ''));
    if (params.from) q.set('From', params.from);
    if (params.to) q.set('To', params.to);
    const qs = q.toString();
    return this.present((await this.getAll<Raw>(`/events${qs ? `?${qs}` : ''}`)).map(adaptEvent));
  }
  async listFolders(matterId: string): Promise<Folder[]> {
    return adaptFolders(await this.getAll<Raw>(`/matters/${matterId}/documents/folders`), matterId);
  }
  async listFiles(matterId: string): Promise<FileRecord[]> {
    return this.present(
      (await this.getAll<Raw>(`/matters/${matterId}/documents/files`)).map((r) => adaptFile(r, matterId)),
    );
  }
  async listMemos(matterId: string): Promise<Memo[]> {
    const toStaff = (userId: string) => this.userToStaff.get(userId) ?? userId;
    return this.present((await this.getAll<Raw>(`/matters/${matterId}/memos`)).map((r) => adaptMemo(r, toStaff)));
  }
  async downloadFile(matterId: string, fileId: string): Promise<string> {
    const { downloadUrl } = await this.get<{ downloadUrl: string }>(
      `/matters/${matterId}/documents/files/${fileId}/download`,
    );
    // Presigned URLs are absolute in production, path-relative in the mock.
    const url = downloadUrl.startsWith('http') ? downloadUrl : `${this.cfg.baseUrl}${downloadUrl}`;
    const res = await this.schedule(() => fetch(url));
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    return res.text();
  }
  async searchFiles(query: string, matterIds?: string[]): Promise<{ value: FileRecord[] }> {
    const res = await this.request<{ value?: Raw[] } | Raw[]>('POST', '/search/files', {
      query,
      ...(matterIds ? { matterIds } : {}),
    });
    const raws = Array.isArray(res) ? res : (res.value ?? []);
    return { value: this.present(raws.map((r) => adaptFile(r, String(r['matterId'] ?? '')))) };
  }

  // --------------------------------------------------------------- webhooks
  /** Real body: { name, key, eventTypes, eventNotificationUrl }. The key is
   *  OURS — Smokeball signs each notification with it (docs/02). */
  createWebhook(eventTypes: string[], callbackUrl: string, key = 'mock-webhook-key', name = 'PAM'): Promise<{ id: string; key: string }> {
    return this.request('POST', '/webhooks', { name, key, eventTypes, eventNotificationUrl: callbackUrl });
  }
  /** Event type names as the API spells them — read before subscribing. */
  async listWebhookTypes(): Promise<string[]> {
    const res = await this.get<{ value?: Raw[] } | Raw[]>('/webhooks/types');
    const raws = Array.isArray(res) ? res : (res.value ?? []);
    return raws.map((r) => String(r['id'] ?? r['name'] ?? r['type'] ?? JSON.stringify(r)));
  }
  listWebhooks(): Promise<{ value: { id: string }[] }> {
    return this.get('/webhooks');
  }
  deleteWebhook(id: string): Promise<unknown> {
    return this.request('DELETE', `/webhooks/${id}`);
  }

  /** One task by id — the API has no GET /tasks/{id}, so this lists and finds
   *  (narrowed by matter when known). Used to verify async writes landed. */
  async getTask(id: string, matterId?: string): Promise<Task | null> {
    const tasks = matterId ? await this.listTasks({ matterId }) : await this.listTasks();
    return tasks.find((t) => t.id === id) ?? null;
  }
  async getEvent(id: string): Promise<CalendarEvent | null> {
    try {
      return adaptEvent(await this.get<Raw>(`/events/${id}`));
    } catch (e) {
      if (/-> 404/.test(String(e))) return null;
      throw e;
    }
  }

  // ----------------------------------------------------------- async writes
  // Core types in; the real DTO goes over the wire. `staffId` is the acting
  // staff member — REQUIRED by TaskDto. A 202 answers with a hypermedia Link
  // to the record being created — its `id` is how we verify the write landed.
  createTask(task: Partial<Task>, staffId: string, requestId?: string): Promise<WriteReceipt> {
    return this.write('POST', '/tasks', toTaskDto(task, staffId), requestId);
  }
  updateTask(id: string, patch: Partial<Task>, staffId: string, requestId?: string): Promise<WriteReceipt> {
    return this.write('PUT', `/tasks/${id}`, toTaskDto(patch, staffId), requestId);
  }
  createEvent(event: Partial<CalendarEvent>, requestId?: string): Promise<WriteReceipt> {
    return this.write('POST', '/events', toEventDto(event), requestId);
  }

  private async write(
    method: string,
    path: string,
    body: unknown,
    requestId?: string,
    retried = false,
  ): Promise<WriteReceipt> {
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
    const j = (await res.json().catch(() => ({}))) as Raw;
    return {
      ...(typeof j['requestId'] === 'string' ? { requestId: j['requestId'] } : {}),
      ...(typeof j['id'] === 'string' ? { id: j['id'] } : {}),
      ...(typeof j['href'] === 'string' ? { href: j['href'] } : {}),
    };
  }
}
