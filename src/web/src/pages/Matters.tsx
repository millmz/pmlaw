import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDay, fmtTime } from '../api.js';

export function MattersPage() {
  const [q, setQ] = useState('');
  const [practiceArea, setPracticeArea] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['matters', q, practiceArea],
    queryFn: () => api.matters({ clientName: q || undefined!, practiceArea: practiceArea || undefined! }),
  });

  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 14 }}>
          <input
            className="input"
            style={{ flex: '2 1 220px' }}
            placeholder="Search by client name — “Grasso”, “Juan”…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search matters"
          />
          <select
            className="input"
            style={{ flex: '1 1 150px' }}
            value={practiceArea}
            onChange={(e) => setPracticeArea(e.target.value)}
            aria-label="Practice area"
          >
            <option value="">All practice areas</option>
            <option>Personal Injury</option>
            <option>Medical Malpractice</option>
            <option>Criminal</option>
          </select>
        </div>
      </div>

      {data?.ambiguous && (
        <div className="card">
          <div className="card-body">
            <span className="pill warn">Several matches</span>{' '}
            <span className="meta">More than one client matches “{q}” — pick the right one below.</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h">
          <h2>Matters</h2>
          <span className="count">{data?.count ?? '…'}</span>
          {isFetching && <span className="meta">searching…</span>}
        </div>
        <div className="card-body">
          {data?.matters.length === 0 && (
            <div className="empty">
              No open matters match. Closed matters are excluded — search “any status” via chat if needed.
            </div>
          )}
          {data?.matters.map((m) => (
            <div className="row" key={m.id}>
              <span className="t">
                <span className="pill info">{m.practiceArea}</span>
              </span>
              <span className="grow">
                <Link className="matter-chip" to={`/matters/${m.id}`} style={{ fontSize: 14 }}>
                  {m.label}
                </Link>
                <div className="meta">
                  {m.jurisdiction ?? ''} {m.isInSuit ? '· In suit' : ''}{' '}
                  {m.statuteDate ? `· Statute ${m.statuteDate}` : ''}
                </div>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TABS = ['Overview', 'Notes', 'Tasks', 'Calendar', 'Files'] as const;

export function MatterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const { data, isLoading } = useQuery({ queryKey: ['matter', id], queryFn: () => api.matter(id!) });

  if (isLoading) return <div className="page-inner"><div className="skeleton" style={{ height: 60 }} /><div className="skeleton" style={{ height: 200 }} /></div>;
  if (!data || data.error) return <div className="page-inner"><div className="empty">Matter not found.</div></div>;

  const m = data.matter;
  return (
    <div className="page-inner">
      <div className="card">
        <div className="card-body" style={{ paddingTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ font: '400 22px/1.2 var(--serif)', margin: 0 }}>{m.label}</h1>
            <span className="pill info">{m.practiceArea}</span>
            {m.isInSuit && <span className="pill warn">In suit</span>}
            <span className="pill ok">{m.status}</span>
          </div>
          {m.statuteDate && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--warn-bg)', borderRadius: 8, fontSize: 13 }}>
              <b>Statute of limitations: {m.statuteDate}</b>
              {m.dateOfLoss ? <span className="meta"> · date of loss {m.dateOfLoss} · {m.jurisdiction}</span> : null}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <button key={t} className={`btn ghost`} style={tab === t ? { borderColor: 'var(--gold)', color: 'var(--ink)' } : {}} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'Overview' && (
        <>
          <Section title="Upcoming events" empty="No upcoming events — is a next step calendared?">
            {data.upcomingEvents.map((e) => (
              <div className="row" key={e.id}>
                <span className="t">{fmtDay(e.start)}</span>
                <span className="grow"><b>{e.subject}</b><div className="meta">{fmtTime(e.start)}{e.location ? ` · ${e.location}` : ''}</div></span>
              </div>
            ))}
          </Section>
          <Section title="Open tasks" empty="No open tasks on this matter.">
            {data.openTasks.map((t) => (
              <div className="row" key={t.id}>
                <span className="t">{t.status === 'overdue' ? <span className="pill alert">overdue</span> : t.dueDate ?? '—'}</span>
                <span className="grow"><b>{t.subject}</b><div className="meta">{t.assignees.join(', ')}</div></span>
              </div>
            ))}
          </Section>
          {data.notes[0] && (
            <Section title="Latest note" empty="">
              <NoteView note={data.notes[0]} />
            </Section>
          )}
        </>
      )}

      {tab === 'Notes' && (
        <Section title="Notes — verbatim from Smokeball" empty="No notes on this matter.">
          {data.notes.map((n) => (
            <NoteView key={n.id} note={n} />
          ))}
        </Section>
      )}

      {tab === 'Tasks' && (
        <Section title="Open tasks" empty="No open tasks.">
          {data.openTasks.map((t) => (
            <div className="row" key={t.id}>
              <span className="t">{t.dueDate ?? '—'}</span>
              <span className="grow"><b>{t.subject}</b><div className="meta">{t.status} · {t.assignees.join(', ')}</div></span>
            </div>
          ))}
        </Section>
      )}

      {tab === 'Calendar' && (
        <Section title="Upcoming events" empty="No upcoming events.">
          {data.upcomingEvents.map((e) => (
            <div className="row" key={e.id}>
              <span className="t">{fmtDay(e.start)}</span>
              <span className="grow"><b>{e.subject}</b><div className="meta">{fmtTime(e.start)}{e.location ? ` · ${e.location}` : ''}</div></span>
            </div>
          ))}
        </Section>
      )}

      {tab === 'Files' && (
        <>
          {Object.entries(data.filesByFolder).map(([folder, files]) =>
            files.length === 0 ? null : (
              <Section key={folder} title={folder} empty="">
                {files.map((f) => (
                  <div className="row" key={f.id}>
                    <span className="t">{new Date(f.created).toLocaleDateString()}</span>
                    <span className="grow">
                      <b>{f.name}</b>
                      {(f.from || f.to) && <div className="meta">{f.from ? `From ${f.from} ` : ''}{f.to ? `→ ${f.to}` : ''}</div>}
                    </span>
                  </div>
                ))}
              </Section>
            ),
          )}
        </>
      )}

      <div className="empty" style={{ textAlign: 'center' }}>Data as of {fmtTime(data.asOf)} · every fact above is from Smokeball records</div>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const isEmpty = Array.isArray(children) ? children.length === 0 : !children;
  return (
    <div className="card">
      <div className="card-h"><h2>{title}</h2></div>
      <div className="card-body">{isEmpty ? <div className="empty">{empty}</div> : children}</div>
    </div>
  );
}

function NoteView({ note }: { note: { text: string; lastEditedBy: string; lastEditedAt: string } }) {
  return (
    <div className="row">
      <span className="grow">
        <div style={{ whiteSpace: 'pre-wrap' }}>{note.text}</div>
        <div className="meta" style={{ marginTop: 6 }}>
          — {note.lastEditedBy}, last edited {new Date(note.lastEditedAt).toLocaleDateString()}
        </div>
      </span>
    </div>
  );
}
