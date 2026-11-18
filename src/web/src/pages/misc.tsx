import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api, type AuditEntry } from '../api.js';
import { ChatPanel } from '../chat.js';
import { Badge, DataTable, EmptyState, fmtClock, fmtShortDate, Icon, moneyValue, Panel, Segmented, SkeletonRows, splitMatter, Stat, type Column, type Tone } from '../ui.js';

interface BoardRow {
  matterId: string;
  matter: string;
  status: string;
  statusReason: string;
  insurer?: string;
  claimNumber?: string;
  policyLimits?: string;
  adjusterName?: string;
  adjusterPhone?: string;
  demand?: string;
  offer?: string;
  offerBy?: string;
  lienTotal?: string;
  injuries?: string;
  packageSentDate?: string;
  followUp?: { subject: string; dueDate?: string; state: string };
  lastNegotiationAt?: string;
  lastNegotiationBy?: string;
  /** Fields PAM read out of free-form notes (not the labelled format). */
  interpreted?: string[];
}

interface BoardData {
  count: number;
  matters: BoardRow[];
  warming?: boolean;
  progress?: { done: number; total: number };
  error?: string;
}

const STATUS_LABELS: Record<string, { label: string; short: string; tone: Tone }> = {
  in_negotiation: { label: 'In negotiation', short: 'In negotiation', tone: 'success' },
  sent_acknowledged: { label: 'Sent · acknowledged', short: 'Acknowledged', tone: 'success' },
  sent_verified: { label: 'Sent · awaiting response', short: 'Awaiting response', tone: 'warning' },
  prepared_unverified: { label: 'Prepared · sending unverified', short: 'Unverified', tone: 'neutral' },
  ready_in_suit: { label: 'Ready — in suit', short: 'In suit', tone: 'warning' },
  demand_made: { label: 'Demand made · no offer yet', short: 'Demand made', tone: 'info' },
};
const statusOf = (s: string) => STATUS_LABELS[s] ?? { label: s, short: s, tone: 'neutral' as Tone };

const BOARD_COLUMNS: Column<BoardRow>[] = [
  {
    key: 'case',
    header: 'Case',
    sort: (r) => splitMatter(r.matter).client.toLowerCase(),
    cell: (r) => {
      const { client, number } = splitMatter(r.matter);
      const st = statusOf(r.status);
      return (
        <div className="case-cell">
          <Link className="matter-chip case-name" to={`/matters/${r.matterId}`}>
            {client || r.matter}
          </Link>
          {number && <span className="mono matter-no">{number}</span>}
          <span className="badges">
            <Badge tone={st.tone}>{st.label}</Badge>
            {r.interpreted && r.interpreted.length > 0 && (
              <Badge tone="neutral" dot={false} title="These figures were read from free-form notes rather than labelled lines (Demand: / Offer:). Each one appears word-for-word in the notes — open the matter to confirm.">
                Read from notes
              </Badge>
            )}
          </span>
          <span className="cell-sub clamp-2" title={r.statusReason}>{r.statusReason}</span>
          {r.injuries && <span className="cell-sub clamp-2" title={r.injuries}>Injuries: {r.injuries}</span>}
        </div>
      );
    },
  },
  { key: 'demand', header: 'Demand', align: 'right', sort: (r) => moneyValue(r.demand), cell: (r) => (r.demand ? <span className="money">{r.demand}</span> : '') },
  {
    key: 'offer',
    header: 'Offer',
    align: 'right',
    sort: (r) => moneyValue(r.offer),
    cell: (r) =>
      r.offer ? (
        <span className="money">
          {r.offer}
          {r.offerBy && <span className="money-sub">{r.offerBy}</span>}
        </span>
      ) : (
        ''
      ),
  },
  {
    key: 'limits',
    header: 'Limits · liens',
    align: 'right',
    muted: true,
    sort: (r) => moneyValue(r.policyLimits),
    cell: (r) =>
      r.policyLimits || r.lienTotal ? (
        <>
          {r.policyLimits && (
            <span className="cell-money stacked">
              {r.policyLimits}
              <span className="money-sub">policy limit</span>
            </span>
          )}
          {r.lienTotal && (
            <span className="cell-money stacked">
              {r.lienTotal}
              <span className="money-sub">liens</span>
            </span>
          )}
        </>
      ) : (
        ''
      ),
  },
  {
    key: 'carrier',
    header: 'Carrier & adjuster',
    sort: (r) => r.insurer?.toLowerCase() ?? null,
    cell: (r) =>
      r.insurer || r.adjusterName || r.claimNumber ? (
        <>
          {r.insurer && <span className="cell-main">{r.insurer}</span>}
          {r.adjusterName && <span className="cell-sub">{r.adjusterName}</span>}
          {r.adjusterPhone && (
            <a className="tel cell-sub" href={`tel:${r.adjusterPhone.replace(/[^\d]/g, '')}`}>
              <Icon name="phone" size={12} />
              {r.adjusterPhone}
            </a>
          )}
          {r.claimNumber && <span className="cell-sub mono">Claim {r.claimNumber}</span>}
        </>
      ) : (
        ''
      ),
  },
  {
    key: 'follow',
    header: 'Follow-up',
    sort: (r) => r.followUp?.dueDate ?? null,
    cell: (r) =>
      r.followUp || r.lastNegotiationBy ? (
        <>
          {r.followUp && (r.followUp.state === 'overdue' ? <Badge tone="danger">Overdue{r.followUp.dueDate ? ` · ${fmtShortDate(r.followUp.dueDate)}` : ''}</Badge> : <span className="due-cell">{r.followUp.dueDate ? fmtShortDate(r.followUp.dueDate) : 'No date'}</span>)}
          {r.lastNegotiationBy && <span className="cell-sub">Last touched by {r.lastNegotiationBy}</span>}
        </>
      ) : (
        ''
      ),
  },
];

export function SettlementsPage() {
  const [filter, setFilter] = useState('all');
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['settlements'],
    queryFn: async () => {
      const res = await fetch('/api/settlements');
      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('unauthenticated');
      }
      if (!res.ok) throw new Error('failed');
      return res.json() as Promise<BoardData>;
    },
    // A cold board on a large firm is worked out in the background — show
    // what is ready and keep asking until it is whole.
    refetchInterval: (q) => (q.state.data?.warming ? 4000 : false),
  });
  // During the firm's first sync the notes are not all in yet — say so, and
  // keep refreshing, rather than showing a short board as if it were whole.
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 15_000, retry: false });
  const firstSync = status?.sync.state === 'first-sync';
  useEffect(() => {
    if (!firstSync) return;
    const t = setInterval(() => void refetch(), 15_000);
    return () => clearInterval(t);
  }, [firstSync, refetch]);

  const rows = data?.matters ?? [];
  const byStatus = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return m;
  }, [rows]);
  const active = filter !== 'all' && !byStatus.has(filter) ? 'all' : filter;
  const shown = active === 'all' ? rows : rows.filter((r) => r.status === active);
  const withOffer = rows.filter((r) => r.offer).length;
  const overdue = rows.filter((r) => r.followUp?.state === 'overdue').length;

  return (
    <div className="page-inner wide">
      <div className="stats">
        <Stat label="Cases in play" value={data ? data.count : '…'} icon="settle" hint="Ranked by latest negotiation" />
        <Stat label="With an offer" value={data ? withOffer : '…'} icon="check" />
        <Stat label="Awaiting a response" value={data ? (byStatus.get('sent_verified') ?? 0) + (byStatus.get('demand_made') ?? 0) : '…'} icon="clock" />
        <Stat label="Follow-ups overdue" value={data ? overdue : '…'} icon="alert" {...(overdue > 0 ? { tone: 'danger' as const } : {})} />
      </div>

      {firstSync && !data?.warming && (
        <div className="board-warming" role="status">
          PAM is still reading the firm’s notes and documents for the first time — more cases will appear here as she goes.
        </div>
      )}
      {data?.warming && (
        <div className="board-warming" role="status">
          PAM is still reading the firm’s matters
          {data.progress && data.progress.total > 0 ? ` — ${data.progress.done} of ${data.progress.total} reviewed` : ''}. Cases appear here as they are found.
        </div>
      )}
      {data?.error && (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={17} />
          <div>The board could not be built just now: {data.error}</div>
        </div>
      )}

      {rows.length > 0 && byStatus.size > 1 && (
        <Segmented
          label="Filter by status"
          value={active}
          onChange={setFilter}
          options={[{ value: 'all', label: 'All', count: rows.length }, ...Object.keys(STATUS_LABELS).filter((s) => byStatus.has(s)).map((s) => ({ value: s, label: statusOf(s).short, count: byStatus.get(s)! }))]}
        />
      )}

      <Panel title="Settlement board" count={data ? shown.length : '…'} flush>
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : (
          <DataTable
            columns={BOARD_COLUMNS}
            rows={shown}
            rowKey={(r) => r.matterId}
            rowTone={(r) => (r.followUp?.state === 'overdue' ? 'danger' : undefined)}
            empty={
              data?.warming || data?.error ? (
                <SkeletonRows rows={3} />
              ) : (
                <EmptyState icon="settle" title="No settlement activity yet">
                  PAM looks for a Settlement Package folder, and for notes that mention a demand or an offer with a dollar figure.
                </EmptyState>
              )
            }
          />
        )}
      </Panel>
      <div className="page-foot">Ask PAM: “What are the top five cases I’ve been negotiating on?” — same data, as a conversation.</div>
    </div>
  );
}

// ---------------------------------------------------------------- activity

type ActivityKind = 'lookup' | 'change' | 'memory' | 'settings' | 'other';
const TOOL_WORDS: Record<string, string> = {
  get_calendar_events: 'Read the calendar',
  get_tasks: 'Read tasks',
  search_matters: 'Searched matters',
  get_matter_overview: 'Opened a matter',
  find_stalled_matters: 'Scanned for stalled matters',
  list_firm_staff: 'Read the staff roster',
  get_settlement_board: 'Read the settlement board',
  get_settlement_timeline: 'Read a settlement timeline',
  recall_memories: 'Recalled a preference',
  remember: 'Saved a preference',
  forget_memory: 'Forgot a preference',
  propose_task_create: 'Proposed a new task',
  execute_task_create: 'Created a task',
  propose_event_create: 'Proposed a calendar entry',
  execute_event_create: 'Created a calendar entry',
  propose_task_reschedule: 'Proposed moving a task',
  execute_task_reschedule: 'Moved a task',
};
function describe(e: AuditEntry): { kind: ActivityKind; label: string; refused: boolean } {
  const a = e.action;
  const refused = /REFUSED/.test(a);
  if (a.startsWith('tool:')) {
    const name = a.slice(5);
    const kind: ActivityKind = /^(propose_|execute_)/.test(name) ? 'change' : /memor|remember/.test(name) ? 'memory' : 'lookup';
    return { kind, label: TOOL_WORDS[name] ?? name.replace(/_/g, ' '), refused };
  }
  if (a.startsWith('write:')) return { kind: 'change', label: `${refused ? 'Declined: ' : ''}${a.split(':')[1]!.replace(/_/g, ' ')}`, refused };
  if (a.startsWith('memory:')) return { kind: 'memory', label: refused ? 'Declined to remember a client detail' : a === 'memory:save' ? 'Saved a preference' : 'Forgot a preference', refused };
  if (a.startsWith('settings:')) return { kind: 'settings', label: `Edited ${a.split(':').slice(2).join(':') || 'a setting'}`, refused };
  return { kind: 'other', label: a.replace(/_/g, ' '), refused };
}
const KIND_BADGE: Record<ActivityKind, { label: string; tone: Tone }> = {
  lookup: { label: 'Lookup', tone: 'neutral' },
  change: { label: 'Change', tone: 'brand' },
  memory: { label: 'Memory', tone: 'info' },
  settings: { label: 'Settings', tone: 'warning' },
  other: { label: 'Event', tone: 'neutral' },
};

/** "ok (13 citations)" → "13 records cited"; anything else as logged. */
const plainResult = (r: string | null): string => {
  const m = (r ?? '').match(/^ok \((\d+) citations?\)$/);
  return m ? (m[1] === '0' ? 'Done' : `${m[1]} record${m[1] === '1' ? '' : 's'} cited`) : (r ?? '');
};
/** {"status":"Open","clientName":"Grasso"} → "status: Open · clientName: Grasso" */
const plainParams = (params: unknown): string =>
  params && typeof params === 'object'
    ? Object.entries(params as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' · ')
    : '';

const ACTIVITY_COLUMNS: Column<AuditEntry>[] = [
  {
    key: 'when',
    header: 'When',
    width: '9.5rem',
    sort: (e) => e.at,
    cell: (e) => (
      <span className="due-cell">
        {fmtClock(e.at)}
        <small>{fmtShortDate(e.at)}</small>
      </span>
    ),
  },
  {
    key: 'what',
    header: 'What PAM did',
    sort: (e) => describe(e).label,
    cell: (e) => <span className="cell-main">{describe(e).label}</span>,
  },
  { key: 'kind', header: 'Type', width: '7.5rem', sort: (e) => describe(e).kind, cell: (e) => <Badge tone={describe(e).refused ? 'danger' : KIND_BADGE[describe(e).kind].tone} dot={false}>{describe(e).refused ? 'Declined' : KIND_BADGE[describe(e).kind].label}</Badge> },
  { key: 'result', header: 'Result', muted: true, hide: 'md', cell: (e) => plainResult(e.result) },
  {
    key: 'detail',
    header: 'Details',
    hide: 'lg',
    cell: (e) => {
      const text = plainParams(e.params);
      return text ? <span className="code-cell" title={text}>{text}</span> : '';
    },
  },
];

export function ActivityPage() {
  const { data, isLoading } = useQuery({ queryKey: ['audit'], queryFn: api.audit, refetchInterval: 30_000 });
  const [kind, setKind] = useState<'all' | ActivityKind>('all');
  const entries = useMemo(() => (data?.entries ?? []).filter((e) => e.action !== 'feedback'), [data]);
  const counts = useMemo(() => {
    const m = new Map<ActivityKind, number>();
    for (const e of entries) m.set(describe(e).kind, (m.get(describe(e).kind) ?? 0) + 1);
    return m;
  }, [entries]);
  const shown = kind === 'all' ? entries : entries.filter((e) => describe(e).kind === kind);
  const kinds = (['lookup', 'change', 'memory', 'settings'] as const).filter((k) => counts.has(k));

  return (
    <div className="page-inner">
      <div className="notice">
        <Icon name="shield" size={17} />
        <div>
          PAM’s on-the-record log: every Smokeball lookup she made to answer a question, and every change she proposed or made. It is how you audit your assistant — nothing here is required daily reading.
        </div>
      </div>

      {data?.flags && data.flags.length > 0 && (
        <Panel title="Flagged for review" count={data.flags.length} flush>
          <div>
            {data.flags.map((e) => {
              const p = (e.params ?? {}) as { note?: string; page?: string; context?: string };
              return (
                <div className="row" key={e.id}>
                  <span className="t">
                    {fmtShortDate(e.at)}
                    <div className="meta">{fmtClock(e.at)}</div>
                  </span>
                  <span className="grow">
                    <b>{p.note}</b>
                    <div className="meta">
                      {p.page ? `on ${p.page}` : ''}
                      {p.context ? ` · ${p.context}` : ''}
                    </div>
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {kinds.length > 1 && (
        <Segmented
          label="Filter activity"
          value={kind}
          onChange={setKind}
          options={[{ value: 'all' as const, label: 'All', count: entries.length }, ...kinds.map((k) => ({ value: k, label: `${KIND_BADGE[k].label}s`, count: counts.get(k)! }))]}
        />
      )}
      <Panel title="Recent activity" count={shown.length} flush>
        {isLoading ? <SkeletonRows rows={6} /> : <DataTable columns={ACTIVITY_COLUMNS} rows={shown} rowKey={(e) => String(e.id)} pageSize={25} empty={<EmptyState icon="activity" title="No activity yet">Ask PAM something and it will appear here.</EmptyState>} />}
      </Panel>
    </div>
  );
}

export function ChatPage({ chatEnabled }: { chatEnabled: boolean }) {
  const location = useLocation();
  const prefill = (location.state as { prefill?: string } | null)?.prefill;
  return (
    <div className="chat-page">
      <ChatPanel chatEnabled={chatEnabled} {...(prefill ? { prefill } : {})} />
    </div>
  );
}

export function LoginPage() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <section className="login-brand">
        <div className="login-firm">
          <span className="sb-mark" aria-hidden="true">P&amp;M</span>
          <span>
            <b>Phillips &amp; Millman, LLP</b>
            <span>Trial attorneys · Stony Point, New York</span>
          </span>
        </div>
        <div className="login-pitch">
          <h1>The Firm Choice.</h1>
          <p>PAM is the firm’s practice assistant — your calendar, tasks, matters and settlements, read straight from Smokeball and ready when you ask.</p>
          <ul className="login-points">
            <li><Icon name="file" size={18} /> Every answer cites the Smokeball record it came from</li>
            <li><Icon name="check" size={18} /> Nothing changes without your confirmation</li>
            <li><Icon name="shield" size={18} /> Every lookup and change is logged</li>
          </ul>
        </div>
        {/* The alma-mater bar: Miami Law's orange and green, worn quietly. */}
        <div className="alma-mater" title="University of Miami School of Law — Go Canes">
          <span className="um-rule" />
          <span className="um-text">est. Miami Law</span>
          <span className="um-rule alt" />
        </div>
      </section>
      <section className="login-form-side">
        <div className="login-card">
          <h2>Sign in to PAM</h2>
          <p>Enter the firm access code to open your assistant.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              api
                .login(code)
                // Full reload so every query refetches with the fresh session cookie.
                .then(() => window.location.assign('/'))
                .catch((error: Error) => {
                  setErr(error.message);
                  setBusy(false);
                });
            }}
          >
            <div className="field">
              <label htmlFor="access-code">Access code</label>
              <input id="access-code" className="input" type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="current-password" autoFocus />
            </div>
            <button className="btn primary large" disabled={busy || !code}>
              {busy ? 'Checking…' : 'Open PAM'}
            </button>
          </form>
          {err && <div className="login-err" role="alert">{err}</div>}
          <div className="login-note">
            <Icon name="lock" size={15} />
            <span>Private to Phillips &amp; Millman. This system holds privileged client information — authorized firm staff only.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
