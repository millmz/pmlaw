import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ApiTask } from '../api.js';
import { Badge, DataTable, dropInitials, EmptyState, fmtShortDate, fmtWeekday, Icon, Panel, SkeletonRows, splitMatter, Stat, type Column } from '../ui.js';

/**
 * Tasks — the home for everything task-shaped (docs/10 §8): due today,
 * overdue-needs-a-decision, upcoming, and statute reminders tucked away.
 * "Move to…" opens chat pre-filled so rescheduling flows through PAM's
 * confirmation.
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

export function TasksPage() {
  const { data, isLoading } = useQuery({ queryKey: ['tasks'], queryFn: fetchTasks, refetchInterval: 60_000 });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const navigate = useNavigate();
  const initials = me?.user.initials;

  const columns = useMemo(() => {
    const moveViaChat = (t: ApiTask) => navigate('/chat', { state: { prefill: `Move "${t.subject}" to ` } });
    const build = (kind: 'plain' | 'overdue' | 'statute'): Column<ApiTask>[] => [
      {
        key: 'due',
        header: kind === 'overdue' ? 'Overdue' : 'Due',
        width: '8.5rem',
        sort: (t) => t.dueDate ?? null,
        cell: (t) =>
          kind === 'overdue' ? (
            <Badge tone="danger">{t.daysOverdue}d late</Badge>
          ) : t.dueDate ? (
            <span className="due-cell">
              {fmtShortDate(t.dueDate)}
              <small>{fmtWeekday(t.dueDate)}</small>
            </span>
          ) : (
            <span className="meta">No date</span>
          ),
      },
      { key: 'task', header: 'Task', sort: (t) => dropInitials(t.subject, initials), cell: (t) => <span className="cell-main">{dropInitials(t.subject, initials)}</span> },
      {
        key: 'matter',
        header: 'Matter',
        width: '30%',
        sort: (t) => splitMatter(t.matter).client || null,
        cell: (t) => {
          const m = splitMatter(t.matter);
          return t.matterId && t.matter ? (
            <Link className="matter-chip" to={`/matters/${t.matterId}`}>
              {m.client}
              {m.number && <span className="mono matter-no">{m.number}</span>}
            </Link>
          ) : (
            <span className="meta">{t.matter ?? '—'}</span>
          );
        },
      },
      ...(kind === 'statute'
        ? []
        : [
            {
              key: 'act',
              header: '',
              align: 'right' as const,
              width: '7.5rem',
              cell: (t: ApiTask) => (
                <button className="btn ghost small" onClick={() => moveViaChat(t)} title="Ask PAM to reschedule this task">
                  Move to…
                </button>
              ),
            },
          ]),
    ];
    return { plain: build('plain'), overdue: build('overdue'), statute: build('statute') };
  }, [navigate, initials]);

  if (isLoading || !data)
    return (
      <div className="page-inner">
        <div className="card">
          <SkeletonRows rows={6} />
        </div>
      </div>
    );

  const key = (t: ApiTask) => t.id;
  return (
    <div className="page-inner">
      <div className="stats">
        <Stat label="Due today" value={data.dueToday.length} icon="today" />
        <Stat label="Overdue" value={data.needsDecision.length} icon="alert" {...(data.needsDecision.length > 0 ? { tone: 'danger' as const } : {})} hint={data.needsDecision.length > 0 ? 'Each needs a decision' : 'Nothing waiting'} />
        <Stat label="Upcoming" value={data.upcoming.length} icon="clock" />
        <Stat label="Statute reminders" value={data.statuteReminders.tasks.length} icon="shield" hint="Tracked, never moved" />
      </div>

      <Panel title="Due today" count={data.dueToday.length} flush>
        <DataTable columns={columns.plain} rows={data.dueToday} rowKey={key} empty={<EmptyState icon="today" title="Nothing due today" />} />
      </Panel>

      <Panel title="Overdue — needs a decision" count={data.needsDecision.length} flush>
        <DataTable columns={columns.overdue} rows={data.needsDecision} rowKey={key} rowTone={() => 'danger'} empty={<EmptyState icon="check" title="Nothing waiting on a decision" />} />
      </Panel>

      <Panel title="Upcoming" count={data.upcoming.length} flush>
        <DataTable columns={columns.plain} rows={data.upcoming} rowKey={key} empty={<EmptyState icon="clock" title="Nothing scheduled ahead" />} />
      </Panel>

      <section className="card">
        <details className="statute">
          <summary>
            <Icon name="chevronRight" size={16} className="chev" />
            Statute of limitations reminders
            <span className="count">{data.statuteReminders.tasks.length}</span>
            <span className="space" />
            <Badge tone="neutral" dot={false}>tracked — leave as-is</Badge>
          </summary>
          {data.statuteReminders.note && <div className="statute-note">{data.statuteReminders.note}</div>}
          <DataTable columns={columns.statute} rows={data.statuteReminders.tasks} rowKey={key} empty={<EmptyState icon="shield" title="No statute reminders" />} />
        </details>
      </section>
    </div>
  );
}
