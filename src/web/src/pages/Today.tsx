import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, fmtDay, fmtTime, type ApiEvent, type ApiTask } from '../api.js';

export function TodayPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['today'], queryFn: api.today, refetchInterval: 60_000 });

  if (isLoading)
    return (
      <div className="page-inner">
        {[1, 2, 3].map((i) => (
          <div className="card" key={i}>
            <div className="card-body">
              <div className="skeleton" style={{ width: '38%' }} />
              <div className="skeleton" />
              <div className="skeleton" style={{ width: '72%' }} />
            </div>
          </div>
        ))}
      </div>
    );
  if (error || !data)
    return <div className="page-inner"><div className="empty">Couldn’t load today’s brief — try refreshing. If it persists, the sync may be down.</div></div>;

  const next = nextEvent(data.todayEvents, data.nowIso);

  return (
    <div className="page-inner">
      {next && (
        <div className="now-strip">
          <div className="label">Up next</div>
          <div className="what">{next.event.subject}</div>
          <div className="when">
            {fmtTime(next.event.start)}
            {next.event.location ? ` · ${next.event.location}` : ''} — {next.inWords}
          </div>
        </div>
      )}

      <Section title="Today’s calendar" count={data.todayEvents.length} emptyText="No events on your calendar today.">
        {data.todayEvents.map((e) => (
          <EventRow key={e.id} e={e} />
        ))}
      </Section>

      <Section title="Rest of this week" count={data.weekEvents.length} emptyText="Nothing further scheduled this week.">
        {data.weekEvents.map((e) => (
          <EventRow key={e.id} e={e} withDay />
        ))}
      </Section>

      {data.nextWeekCourts && (
        <Section
          title="Next week’s courts (Mon–Fri)"
          count={data.nextWeekCourts.length}
          emptyText="No court appearances scheduled next week yet."
        >
          {data.nextWeekCourts.map((e) => (
            <EventRow key={e.id} e={e} withDay />
          ))}
        </Section>
      )}

      <Section title="Due today" count={data.dueToday.length} emptyText="Nothing due today.">
        {data.dueToday.map((t) => (
          <TaskRow key={t.id} t={t} />
        ))}
      </Section>

      <Section
        title="Overdue — needs a decision"
        count={data.overdue.needsDecision.length}
        emptyText="Clean — nothing waiting on you."
      >
        {data.overdue.needsDecision.map((t) => (
          <TaskRow key={t.id} t={t} overdue />
        ))}
      </Section>

      <div className="card">
        <div className="card-body">
          <details className="statute">
            <summary>
              Statute reminders <span className="count">{data.overdue.statuteReminders.tasks.length}</span>
              <span className="pill info">tracked — leave as-is</span>
            </summary>
            <div className="statute-note">{data.overdue.statuteReminders.note}</div>
            {data.overdue.statuteReminders.tasks.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </details>
        </div>
      </div>

      {data.watchlist.stalledMatters.length > 0 && (
        <Section title="Watchlist — no next step scheduled" count={data.watchlist.stalledMatters.length} emptyText="">
          {data.watchlist.stalledMatters.map((m) => (
            <div className="row" key={m.id}>
              <span className="t"><span className="pill warn">Stalled</span></span>
              <span className="grow">
                <Link className="matter-chip" to={`/matters/${m.id}`}>{m.label}</Link>
                <div className="meta">No open task or upcoming event · last activity {new Date(m.lastActivity).toLocaleDateString()}</div>
              </span>
            </div>
          ))}
        </Section>
      )}

      <div className="empty" style={{ textAlign: 'center' }}>
        {data.dateLabel} · {data.citationCount} Smokeball records · data as of {fmtTime(data.asOf)}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-h">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </div>
      <div className="card-body">{count === 0 ? <div className="empty">{emptyText}</div> : children}</div>
    </div>
  );
}

function EventRow({ e, withDay }: { e: ApiEvent; withDay?: boolean }) {
  return (
    <div className="row">
      <span className="t">{withDay ? fmtDay(e.start) : `${fmtTime(e.start)}–${fmtTime(e.end)}`}</span>
      <span className="grow">
        <b>{e.subject}</b>
        <div className="meta">
          {withDay ? `${fmtTime(e.start)} · ` : ''}
          {e.location ? `${e.location} · ` : ''}
          {e.matterId && e.matter ? <Link className="matter-chip" to={`/matters/${e.matterId}`}>{e.matter}</Link> : e.matter}
        </div>
      </span>
    </div>
  );
}

const fmtDue = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function TaskRow({ t, overdue }: { t: ApiTask; overdue?: boolean }) {
  return (
    <div className="row">
      <span className="t">
        {overdue ? <span className="pill alert">{t.daysOverdue}d late</span> : t.dueDate ? fmtDue(t.dueDate) : ''}
      </span>
      <span className="grow">
        <b>{t.subject}</b>
        <div className="meta">
          {t.matterId && t.matter ? <Link className="matter-chip" to={`/matters/${t.matterId}`}>{t.matter}</Link> : t.matter}
        </div>
      </span>
    </div>
  );
}

function nextEvent(events: ApiEvent[], nowIso: string): { event: ApiEvent; inWords: string } | null {
  const now = new Date(nowIso).getTime();
  for (const e of events) {
    const start = new Date(e.start).getTime();
    if (start > now) {
      const mins = Math.round((start - now) / 60_000);
      const inWords =
        mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
      return { event: e, inWords };
    }
  }
  return null;
}
