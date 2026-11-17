import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { ChatPanel } from '../chat.js';

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

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  in_negotiation: { label: 'In negotiation', cls: 'ok' },
  sent_acknowledged: { label: 'Sent · acknowledged', cls: 'ok' },
  sent_verified: { label: 'Sent · awaiting response', cls: 'warn' },
  prepared_unverified: { label: 'Prepared · sending unverified', cls: 'info' },
  ready_in_suit: { label: 'Ready — in suit', cls: 'warn' },
  demand_made: { label: 'Demand made · no offer yet', cls: 'info' },
};

export function SettlementsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['settlements'],
    queryFn: async () => {
      const res = await fetch('/api/settlements');
      if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthenticated'); }
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

  return (
    <div className="page-inner" style={{ maxWidth: 1160 }}>
      <div className="card">
        <div className="card-h">
          <h2>Every case in play, ranked by latest negotiation</h2>
          <span className="rule" />
          <span className="count">{data?.count ?? '…'}</span>
        </div>
        <div className="card-body">
          {isLoading && <div className="skeleton" style={{ height: 120 }} />}
          {firstSync && !data?.warming && (
            <div className="board-warming" role="status">
              PAM is still reading the firm’s notes and documents for the first time — more cases will appear here as she goes.
            </div>
          )}
          {data?.warming && (
            <div className="board-warming" role="status">
              PAM is still reading the firm’s matters
              {data.progress && data.progress.total > 0 ? ` — ${data.progress.done} of ${data.progress.total} reviewed` : ''}.
              Cases appear here as they are found.
            </div>
          )}
          {data?.error && <div className="empty">The board could not be built just now: {data.error}</div>}
          {data?.matters.map((row) => (
            <div className="row" key={row.matterId} style={{ flexWrap: 'wrap' }}>
              <span className="grow" style={{ flexBasis: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <Link className="matter-chip" to={`/matters/${row.matterId}`} style={{ fontSize: 17.5 }}>
                    {row.matter.replace(/^Matter \S+ · /, '')}
                  </Link>
                  <span className={`pill ${STATUS_LABELS[row.status]?.cls ?? 'info'}`}>
                    {STATUS_LABELS[row.status]?.label ?? row.status}
                  </span>
                  {row.interpreted && row.interpreted.length > 0 && (
                    <span
                      className="pill info"
                      title="These figures were read from free-form notes rather than labelled lines (Demand: / Offer:). Each one appears word-for-word in the notes — open the matter to confirm."
                    >
                      Read from notes
                    </span>
                  )}
                </div>
                <div className="meta" style={{ marginTop: 4 }}>{row.statusReason}</div>
                <div className="meta" style={{ marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {row.demand && <span><b style={{ fontSize: 15 }}>Demand</b> {row.demand}</span>}
                  {row.offer && <span><b style={{ fontSize: 15 }}>Offer</b> {row.offer}{row.offerBy ? ` (${row.offerBy})` : ''}</span>}
                  {row.policyLimits && <span><b style={{ fontSize: 15 }}>Limits</b> {row.policyLimits}</span>}
                  {row.lienTotal && <span><b style={{ fontSize: 15 }}>Liens</b> {row.lienTotal}</span>}
                  {row.insurer && <span><b style={{ fontSize: 15 }}>Carrier</b> {row.insurer}</span>}
                  {row.claimNumber && <span><b style={{ fontSize: 15 }}>Claim</b> {row.claimNumber}</span>}
                </div>
                <div className="meta" style={{ marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {row.adjusterName && (
                    <span>
                      Adjuster: {row.adjusterName}
                      {row.adjusterPhone && (
                        <> · <a href={`tel:${row.adjusterPhone.replace(/[^\d]/g, '')}`} style={{ color: 'var(--link)', fontWeight: 700 }}>{row.adjusterPhone}</a></>
                      )}
                    </span>
                  )}
                  {row.followUp && (
                    <span>
                      Follow-up: {row.followUp.dueDate ?? 'no date'}{' '}
                      {row.followUp.state === 'overdue' && <span className="pill alert">overdue</span>}
                    </span>
                  )}
                  {row.lastNegotiationBy && <span>Last touched by {row.lastNegotiationBy}</span>}
                </div>
                {row.injuries && <div className="meta" style={{ marginTop: 4 }}>Injuries: {row.injuries}</div>}
              </span>
            </div>
          ))}
          {data && data.matters.length === 0 && !data.warming && !data.error && (
            <div className="empty">
              No open matters with settlement activity yet. PAM looks for a Settlement Package folder, and for notes
              that mention a demand or an offer with a dollar figure.
            </div>
          )}
        </div>
      </div>
      <div className="empty" style={{ textAlign: 'center' }}>
        Ask PAM: “What are the top five cases I’ve been negotiating on?” — same data, as a conversation.
      </div>
    </div>
  );
}

export function ActivityPage() {
  const { data } = useQuery({ queryKey: ['audit'], queryFn: api.audit, refetchInterval: 30_000 });
  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-body" style={{ paddingTop: 14 }}>
          <p style={{ margin: 0, maxWidth: '60ch' }}>
            This is PAM's on-the-record log: every question asked and every Smokeball lookup she
            made to answer it. When PAM starts making changes (calendaring, moving tasks), each
            proposed and confirmed change appears here too — it's how you audit your assistant.
            Nothing on this page is required daily reading.
          </p>
        </div>
      </div>
      {data?.flags && data.flags.length > 0 && (
        <div className="card">
          <div className="card-h"><h2>Flagged for review</h2><span className="rule" /><span className="count">{data.flags.length}</span></div>
          <div className="card-body">
            {data.flags.map((e) => {
              const p = (e.params ?? {}) as { note?: string; page?: string; context?: string };
              return (
                <div className="row" key={e.id}>
                  <span className="t">{new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  <span className="grow">
                    <b>{p.note}</b>
                    <div className="meta">
                      {new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      {p.page ? ` · on ${p.page}` : ''}
                      {p.context ? ` · ${p.context}` : ''}
                    </div>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-h"><h2>Recent activity</h2></div>
        <div className="card-body">
          {data?.entries.length === 0 && <div className="empty">No activity yet.</div>}
          {data?.entries.filter((e) => e.action !== 'feedback').map((e) => (
            <div className="row" key={e.id}>
              <span className="t">{new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              <span className="grow">
                <b>{e.action.replace('tool:', '')}</b>
                <div className="meta">{e.result ?? ''} · {JSON.stringify(e.params ?? {})}</div>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatPage({ chatEnabled }: { chatEnabled: boolean }) {
  const location = useLocation();
  const prefill = (location.state as { prefill?: string } | null)?.prefill;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChatPanel chatEnabled={chatEnabled} {...(prefill ? { prefill } : {})} />
    </div>
  );
}

export function LoginPage() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="bracket" style={{ display: 'inline-block' }}>
          <span style={{ fontSize: 36 }}>P<b>A</b>M</span>
        </div>
        <div className="firm">Phillips &amp; Millman</div>
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
          <input
            className="input"
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            aria-label="Access code"
            autoFocus
          />
          <button className="btn primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || !code}>
            {busy ? 'Checking…' : 'Open PAM'}
          </button>
        </form>
        {err && <div className="login-err">{err}</div>}
        {/* The alma-mater bar: Miami Law's orange and green, worn quietly. */}
        <div className="alma-mater" title="University of Miami School of Law — Go Canes">
          <span className="um-rule" />
          <span className="um-text">est. Miami Law</span>
          <span className="um-rule alt" />
        </div>
      </div>
    </div>
  );
}
