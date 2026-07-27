import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fmtDay, fmtTime } from '../api.js';
import { ChatPanel } from '../chat.js';

export function CourtsPage() {
  const [scope, setScope] = useState<'this_week' | 'next_week_courts'>('next_week_courts');
  const { data, isLoading } = useQuery({ queryKey: ['courts', scope], queryFn: () => api.courts(scope) });
  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 8, paddingTop: 14 }}>
          <button className="btn ghost" style={scope === 'this_week' ? { borderColor: 'var(--gold)', color: 'var(--ink)' } : {}} onClick={() => setScope('this_week')}>This week</button>
          <button className="btn ghost" style={scope === 'next_week_courts' ? { borderColor: 'var(--gold)', color: 'var(--ink)' } : {}} onClick={() => setScope('next_week_courts')}>Next week Mon–Fri</button>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Office calendar — court &amp; appearances</h2><span className="count">{data?.events.length ?? '…'}</span></div>
        <div className="card-body">
          {isLoading && <div className="skeleton" />}
          {data?.events.length === 0 && <div className="empty">Nothing scheduled in this window.</div>}
          {data?.events.map((e) => (
            <div className="row" key={e.id}>
              <span className="t">{fmtDay(e.start)}</span>
              <span className="grow">
                <b>{e.subject}</b>
                <div className="meta">
                  {fmtTime(e.start)} {e.location ? `· ${e.location} ` : ''}
                  {e.matterId && e.matter ? <Link className="matter-chip" to={`/matters/${e.matterId}`}>{e.matter}</Link> : null}
                </div>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettlementsPage() {
  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-h"><h2>Settlement status board</h2></div>
        <div className="card-body">
          <p style={{ maxWidth: '58ch' }}>
            The board — every active PI matter with injuries, adjuster, policy limits, liens, demand,
            offers, and who spoke to whom — is the next milestone (M3). It's being built on the notes
            and documents PAM already syncs.
          </p>
          <p className="meta">
            Until then, ask in chat: <i>“Where do we stand on settlement in the Grasso matter?”</i>
          </p>
        </div>
      </div>
    </div>
  );
}

export function ActivityPage() {
  const { data } = useQuery({ queryKey: ['audit'], queryFn: api.audit, refetchInterval: 30_000 });
  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-h"><h2>Activity — every question and lookup, on the record</h2></div>
        <div className="card-body">
          {data?.entries.length === 0 && <div className="empty">No activity yet.</div>}
          {data?.entries.map((e) => (
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
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChatPanel chatEnabled={chatEnabled} />
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
      </div>
    </div>
  );
}
