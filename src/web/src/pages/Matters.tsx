import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtTime, type MatterHit, type MatterOverview } from '../api.js';
import { Badge, DataTable, daysUntil, EmptyState, fmtDate, fmtShortDate, fmtWeekday, Icon, Panel, Segmented, SkeletonRows, splitMatter, type Column, type Tone } from '../ui.js';

const DEFAULT_AREAS = ['Personal Injury', 'Medical Malpractice', 'Criminal'];
type StatusFilter = 'Open' | 'Closed' | 'any';

/** How close a statute date is, in a word and a colour. */
function statuteTone(days: number): Tone {
  return days < 0 ? 'danger' : days <= 90 ? 'danger' : days <= 365 ? 'warning' : 'neutral';
}
function statuteWords(days: number): string {
  if (days < 0) return `${Math.abs(days).toLocaleString()} days past`;
  if (days === 0) return 'today';
  if (days < 60) return `${days} days left`;
  if (days < 730) return `${Math.round(days / 30.4)} months left`;
  return `${(days / 365.25).toFixed(1)} years left`;
}

export function MattersPage() {
  const [q, setQ] = useState('');
  const [practiceArea, setPracticeArea] = useState('');
  const [status, setStatus] = useState<StatusFilter>('Open');
  const [areas, setAreas] = useState<string[]>(DEFAULT_AREAS);
  const navigate = useNavigate();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const { data, isFetching, isLoading } = useQuery({
    queryKey: ['matters', q, practiceArea, status],
    queryFn: () => api.matters({ clientName: q || undefined!, practiceArea: practiceArea || undefined!, status }),
    placeholderData: (prev) => prev,
  });

  // The practice-area list is the firm's own: whatever its matters carry.
  useEffect(() => {
    if (!data) return;
    setAreas((have) => {
      const all = new Set(have);
      for (const m of data.matters) if (m.practiceArea && m.practiceArea !== 'Unknown') all.add(m.practiceArea);
      return all.size === have.length ? have : [...all].sort();
    });
  }, [data]);

  const today = me?.today;
  const columns = useMemo<Column<MatterHit>[]>(
    () => [
      {
        key: 'client',
        header: 'Client',
        sort: (m) => splitMatter(m.label).client.toLowerCase(),
        cell: (m) => {
          const { client, number } = splitMatter(m.label);
          return (
            <>
              <Link className="matter-chip cell-main" to={`/matters/${m.id}`} onClick={(e) => e.stopPropagation()}>
                {client || m.label}
              </Link>
              {number && <span className="cell-sub mono">{number}</span>}
            </>
          );
        },
      },
      { key: 'area', header: 'Practice area', sort: (m) => m.practiceArea, cell: (m) => m.practiceArea, muted: true },
      { key: 'venue', header: 'Jurisdiction', hide: 'md', sort: (m) => m.jurisdiction ?? null, cell: (m) => m.jurisdiction ?? '', muted: true },
      {
        key: 'stage',
        header: 'Stage',
        hide: 'lg',
        sort: (m) => (m.isInSuit ? 0 : 1),
        cell: (m) => (m.isInSuit ? <Badge tone="warning">In suit</Badge> : m.isInSuit === false ? <span className="meta">Pre-suit</span> : ''),
      },
      {
        key: 'statute',
        header: 'Statute of limitations',
        sort: (m) => m.statuteDate ?? null,
        cell: (m) => {
          if (!m.statuteDate) return '';
          const days = daysUntil(m.statuteDate, today);
          return (
            <span className="due-cell">
              {fmtDate(m.statuteDate)}
              {m.status === 'Open' && <small style={days <= 365 ? { color: `var(--${statuteTone(days) === 'danger' ? 'danger' : 'warning'})` } : undefined}>{statuteWords(days)}</small>}
            </span>
          );
        },
      },
      { key: 'status', header: 'Status', width: '7rem', sort: (m) => m.status, cell: (m) => <Badge tone={m.status === 'Open' ? 'success' : 'neutral'}>{m.status}</Badge> },
    ],
    [today],
  );

  return (
    <div className="page-inner">
      <div className="toolbar">
        <div className="input-icon" style={{ flex: '2 1 260px' }}>
          <Icon name="search" size={17} />
          <input className="input" placeholder="Search by client name — “Grasso”, “Juan”…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search matters" />
        </div>
        <select className="input" style={{ flex: '0 1 220px' }} value={practiceArea} onChange={(e) => setPracticeArea(e.target.value)} aria-label="Practice area">
          <option value="">All practice areas</option>
          {areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <Segmented
          label="Matter status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'Open', label: 'Open' },
            { value: 'Closed', label: 'Closed' },
            { value: 'any', label: 'All' },
          ]}
        />
      </div>

      {data?.ambiguous && q && (
        <div className="notice warn" role="status">
          <Icon name="alert" size={17} />
          <div>
            <b>Several matches</b> — more than one client matches “{q}”. Pick the right one below.
          </div>
        </div>
      )}

      <Panel title="Matters" count={data ? data.count.toLocaleString() : '…'} actions={isFetching && !isLoading ? <span className="meta">Searching…</span> : undefined} flush>
        {isLoading || !data ? (
          <SkeletonRows rows={8} />
        ) : (
          <DataTable
            columns={columns}
            rows={data.matters}
            rowKey={(m) => m.id}
            onRowClick={(m) => navigate(`/matters/${m.id}`)}
            empty={
              <EmptyState icon="matters" title="No matters match">
                {status === 'Open' ? 'Only open matters are shown — switch to All to include closed files.' : 'Try a different name or practice area.'}
              </EmptyState>
            }
          />
        )}
      </Panel>
    </div>
  );
}

const TABS = ['Overview', 'Notes', 'Tasks', 'Calendar', 'Files'] as const;
type Tab = (typeof TABS)[number];

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function MatterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('Overview');
  const { data, isLoading } = useQuery({ queryKey: ['matter', id], queryFn: () => api.matter(id!) });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });

  if (isLoading)
    return (
      <div className="page-inner">
        <div className="card">
          <SkeletonRows rows={6} />
        </div>
      </div>
    );
  if (!data || data.error)
    return (
      <div className="page-inner">
        <div className="card">
          <EmptyState icon="matters" title="Matter not found">
            It may have been closed or removed in Smokeball. <Link to="/matters">Back to all matters</Link>
          </EmptyState>
        </div>
      </div>
    );

  const m = data.matter;
  const { client, number } = splitMatter(m.label);
  const fileCount = Object.values(data.filesByFolder).reduce((n, f) => n + f.length, 0);
  const counts: Record<Tab, number | null> = { Overview: null, Notes: data.notes.length, Tasks: data.openTasks.length, Calendar: data.upcomingEvents.length, Files: fileCount };
  const statuteDays = m.statuteDate ? daysUntil(m.statuteDate, me?.today) : null;

  const events = (
    <Panel title="Upcoming events" count={data.upcomingEvents.length} flush>
      {data.upcomingEvents.length === 0 ? (
        <EmptyState icon="today" title="No upcoming events">Is a next step calendared?</EmptyState>
      ) : (
        <div>
          {data.upcomingEvents.map((e) => (
            <div className="row" key={e.id}>
              <span className="t">
                {fmtShortDate(e.start)}
                <div className="meta">{fmtWeekday(e.start)}</div>
              </span>
              <span className="grow">
                <b>{e.subject}</b>
                <div className="meta">
                  {fmtTime(e.start)}
                  {e.location ? ` · ${e.location}` : ''}
                </div>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
  const tasks = (
    <Panel title="Open tasks" count={data.openTasks.length} flush>
      {data.openTasks.length === 0 ? (
        <EmptyState icon="tasks" title="No open tasks on this matter" />
      ) : (
        <div>
          {data.openTasks.map((t) => (
            <div className="row" key={t.id}>
              <span className="t">{t.status === 'overdue' ? <Badge tone="danger">Overdue</Badge> : t.dueDate ? fmtShortDate(t.dueDate) : '—'}</span>
              <span className="grow">
                <b>{t.subject}</b>
                {t.assignees.length > 0 && <div className="meta">{t.assignees.join(', ')}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );

  return (
    <div className="page-inner">
      <section className="card">
        <div className="matter-head">
          <div className="matter-title-row">
            <div>
              <h2 className="matter-name">{client || m.label}</h2>
              <div className="matter-sub">
                {number && <span className="mono">Matter {number}</span>}
                {m.practiceArea && <span>· {m.practiceArea}</span>}
              </div>
            </div>
            <div className="badges">
              {m.isInSuit && <Badge tone="warning">In suit</Badge>}
              <Badge tone={m.status === 'Open' ? 'success' : 'neutral'}>{m.status}</Badge>
            </div>
          </div>
          {m.statuteDate && (
            <div className={`notice${statuteDays !== null && statuteDays <= 365 ? ' warn' : ''}`}>
              <Icon name="clock" size={17} />
              <b>Statute of limitations: {fmtDate(m.statuteDate)}</b>
              {statuteDays !== null && m.status === 'Open' && <Badge tone={statuteTone(statuteDays)}>{statuteWords(statuteDays)}</Badge>}
            </div>
          )}
          <dl className="facts">
            <Fact label="Date of loss">{fmtDate(m.dateOfLoss)}</Fact>
            <Fact label="Jurisdiction">{m.jurisdiction || '—'}</Fact>
            <Fact label="Practice area">{m.practiceArea || '—'}</Fact>
            <Fact label="Stage">{m.isInSuit ? 'In suit' : m.isInSuit === false ? 'Pre-suit' : '—'}</Fact>
          </dl>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} type="button" className={`tab${tab === t ? ' active' : ''}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t}
                {counts[t] !== null && <span className="seg-count">{counts[t]}</span>}
              </button>
            ))}
          </div>
        </div>
      </section>

      {tab === 'Overview' && (
        <>
          <div className="two-col">
            {events}
            {tasks}
          </div>
          {data.notes[0] && (
            <Panel title="Latest note" flush actions={<button type="button" className="btn ghost small" onClick={() => setTab('Notes')}>View all</button>}>
              <NoteView note={data.notes[0]} />
            </Panel>
          )}
        </>
      )}

      {tab === 'Notes' && (
        <Panel title="Notes — verbatim from Smokeball" count={data.notes.length} flush>
          {data.notes.length === 0 ? <EmptyState icon="note" title="No notes on this matter" /> : data.notes.map((n) => <NoteView key={n.id} note={n} />)}
        </Panel>
      )}

      {tab === 'Tasks' && tasks}
      {tab === 'Calendar' && events}

      {tab === 'Files' &&
        (fileCount === 0 ? (
          <div className="card">
            <EmptyState icon="file" title="No files on this matter" />
          </div>
        ) : (
          Object.entries(data.filesByFolder).map(([folder, files]) =>
            files.length === 0 ? null : (
              <Panel key={folder} title={folder} count={files.length} flush>
                <DataTable columns={FILE_COLUMNS} rows={files} rowKey={(f) => f.id} />
              </Panel>
            ),
          )
        ))}

      <div className="page-foot">Data as of {fmtTime(data.asOf)} · every fact above is from Smokeball records</div>
    </div>
  );
}

type FileRow = MatterOverview['filesByFolder'][string][number];
const FILE_COLUMNS: Column<FileRow>[] = [
  {
    key: 'name',
    header: 'Document',
    sort: (f) => f.name.toLowerCase(),
    cell: (f) => (
      <span className="file-name">
        <Icon name={/\.(msg|eml)$/i.test(f.name) || f.from ? 'mail' : 'file'} size={16} />
        <span className="cell-main">{f.name}</span>
      </span>
    ),
  },
  { key: 'who', header: 'From / to', muted: true, hide: 'md', cell: (f) => (f.from || f.to ? `${f.from ?? ''}${f.to ? ` → ${f.to}` : ''}` : '') },
  { key: 'date', header: 'Added', width: '9rem', sort: (f) => f.created, cell: (f) => <span className="due-cell">{fmtDate(f.created)}</span> },
];

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function NoteView({ note }: { note: { text: string; lastEditedBy: string; lastEditedAt: string } }) {
  return (
    <article className="note">
      <div className="note-meta">
        <span className="avatar plain" aria-hidden="true">{initialsOf(note.lastEditedBy)}</span>
        <b>{note.lastEditedBy}</b>
        <span>last edited {fmtDate(note.lastEditedAt)}</span>
      </div>
      <div className="note-text">{note.text}</div>
    </article>
  );
}
