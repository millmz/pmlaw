import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ApiTask } from '../api.js';

/**
 * Tasks — the home for everything task-shaped (docs/10 §8): due today,
 * upcoming, overdue-needs-a-decision, and statute reminders tucked away.
 * "Move to…" opens chat pre-filled so rescheduling flows through PAM's
 * confirmation once the write action lands.
 */

interface TasksData {
  dueToday: ApiTask[];
  upcoming: ApiTask[];
  needsDecision: ApiTask[];
  statuteReminders: { note: string; tasks: ApiTask[] };
  asOf: string;
}

async function fetchTasks(): Promise<TasksData> {
  const res = await fetch('/api/tasks');
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error('failed');
  return res.json() as Promise<TasksData>;
}

const fmtDue = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function TasksPage() {
  const { data, isLoading } = useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 60_000 });
  const navigate = useNavigate();

  const moveViaChat = (t: ApiTask) => {
    navigate('/chat', { state: { prefill: `Move "${t.subject}" to ` } });
  };

  if (isLoading || !data)
    return (
      <div className="page-inner">
        <div className="card"><div className="card-body"><div className="skeleton" /><div className="skeleton" style={{ width: '65%' }} /></div></div>
      </div>
    );

  return (
    <div className="page-inner">
      <Section title="Due today" count={data.dueToday.length} empty="Nothing due today.">
        {data.dueToday.map((t) => (
          <TaskRow key={t.id} t={t} onMove={moveViaChat} />
        ))}
      </Section>

      <Section
        title="Overdue — needs a decision"
        count={data.needsDecision.length}
        empty="Clean — nothing waiting on a decision."
      >
        {data.needsDecision.map((t) => (
          <TaskRow key={t.id} t={t} overdue onMove={moveViaChat} />
        ))}
      </Section>

      <Section title="Upcoming" count={data.upcoming.length} empty="Nothing scheduled ahead.">
        {data.upcoming.map((t) => (
          <TaskRow key={t.id} t={t} onMove={moveViaChat} />
        ))}
      </Section>

      <div className="card">
        <div className="card-body">
          <details className="statute">
            <summary>
              Statute of limitations reminders <span className="count">{data.statuteReminders.tasks.length}</span>
              <span className="pill info">tracked — leave as-is</span>
            </summary>
            <div className="statute-note">{data.statuteReminders.note}</div>
            {data.statuteReminders.tasks.map((t) => (
              <TaskRow key={t.id} t={t} statute />
            ))}
          </details>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-h">
        <h2>{title}</h2>
        <span className="rule" />
        <span className="count">{count}</span>
      </div>
      <div className="card-body">{count === 0 ? <div className="empty">{empty}</div> : children}</div>
    </div>
  );
}

function TaskRow({
  t,
  overdue,
  statute,
  onMove,
}: {
  t: ApiTask;
  overdue?: boolean;
  statute?: boolean;
  onMove?: (t: ApiTask) => void;
}) {
  return (
    <div className="row">
      <span className="t">
        {overdue ? (
          <span className="pill alert">{t.daysOverdue}d late</span>
        ) : t.dueDate ? (
          fmtDue(t.dueDate)
        ) : (
          '—'
        )}
      </span>
      <span className="grow">
        <b>{t.subject}</b>
        <div className="meta">
          {t.matterId && t.matter ? (
            <Link className="matter-chip" to={`/matters/${t.matterId}`}>
              {t.matter}
            </Link>
          ) : (
            t.matter
          )}
        </div>
      </span>
      {onMove && !statute && (
        <span className="act">
          <button className="btn ghost small" onClick={() => onMove(t)} title="Ask PAM to reschedule this task">
            Move to…
          </button>
        </span>
      )}
    </div>
  );
}
