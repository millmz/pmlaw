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

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

/** Primary nav per Jeff's feedback (docs/10): quiet, four destinations. */
const NAV = [
  { to: '/', label: 'Today', icon: '☀' },
  { to: '/chat', label: 'Chat', icon: '✉' },
  { to: '/tasks', label: 'Tasks', icon: '☑' },
  { to: '/settlements', label: 'Settlements', icon: '⚖' },
];
const MORE = [
  { to: '/matters', label: 'Matters', icon: '▤' },
  { to: '/activity', label: 'Activity', icon: '≡' },
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
          <Route path="/*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
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
          <span className="bracket">P<b>A</b>M</span>
          <span className="rail-sub">Phillips &amp; Millman<br />Attorneys at Law</span>
        </div>
        <div className="rail-rule" />
        {NAV.map((n) => (
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
          <span className="rail-sub">{me?.user.name}<br />Mock data · Dev build</span>
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>

      {!onChatPage && (
        <>
          {/* Wide screens: chat permanently docked beside the page. */}
          <aside className="chat-dock" aria-label="PAM chat">
            <ChatPanel chatEnabled={chatEnabled} />
          </aside>
          {/* Mid-size screens: floating button + drawer. */}
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
