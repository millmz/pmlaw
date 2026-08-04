import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/pam" element={<OrbGate />} />
          <Route path="/*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/** The orb room is a full-page takeover outside the Shell chrome. */
function OrbGate() {
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });
  if (isLoading) return null;
  if (me && me.gated && !me.authed) return <Navigate to="/login" replace />;
  return <OrbPage chatEnabled={me?.chatEnabled ?? false} />;
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
          <span className="asof"><span className="dot" />Synced</span>
        </div>
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
