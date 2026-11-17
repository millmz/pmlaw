import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { api } from './api.js';
import { ChatPanel } from './chat.js';
import { TodayPage } from './pages/Today.js';
import { TasksPage } from './pages/Tasks.js';
import { MatterDetailPage, MattersPage } from './pages/Matters.js';
import { ActivityPage, ChatPage, LoginPage, SettlementsPage } from './pages/misc.js';
import { OrbPage } from './pages/Orb.js';
import { SettingsPage } from './pages/Settings.js';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

/** Primary nav per Jeff's feedback (docs/10): quiet, four destinations. */
/** Rail/tabbar destinations. On desktop the monogram is the PAM door, so the
 *  rail filters the /pam item out; the mobile tab bar keeps it. */
const NAV = [
  { to: '/', label: 'Today', icon: '☀' },
  { to: '/pam', label: 'PAM', icon: '◉' },
  { to: '/chat', label: 'Chat', icon: '✉' },
  { to: '/tasks', label: 'Tasks', icon: '☑' },
  { to: '/settlements', label: 'Settle', icon: '⚖' },
];
const MORE = [
  { to: '/matters', label: 'Matters', icon: '▤' },
  { to: '/activity', label: 'Activity', icon: '≡' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

const TITLES: Record<string, string> = {
  '/': 'Today',
  '/chat': 'Chat',
  '/tasks': 'Tasks',
  '/settlements': 'Settlements',
  '/matters': 'Matters',
  '/activity': 'Activity',
};

/** A render crash must show a readable card, never a blank page (the empty-
 *  staging-DB incident: one unhandled error unmounted the whole tree). */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 560, margin: '10vh auto', padding: 24, fontFamily: 'var(--serif)' }}>
          <h1 style={{ fontFamily: 'var(--display)', letterSpacing: '0.14em' }}>PAM hit a snag</h1>
          <p>Something broke while drawing this screen. Reloading usually clears it.</p>
          <p style={{ color: 'var(--ink-3)', fontSize: 14 }}>Details: {this.state.error.message}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  // Hurricane mode is stamped at boot so every route (orb room included)
  // wears it; the Settings toggle restamps it live.
  useEffect(() => {
    document.body.dataset['canes'] = localStorage.getItem('pam-canes') === '1' ? '1' : '';
  }, []);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/pam" element={<OrbGate />} />
            <Route path="/*" element={<Shell />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

/** The orb room is a full-page takeover outside the Shell chrome. */
function OrbGate() {
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });
  if (isLoading) return null;
  if (me && me.gated && !me.authed) return <Navigate to="/login" replace />;
  return <OrbPage chatEnabled={me?.chatEnabled ?? false} />;
}

/** How long ago, in the plainest words. */
const ago = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`;
};

const useStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    // Quick while a long sync runs (progress bar), relaxed otherwise.
    refetchInterval: (q) => (q.state.data?.sync.state === 'first-sync' || q.state.data?.sync.state === 'syncing' ? 3000 : 30000),
    retry: false,
  });

/** The header's honest answer to "is what I'm looking at current?" */
function SyncPill() {
  const { data, isError } = useStatus();
  const qc = useQueryClient();
  const state = isError ? 'offline' : (data?.sync.state ?? 'starting');
  const lastOk = data?.sync.lastOkAt;
  // When a long sync lands, every page refetches so the new data just appears.
  const prev = useRef(state);
  useEffect(() => {
    if ((prev.current === 'first-sync' || prev.current === 'syncing' || prev.current === 'starting') && state === 'ok') {
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'status' });
    }
    prev.current = state;
  }, [state, qc]);
  // Stale = the minute-by-minute refresh has not landed for a while.
  const stale = state === 'ok' && lastOk ? Date.now() - new Date(lastOk).getTime() > 10 * 60_000 : false;
  const tone = state === 'ok' && !stale ? 'ok' : state === 'error' || state === 'offline' || stale ? 'bad' : 'busy';
  const label =
    state === 'offline'
      ? 'Offline'
      : state === 'first-sync'
        ? 'First sync…'
        : state === 'syncing'
          ? 'Syncing…'
          : state === 'error'
            ? 'Sync problem'
            : state === 'starting'
              ? 'Starting…'
              : stale
                ? `Synced ${ago(lastOk!)}`
                : 'Synced';
  const title =
    state === 'error'
      ? `PAM could not reach Smokeball on the last try. What you see is from ${lastOk ? ago(lastOk) : 'an earlier sync'}. ${data?.sync.lastError ?? ''}`
      : state === 'offline'
        ? 'PAM\'s server is not answering. Check your connection.'
        : lastOk
          ? `Last synced with Smokeball ${ago(lastOk)}${data?.mode === 'demo' ? ' (demo data)' : ''}.`
          : 'Waiting for the first sync with Smokeball.';
  return (
    <span className={`asof asof-${tone}`} title={title} data-testid="sync-pill">
      <span className="dot" />
      {label}
      {data?.mode === 'demo' && <span className="asof-demo">Demo</span>}
    </span>
  );
}

/** The very first read of a real firm takes minutes. Say so, with progress,
 *  instead of showing an empty docket that looks broken. */
function FirstSyncBanner() {
  const { data } = useStatus();
  if (!data || data.sync.state !== 'first-sync') return null;
  const p = data.sync.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div className="sync-banner" role="status">
      <div>
        <strong>PAM is reading your Smokeball for the first time.</strong>{' '}
        This usually takes 5–15 minutes and only happens once. Your calendar and tasks appear first; notes and documents follow.
      </div>
      <div className="sync-banner-meta">
        {p ? `Now: ${p.phase}${p.total > 0 ? ` — ${p.done} of ${p.total} matters` : ''}` : 'Starting…'}
        {data.mirror.matters > 0 && ` · ${data.mirror.matters} matters, ${data.mirror.tasks} tasks, ${data.mirror.events} calendar entries so far`}
      </div>
      {pct !== null && (
        <div className="sync-bar"><span style={{ width: `${pct}%` }} /></div>
      )}
    </div>
  );
}

function Shell() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [largeText, setLargeText] = useState(() => localStorage.getItem('pam-ts') === 'lg');
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });

  useEffect(() => {
    document.body.dataset['ts'] = largeText ? 'lg' : '';
    localStorage.setItem('pam-ts', largeText ? 'lg' : '');
  }, [largeText]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setDrawerOpen((o) => !o);
      }
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (isLoading) return null;
  if (me && me.gated && !me.authed) return <Navigate to="/login" replace />;

  const chatEnabled = me?.chatEnabled ?? false;
  const title = TITLES[location.pathname] ?? 'PAM';
  const onChatPage = location.pathname === '/chat';

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-logo">
          {/* The monogram is the door to the orb room. */}
          <NavLink to="/pam" className="bracket" style={{ textDecoration: 'none' }} aria-label="PAM" title="Talk to PAM">
            P<b>A</b>M
          </NavLink>
        </div>
        <div className="rail-rule" />
        {NAV.filter((n) => n.to !== '/pam').map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="icon">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
        <div className="rail-more">
          {MORE.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span className="icon">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </div>
        <div className="rail-foot">
          <span className="rail-sub">{me?.user.initials}</span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <div className="spacer" />
          <button
            className="ts-toggle"
            aria-pressed={largeText}
            onClick={() => setLargeText((v) => !v)}
            title="Larger text"
          >
            A<span style={{ fontSize: '1.25em' }}>A</span>
          </button>
          {me?.writesEnabled === false && (
            <span className="trial-badge" title="Shadow trial: PAM reads the firm's real data but writes nothing to Smokeball until writes are switched on.">
              Trial · read only
            </span>
          )}
          <SyncPill />
        </div>
        <FirstSyncBanner />
        <div className="page" style={onChatPage ? { padding: 0, overflow: 'hidden' } : undefined}>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/chat" element={<ChatPage chatEnabled={chatEnabled} />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/settlements" element={<SettlementsPage />} />
            <Route path="/matters" element={<MattersPage />} />
            <Route path="/matters/:id" element={<MatterDetailPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>

      {!onChatPage && (
        <>
          {/* Chat is summoned, never squatting: fab or "/" opens the drawer. */}
          <button className="chat-fab" onClick={() => setDrawerOpen(true)} aria-label="Open PAM chat" title="Ask PAM ( / )">
            P·M
          </button>
          <div className={`chat-drawer${drawerOpen ? ' open' : ''}`} aria-hidden={!drawerOpen}>
            <button className="close" onClick={() => setDrawerOpen(false)} aria-label="Close chat">✕</button>
            {drawerOpen && <ChatPanel chatEnabled={chatEnabled} />}
          </div>
        </>
      )}

      <nav className="tabbar">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="icon">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
        <NavLink to="/matters" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="icon">⋯</span>
          More
        </NavLink>
      </nav>
    </div>
  );
}
