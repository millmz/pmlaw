import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { ChatPanel } from './chat.js';
import { FlagButton } from './flag.js';
import { applyPrefs, setPrefs, usePrefs, type Theme } from './prefs.js';
import { ago, Icon, splitMatter, type IconName } from './ui.js';
import { primeAudio } from './voice.js';
import { TodayPage } from './pages/Today.js';
import { TasksPage } from './pages/Tasks.js';
import { MatterDetailPage, MattersPage } from './pages/Matters.js';
import { ActivityPage, ChatPage, LoginPage, SettlementsPage } from './pages/misc.js';
import { OrbPage } from './pages/Orb.js';
import { SettingsPage } from './pages/Settings.js';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

/** The product's map. Three groups: the firm's work, the assistant, and
 *  the back office. */
interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Today', icon: 'today' },
      { to: '/tasks', label: 'Tasks', icon: 'tasks' },
      { to: '/matters', label: 'Matters', icon: 'matters' },
      { to: '/settlements', label: 'Settlements', icon: 'settle' },
    ],
  },
  {
    label: 'Assistant',
    items: [
      { to: '/pam', label: 'Talk to PAM', icon: 'orb' },
      { to: '/chat', label: 'Chat', icon: 'chat' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/activity', label: 'Activity', icon: 'activity' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];
/** Phone tab bar: the four daily destinations and a door to the rest. */
const TABS: NavItem[] = [
  { to: '/', label: 'Today', icon: 'today' },
  { to: '/pam', label: 'PAM', icon: 'orb' },
  { to: '/tasks', label: 'Tasks', icon: 'tasks' },
  { to: '/settlements', label: 'Settle', icon: 'settle' },
];

/** …and what "More" opens on a phone. */
const MORE: NavItem[] = [
  { to: '/matters', label: 'Matters', icon: 'matters' },
  { to: '/chat', label: 'Chat with PAM', icon: 'chat' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

const TITLES: Record<string, string> = {
  '/': 'Today',
  '/chat': 'Chat',
  '/tasks': 'Tasks',
  '/settlements': 'Settlements',
  '/matters': 'Matters',
  '/activity': 'Activity',
  '/settings': 'Settings',
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
        <div className="crash">
          <div className="card">
            <div className="card-body">
              <h1>PAM hit a snag</h1>
              <p>Something broke while drawing this screen. Reloading usually clears it.</p>
              <p className="meta">Details: {this.state.error.message}</p>
              <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  // Theme, text size and Hurricane mode are stamped at boot so every route
  // (orb room included) wears them; the menu and Settings restamp them live.
  useEffect(() => applyPrefs(), []);
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
    <span className={`asof asof-${tone}`} title={title} aria-label={label} data-testid="sync-pill">
      <span className="dot" />
      <span className="asof-label">{label}</span>
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

// ------------------------------------------------------- command palette

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

/** ⌘K / Ctrl-K: go anywhere, find any matter, or hand the words to PAM. */
function CommandPalette({ open, onClose, extra }: { open: boolean; onClose: () => void; extra: Command[] }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const term = q.trim();
  const { data: found, isFetching } = useQuery({
    queryKey: ['palette-matters', term],
    queryFn: () => api.matters({ clientName: term, status: 'any' }),
    enabled: open && term.length >= 2,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to);
    const nav: Command[] = NAV_GROUPS.flatMap((g) => g.items).map((n) => ({
      id: `nav:${n.to}`,
      group: 'Go to',
      label: n.label,
      icon: n.icon,
      run: n.to === '/pam' ? () => (primeAudio(), navigate('/pam')) : go(n.to),
    }));
    const lower = term.toLowerCase();
    const match = (c: Command) => !lower || c.label.toLowerCase().includes(lower);
    const matters: Command[] = (term.length >= 2 ? (found?.matters ?? []) : []).slice(0, 7).map((m) => {
      const { number, client } = splitMatter(m.label);
      return { id: `matter:${m.id}`, group: 'Matters', label: client || m.label, hint: [number, m.practiceArea, m.status !== 'Open' ? m.status : ''].filter(Boolean).join(' · '), icon: 'matters', run: go(`/matters/${m.id}`) };
    });
    const askPam: Command[] = term.length >= 3 ? [{ id: 'ask', group: 'Ask PAM', label: `Ask PAM: “${term}”`, hint: 'She answers aloud', icon: 'sparkle', run: () => (primeAudio(), navigate(`/pam?ask=${encodeURIComponent(term)}`)) }] : [];
    return [...matters, ...askPam, ...nav.filter(match), ...extra.filter(match)];
  }, [term, found, extra, navigate]);

  useEffect(() => setSel(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  let lastGroup = '';
  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Search and commands" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search matters, jump to a page, or ask PAM…"
            aria-label="Search and commands"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(commands.length - 1, s + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              else if (e.key === 'Enter') (e.preventDefault(), run(commands[sel]));
              else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {commands.length === 0 && <div className="palette-empty">{isFetching ? 'Searching…' : 'Nothing matches. Try a client’s name.'}</div>}
          {commands.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="palette-group">{head}</div>}
                <button type="button" className={`palette-item${i === sel ? ' sel' : ''}`} data-sel={i === sel ? '1' : undefined} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
                  <Icon name={c.icon} size={17} />
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
          <span className="spacer" />
          <span>Phillips &amp; Millman · PAM</span>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- shell

function Shell() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { theme, largeText } = usePrefs();
  const setTheme = (t: Theme) => setPrefs({ theme: t });
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('pam-nav');
    return saved ? saved === 'collapsed' : window.innerWidth < 1180;
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const { data: status } = useStatus();

  useEffect(() => localStorage.setItem('pam-nav', collapsed ? 'collapsed' : 'expanded'), [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setDrawerOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setDrawerOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [menuOpen]);
  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, [location.pathname]);

  // A matter page is titled with the client's name.
  const matterId = location.pathname.match(/^\/matters\/([^/]+)/)?.[1];
  const { data: matter } = useQuery({ queryKey: ['matter', matterId], queryFn: () => api.matter(matterId!), enabled: Boolean(matterId) });

  const signOut = useCallback(async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }, []);
  const extra = useMemo<Command[]>(
    () => [
      { id: 'act:chat', group: 'Actions', label: 'Open chat with PAM', hint: '/', icon: 'chat', run: () => setDrawerOpen(true) },
      { id: 'act:text', group: 'Actions', label: largeText ? 'Use standard text size' : 'Use larger text', icon: 'type', run: () => setPrefs({ largeText: !largeText }) },
      { id: 'act:theme', group: 'Actions', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: theme === 'dark' ? 'sun' : 'moon', run: () => setPrefs({ theme: theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'act:out', group: 'Actions', label: 'Sign out', icon: 'logout', run: () => void signOut() },
    ],
    [largeText, theme, signOut],
  );

  if (isLoading) return null;
  if (me && me.gated && !me.authed) return <Navigate to="/login" replace />;

  const chatEnabled = me?.chatEnabled ?? false;
  const onChatPage = location.pathname === '/chat';
  const matterName = matterId ? splitMatter(matter?.matter?.label).client || 'Matter' : null;
  const title = matterName ?? TITLES[location.pathname] ?? 'PAM';
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="shell" data-nav={collapsed ? 'collapsed' : 'expanded'}>
      <aside className="sidebar rail" aria-label="Primary">
        <Link to="/" className="sb-brand" title="Phillips & Millman — PAM">
          <span className="sb-mark" aria-hidden="true">P&amp;M</span>
          <span className="sb-name">
            <b>Phillips &amp; Millman</b>
            <span>PAM · Practice assistant</span>
          </span>
        </Link>
        <nav className="sb-nav">
          {NAV_GROUPS.map((g) => (
            <div className="sb-section" key={g.label}>
              <div className="sb-label">{g.label}</div>
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/'}
                  title={collapsed ? n.label : undefined}
                  onClick={n.to === '/pam' ? primeAudio : undefined}
                  className={({ isActive }) => `nav-link${n.to === '/pam' ? ' pam' : ''}${isActive ? ' active' : ''}`}
                >
                  {n.to === '/pam' ? <span className="nav-orb" aria-hidden="true" /> : <Icon name={n.icon} size={19} />}
                  <span className="nav-text">{n.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sb-foot">
          <div className="sb-user">
            <span className="avatar" aria-hidden="true">{me?.user.initials ?? '—'}</span>
            <span className="sb-user-text">
              <b>{me?.user.name}</b>
              <span>Attorney</span>
            </span>
          </div>
          <button className="sb-collapse" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name="collapse" size={18} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            {matterId && (
              <>
                <Link to="/matters">Matters</Link>
                <Icon name="chevronRight" size={14} />
              </>
            )}
            <h1>{title}</h1>
          </div>
          <div className="spacer" />
          <button className="search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Open search">
            <Icon name="search" size={16} />
            <span>Search matters, pages, or ask PAM</span>
            <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          {me?.writesEnabled === false && (
            <span className="trial-badge" title="Shadow trial: PAM reads the firm's real data but writes nothing to Smokeball until writes are switched on.">
              <Icon name="lock" size={12} />
              <span className="long">Read-only trial</span>
            </span>
          )}
          <SyncPill />
          <FlagButton />
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button className="user-btn" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Account and preferences">
              <span className="avatar">{me?.user.initials ?? '—'}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <b>{me?.user.name}</b>
                  <span>Phillips &amp; Millman, LLP</span>
                </div>
                <div className="menu-label">Appearance</div>
                <div className="theme-seg">
                  {(
                    [
                      ['light', 'Light', 'sun'],
                      ['dark', 'Dark', 'moon'],
                      ['system', 'System', 'monitor'],
                    ] as const
                  ).map(([value, label, icon]) => (
                    <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>
                      <Icon name={icon} size={16} />
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="menu-item ts-toggle" role="menuitemcheckbox" aria-checked={largeText} aria-pressed={largeText} onClick={() => setPrefs({ largeText: !largeText })}>
                  <Icon name="type" size={17} />
                  Larger text
                  <span className="switch end" style={{ marginLeft: 'auto' }} />
                </button>
                <div className="menu-sep" />
                <Link className="menu-item" to="/settings" role="menuitem">
                  <Icon name="settings" size={17} />
                  Settings
                </Link>
                <Link className="menu-item" to="/activity" role="menuitem">
                  <Icon name="activity" size={17} />
                  Activity log
                </Link>
                <div className="menu-sep" />
                <button type="button" className="menu-item" role="menuitem" onClick={() => void signOut()}>
                  <Icon name="logout" size={17} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <FirstSyncBanner />
        <main className="page" style={onChatPage ? { padding: 0, overflow: 'hidden' } : undefined}>
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
        </main>
        <footer className="statusbar">
          <span>
            <b>Smokeball</b> {status?.mode === 'demo' ? '· demonstration data' : '· live'}
          </span>
          <span className="sep" />
          <span>{status?.sync.lastOkAt ? `Last synced ${ago(status.sync.lastOkAt)}` : 'Waiting for first sync'}</span>
          {status && (
            <>
              <span className="sep" />
              <span>
                {status.mirror.matters.toLocaleString()} matters · {status.mirror.tasks.toLocaleString()} open tasks · {status.mirror.events.toLocaleString()} calendar entries
              </span>
            </>
          )}
          <span className="spacer" />
          <span>{me?.writesEnabled === false ? 'Changes to Smokeball are switched off' : 'Every change is confirmed and logged'}</span>
        </footer>
      </div>

      {!onChatPage && (
        <>
          {/* Chat is summoned, never squatting: the button or "/" opens the drawer. */}
          <button className="chat-fab" onClick={() => setDrawerOpen(true)} aria-label="Open PAM chat" title="Ask PAM ( / )">
            <Icon name="chat" size={18} />
            <span>Ask PAM</span>
          </button>
          {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />}
          <div className={`chat-drawer${drawerOpen ? ' open' : ''}`} aria-hidden={!drawerOpen}>
            <button className="close icon-btn" onClick={() => setDrawerOpen(false)} aria-label="Close chat">
              <Icon name="x" size={18} />
            </button>
            {drawerOpen && <ChatPanel chatEnabled={chatEnabled} />}
          </div>
        </>
      )}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} extra={extra} />

      <nav className="tabbar" aria-label="Primary">
        {TABS.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')} onClick={n.to === '/pam' ? primeAudio : undefined}>
            <Icon name={n.icon} size={21} />
            {n.label}
          </NavLink>
        ))}
        <button type="button" className={moreOpen || MORE.some((n) => location.pathname.startsWith(n.to)) ? 'active' : ''} aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
          <Icon name="more" size={21} />
          More
        </button>
      </nav>
      {moreOpen && (
        <>
          <div className="sheet-scrim" onClick={() => setMoreOpen(false)} />
          <div className="sheet" role="menu" aria-label="More">
            {MORE.map((n) => (
              <Link key={n.to} className="menu-item" role="menuitem" to={n.to}>
                <Icon name={n.icon} size={19} />
                {n.label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
