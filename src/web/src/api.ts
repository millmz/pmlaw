/** Typed client for PAM's own API. */

export interface Citation {
  kind: string;
  id: string;
  label: string;
}
export interface ApiEvent {
  id: string;
  start: string;
  end: string;
  subject: string;
  location?: string | null;
  matter: string | null;
  matterId?: string | null;
}
export interface ApiTask {
  id: string;
  subject: string;
  dueDate?: string | null;
  daysOverdue: number;
  matter: string | null;
  matterId?: string | null;
}
export interface TodayData {
  dateLabel: string;
  nowIso: string;
  asOf: string;
  todayEvents: ApiEvent[];
  weekEvents: ApiEvent[];
  nextWeekCourts: ApiEvent[] | null;
  dueToday: ApiTask[];
  overdue: { needsDecision: ApiTask[]; statuteReminders: { note: string; tasks: ApiTask[] } };
  watchlist: { stalledMatters: { id: string; label: string; lastActivity: string }[] };
  citationCount: number;
}
export interface Me {
  authed: boolean;
  gated: boolean;
  chatEnabled: boolean;
  user: { name: string; initials: string; staffId: string };
}
export interface MatterHit {
  id: string;
  label: string;
  practiceArea: string;
  jurisdiction?: string;
  status: string;
  isInSuit?: boolean | null;
  statuteDate?: string | null;
}
export interface MatterOverview {
  matter: {
    id: string;
    label: string;
    practiceArea?: string;
    jurisdiction?: string;
    status: string;
    isInSuit?: boolean | null;
    dateOfLoss?: string | null;
    statuteDate?: string | null;
  };
  openTasks: { id: string; subject: string; dueDate?: string | null; status: string; assignees: string[] }[];
  upcomingEvents: { id: string; start: string; subject: string; location?: string | null }[];
  notes: { id: string; text: string; author: string; lastEditedBy: string; lastEditedAt: string }[];
  filesByFolder: Record<string, { id: string; name: string; created: string; from?: string | null; to?: string | null }[]>;
  asOf: string;
  error?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export const api = {
  me: () => get<Me>('/api/me'),
  today: () => get<TodayData>('/api/today'),
  matters: (params: { clientName?: string; practiceArea?: string; status?: string }) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return get<{ count: number; ambiguous: boolean; matters: MatterHit[] }>(`/api/matters?${q}`);
  },
  matter: (id: string) => get<MatterOverview>(`/api/matters/${id}`),
  courts: (scope: string) => get<{ events: ApiEvent[] }>(`/api/courts?scope=${scope}`),
  audit: () =>
    get<{ entries: { id: number; at: string; actor: string; action: string; params: unknown; result: string | null }[] }>(
      '/api/audit',
    ),
  login: async (code: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Login failed.');
  },
  sync: () => fetch('/api/sync', { method: 'POST' }),
};

export type ChatStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'done'; sessionId: string; text: string; citations: Citation[]; citationsValid: boolean }
  | { type: 'error'; message: string };

/** POST + parse the SSE stream from /api/chat/stream. */
export async function streamChat(
  message: string,
  sessionId: string | null,
  onEvent: (e: ChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    onEvent({ type: 'error', message: body.error ?? `Chat failed (${res.status}).` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent);
      } catch {
        // skip malformed frame
      }
    }
  }
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

export const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
