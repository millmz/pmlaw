import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtTime, type ApiEvent, type ApiTask } from '../api.js';
import { dropInitials, EmptyState, Icon, Panel, SkeletonRows, splitMatter } from '../ui.js';
import { primeAudio } from '../voice.js';

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
  /** The firm's clock as the server sees it (fixed in the demo). */
  nowIso?: string;
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
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });
  const initials = me?.user.initials;

  const navigate = useNavigate();
  const briefMe = () => {
    // The tap is the gesture that lets her speak (iPhone) — bless audio
    // here, then hand the question to the orb.
    primeAudio();
    navigate(`/pam?ask=${encodeURIComponent('Brief me on today.')}`);
  };

  const tabs = data ? weekdayTabs(data.todayIso) : [];
  const active = selected ?? data?.todayIso;
  const now = data?.nowIso ? new Date(data.nowIso).getTime() : Date.now();

  return (
    <div className="page-inner">
      <header className="docket-head">
        <div>
          <div className="eyebrow">Daily docket</div>
          <h2 className="docket-date">{data ? data.label.replace('Today — ', '') : ' '}</h2>
        </div>
        <button type="button" className="btn primary large brief-btn" onClick={briefMe} title="PAM reads you the day: court, deadlines, what needs a decision">
          <span className="brief-orb" aria-hidden="true" />
          Brief me
        </button>
      </header>

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
          <SkeletonRows rows={5} />
        </div>
      ) : (
        <div className="today-grid">
          {/* The date heads the page; Jeff's "August 5 calendar" titling is kept for other days. */}
          <Panel title={data.isToday ? 'Schedule' : `${data.label} calendar`} count={`${data.events.length} event${data.events.length === 1 ? '' : 's'}`} flush>
            {data.events.length === 0 ? (
              <EmptyState icon="today" title={`Nothing on the calendar ${data.isToday ? 'today' : 'this day'}`} />
            ) : (
              <ol className="agenda">
                {data.events.map((e) => {
                  const past = data.isToday && new Date(e.end).getTime() < now;
                  const live = data.isToday && new Date(e.start).getTime() <= now && new Date(e.end).getTime() >= now;
                  const m = splitMatter(e.matter);
                  return (
                    <li className={`agenda-row${past ? ' past' : ''}${live ? ' live' : ''}`} key={e.id}>
                      <div className="agenda-time">
                        <b>{fmtTime(e.start)}</b>
                        <span>{fmtTime(e.end)}</span>
                      </div>
                      <div className="agenda-mark" aria-hidden="true" />
                      <div className="agenda-body">
                        <div className="agenda-title">{dropInitials(e.subject, initials)}</div>
                        <div className="agenda-meta">
                          {live && <span className="badge badge-success"><span className="badge-dot" />Now</span>}
                          {e.location && (
                            <span className="agenda-where">
                              <Icon name="court" size={13} />
                              {e.location}
                            </span>
                          )}
                          {e.matterId && e.matter ? (
                            <Link className="matter-chip" to={`/matters/${e.matterId}`}>
                              {m.client}
                              {m.number && <span className="mono matter-no">{m.number}</span>}
                            </Link>
                          ) : (
                            e.matter
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>

          <Panel title={data.isToday ? 'Tasks due today' : 'Tasks due this day'} count={data.tasksDue.length} flush>
            {data.tasksDue.length === 0 ? (
              <EmptyState icon="tasks" title="Nothing due" />
            ) : (
              <ul className="tasklist">
                {data.tasksDue.map((t) => {
                  const m = splitMatter(t.matter);
                  return (
                    <li key={t.id}>
                      <span className="task-tick" aria-hidden="true" />
                      <div>
                        <div className="task-title">{dropInitials(t.subject, initials)}</div>
                        {t.matterId && t.matter ? (
                          <Link className="matter-chip task-matter" to={`/matters/${t.matterId}`}>
                            {m.client}
                            {m.number && <span className="mono matter-no">{m.number}</span>}
                          </Link>
                        ) : (
                          t.matter && <span className="meta">{t.matter}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {data && (
        <div className="page-foot">
          Data as of {fmtTime(data.asOf)} · overdue items and statute reminders live under <Link to="/tasks">Tasks</Link>
        </div>
      )}
    </div>
  );
}
