import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fmtTime, type ApiEvent, type ApiTask } from '../api.js';

/**
 * Today v2 — Jeff's design (docs/10): one day at a time, big. "Today" plus
 * tabs for upcoming weekdays; tap Aug 5 and the August 5 calendar jumps up.
 * Nothing else on this page: schedule + that day's tasks.
 */

interface DayData {
  dateIso: string;
  isToday: boolean;
  todayIso: string;
  label: string;
  events: ApiEvent[];
  tasksDue: ApiTask[];
  asOf: string;
}

async function fetchDay(date?: string): Promise<DayData> {
  const res = await fetch(`/api/day${date ? `?date=${date}` : ''}`);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) throw new Error('failed');
  return res.json() as Promise<DayData>;
}

/** Next N weekdays starting from a given ISO date (inclusive). */
function weekdayTabs(todayIso: string, n = 10): { iso: string; dow: string; label: string }[] {
  const out: { iso: string; dow: string; label: string }[] = [];
  const d = new Date(`${todayIso}T12:00:00`);
  while (out.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const iso = d.toISOString().slice(0, 10);
      out.push({
        iso,
        dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
        label:
          iso === todayIso
            ? 'Today'
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export function TodayPage() {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery({
    queryKey: ['day', selected ?? 'today'],
    queryFn: () => fetchDay(selected),
    refetchInterval: 60_000,
  });

  const tabs = data ? weekdayTabs(data.todayIso) : [];
  const active = selected ?? data?.todayIso;

  return (
    <div className="page-inner">
      {data && (
        <header className="masthead">
          <div className="firmline">Phillips &amp; Millman · Daily Docket</div>
          <h2 className="docket-date">{data.label.replace('Today — ', '')}</h2>
          <div className="double-rule" />
        </header>
      )}
      {tabs.length > 0 && (
        <div className="daytabs" role="tablist" aria-label="Pick a day">
          {tabs.map((t) => (
            <button
              key={t.iso}
              role="tab"
              aria-selected={t.iso === active}
              className={`daytab${t.iso === active ? ' active' : ''}`}
              onClick={() => setSelected(t.iso === data?.todayIso ? undefined : t.iso)}
            >
              <span className="dow">{t.dow}</span>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {isLoading || !data ? (
        <div className="card">
          <div className="card-body">
            <div className="skeleton" style={{ width: '40%' }} />
            <div className="skeleton" />
            <div className="skeleton" style={{ width: '70%' }} />
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-h">
              {/* Masthead carries the date; Jeff's "August 5 calendar" titling kept for other days. */}
              <h2>{data.isToday ? 'Schedule' : `${data.label} calendar`}</h2>
              <span className="rule" />
              <span className="count">{data.events.length} events</span>
            </div>
            <div className="card-body">
              {data.events.length === 0 && (
                <div className="empty">Nothing on the calendar {data.isToday ? 'today' : 'this day'}.</div>
              )}
              {data.events.map((e) => (
                <div className="sched-row" key={e.id}>
                  <div className="sched-time">
                    {fmtTime(e.start)}
                    <span className="end">to {fmtTime(e.end)}</span>
                  </div>
                  <div className="sched-body">
                    <b>{e.subject}</b>
                    <div className="meta">
                      {e.location ? `${e.location}` : ''}
                      {e.location && e.matter ? ' · ' : ''}
                      {e.matterId && e.matter ? (
                        <Link className="matter-chip" to={`/matters/${e.matterId}`}>
                          {e.matter}
                        </Link>
                      ) : (
                        e.matter
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h2>{data.isToday ? 'Tasks due today' : 'Tasks due this day'}</h2>
              <span className="rule" />
              <span className="count">{data.tasksDue.length}</span>
            </div>
            <div className="card-body">
              {data.tasksDue.length === 0 && <div className="empty">Nothing due.</div>}
              {data.tasksDue.map((t) => (
                <div className="row" key={t.id}>
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
                </div>
              ))}
            </div>
          </div>

          <div className="empty" style={{ textAlign: 'center' }}>
            Data as of {fmtTime(data.asOf)} · overdue and statute reminders live under{' '}
            <Link to="/tasks" className="matter-chip">Tasks</Link>
          </div>
        </>
      )}
    </div>
  );
}
