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
import { MatterDetailPage, MattersPage } from './pages/Matters.js';
import { ActivityPage, ChatPage, CourtsPage, LoginPage, SettlementsPage } from './pages/misc.js';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });

const NAV = [
  { to: '/', label: 'Today', icon: '☀' },
  { to: '/chat', label: 'Chat', icon: '✉' },
  { to: '/matters', label: 'Matters', icon: '▤' },
  { to: '/settlements', label: 'Settlements', icon: '⚖' },
  { to: '/courts', label: 'Courts', icon: '◫' },
  { to: '/activity', label: 'Activity', icon: '≡' },
];

const TITLES: Record<string, string> = {
  '/': 'Today',
  '/chat': 'Chat',
  '/matters': 'Matters',
  '/settlements': 'Settlements',
  '/courts': 'Courts',
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
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.me });

  // Keyboard shortcut: "/" opens the chat drawer anywhere on desktop.
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
          <span className="rail-sub">Phillips &amp;<br />Millman</span>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="icon">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
        <div className="rail-foot">
          <span className="rail-sub">{me?.user.name}<br />Mock data · dev build</span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <div className="spacer" />
          <span className="asof"><span className="dot" />Synced with Smokeball</span>
        </div>
        <div className="page">
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/chat" element={<ChatPage chatEnabled={chatEnabled} />} />
            <Route path="/matters" element={<MattersPage />} />
            <Route path="/matters/:id" element={<MatterDetailPage />} />
            <Route path="/settlements" element={<SettlementsPage />} />
            <Route path="/courts" element={<CourtsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>

      {!onChatPage && (
        <>
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
      </nav>
    </div>
  );
}
