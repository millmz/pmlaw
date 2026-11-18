import { useMemo, useState, type ReactNode } from 'react';

/**
 * PAM's shared interface kit — the pieces every screen is built from, so
 * every screen looks and behaves like part of one product: one icon set,
 * one way to show a status, one table, one empty state, one way to write a
 * date or a dollar figure.
 */

// ------------------------------------------------------------------ icons

/** 24×24 stroke icons (one weight, one grid) — never emoji or font glyphs,
 *  which render differently on every device. */
const ICONS = {
  today: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 14h3v3H8z'],
  tasks: ['M9 11l3 3L22 4', 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11'],
  matters: ['M3 7h18a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1z', 'M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2', 'M2 13h20'],
  settle: ['M12 3v18', 'M7 21h10', 'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2', 'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z', 'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1z'],
  orb: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  check: ['M20 6 9 17l-5-5'],
  chevronRight: ['m9 18 6-6-6-6'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronUp: ['m18 15-6-6-6 6'],
  collapse: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18', 'm16 15-3-3 3-3'],
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  alert: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm4.93 19.07 1.41-1.41', 'm17.66 6.34 1.41-1.41'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  type: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v1a7 7 0 0 1-14 0v-1', 'M12 18v4'],
  arrowUpRight: ['M7 17 17 7', 'M7 7h10v10'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'm22 6-10 7L2 6'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
  court: ['M3 22h18', 'M6 18v-7', 'M10 18v-7', 'M14 18v-7', 'M18 18v-7', 'M12 2l8 5H4z'],
  sparkle: ['M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  more: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  note: ['M4 4h16v12l-6 6H4z', 'M14 22v-6h6', 'M8 9h8', 'M8 13h5'],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  lock: ['M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M7 11V7a5 5 0 0 1 10 0v4'],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------- formatting

const FIRM_TZ = 'America/New_York';
const asDate = (v: string): Date => new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00` : v);

/** "Jun 1, 2028" — one way to write a date, everywhere. */
export const fmtDate = (v?: string | null): string => {
  if (!v) return '—';
  const d = asDate(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : FIRM_TZ });
};
/** "Jun 1" — for lists where the year is obvious. */
export const fmtShortDate = (v?: string | null): string => {
  if (!v) return '—';
  const d = asDate(v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...(/^\d{4}-\d{2}-\d{2}$/.test(v) ? {} : { timeZone: FIRM_TZ }) });
};
export const fmtWeekday = (v: string): string => asDate(v).toLocaleDateString('en-US', { weekday: 'short', ...(/^\d{4}-\d{2}-\d{2}$/.test(v) ? {} : { timeZone: FIRM_TZ }) });
export const fmtClock = (v: string): string => new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: FIRM_TZ });
export const fmtDateTime = (v: string): string => `${fmtShortDate(v)}, ${fmtClock(v)}`;

/** Days from today to a date (negative = past). `today` is the firm's date
 *  as the server knows it (YYYY-MM-DD); the device clock is the fallback. */
export const daysUntil = (v: string, today?: string | null): number => {
  const from = today ? asDate(today) : new Date(`${new Date().toLocaleDateString('en-CA')}T12:00:00`);
  return Math.round((asDate(v.slice(0, 10)).getTime() - from.getTime()) / 86_400_000);
};
/** "$250,000" → 250000, for sorting money written as text. */
export const moneyValue = (v?: string | null): number | null => {
  const m = (v ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** How long ago, in the plainest words. */
export const ago = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`;
};

/** "Matter 24-1101 · Peter Grasso" → { number: "24-1101", client: "Peter Grasso" } */
export const splitMatter = (label?: string | null): { number: string; client: string } => {
  const m = (label ?? '').match(/^Matter (\S+) · (.*)$/);
  return m ? { number: m[1]!, client: m[2]! } : { number: '', client: label ?? '' };
};

/** Strip the calendar owner's initials prefix ("JTM - Call…") for display. */
export const dropInitials = (subject: string, initials?: string | null): string => {
  if (!initials) return subject;
  const m = subject.match(/^([A-Z]{2,4})\s*[-–:]?\s+(?=\S)/);
  return m && m[1] === initials.toUpperCase() ? subject.slice(m[0].length) : subject;
};

// ------------------------------------------------------------- components

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

/** A status, said the same way everywhere: a dot and a word. */
export function Badge({ tone = 'neutral', children, dot = true, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        <div className="page-header-text">
          <h2 className="page-title">{title}</h2>
          {description && <p className="page-desc">{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function Stat({ label, value, hint, tone, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: IconName }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-label">
        {icon && <Icon name={icon} size={14} />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

export function Panel({
  title,
  count,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  /** Body has no padding (tables, lists that run edge to edge). */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {title !== undefined && (
        <header className="card-h">
          <h2>{title}</h2>
          {count !== undefined && <span className="count">{count}</span>}
          <span className="card-h-space" />
          {actions}
        </header>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${88 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------- data table

export interface Column<T> {
  key: string;
  header: string;
  /** Cell content. */
  cell: (row: T) => ReactNode;
  /** Value used for sorting; omit for a column that does not sort. */
  sort?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  width?: string;
  /** Hide below this viewport ("md" = tablets, "lg" = small laptops). */
  hide?: 'md' | 'lg';
  /** Secondary columns are quieter. */
  muted?: boolean;
}

/**
 * The one table: sticky header, sortable columns, keyboard-reachable rows.
 * On a phone each row becomes a labelled card, so nothing scrolls sideways.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  initialSort,
  empty,
  rowTone,
  pageSize = 50,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  empty?: ReactNode;
  rowTone?: (row: T) => Tone | undefined;
  /** Rows per page; a pager appears only when there are more. */
  pageSize?: number;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const val = col.sort;
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // blanks last, either direction
      if (y == null) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const at = Math.min(page, pages - 1);
  const shown = pages > 1 ? sorted.slice(at * pageSize, (at + 1) * pageSize) : sorted;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={`${c.align === 'right' ? 'num' : ''}${c.hide ? ` hide-${c.hide}` : ''}`}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className={`th-sort${active ? ' active' : ''}`}
                      onClick={() => (setPage(0), setSort(active ? (sort!.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }))}
                    >
                      {c.header}
                      <Icon name={active && sort!.dir === 'desc' ? 'chevronDown' : 'chevronUp'} size={12} className={active ? '' : 'idle'} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const tone = rowTone?.(r);
            return (
              <tr
                key={rowKey(r)}
                className={`${onRowClick ? 'clickable' : ''}${tone ? ` row-${tone}` : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter') onRowClick(r);
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} data-label={c.header} className={`${c.align === 'right' ? 'num' : ''}${c.muted ? ' muted' : ''}${c.hide ? ` hide-${c.hide}` : ''}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="pager">
          <span>
            {(at * pageSize + 1).toLocaleString()}–{Math.min(sorted.length, (at + 1) * pageSize).toLocaleString()} of {sorted.length.toLocaleString()}
          </span>
          <span className="spacer" />
          <button type="button" className="btn small" disabled={at === 0} onClick={() => setPage(at - 1)}>
            Previous
          </button>
          <button type="button" className="btn small" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/** Filter chips with counts — the page-level "which slice" control. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number; tone?: Tone }[]; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={`seg${o.value === value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className={`seg-count${o.tone ? ` tone-${o.tone}` : ''}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
