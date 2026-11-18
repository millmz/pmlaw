import { DateTime } from 'luxon';
import { FIRM_TZ } from '../core/dates.js';

/**
 * The orb room's heads-up display.
 *
 * When PAM looks something up, what she found is shown beside her while she
 * talks about it — the schedule, the task list, the matter, the figures. The
 * voice summarizes; the panel carries the detail. Panels are built from the
 * SAME tool results the model reads, so the screen and the voice can never
 * disagree.
 */

export interface PanelItem {
  /** Left column: a time, a date, a day count. */
  lead?: string;
  title: string;
  sub?: string;
  tone?: 'alert' | 'warn' | 'ok' | 'info';
  matterId?: string;
  tel?: string;
}

export interface Panel {
  kind: 'schedule' | 'tasks' | 'matter' | 'matters' | 'settlements' | 'timeline' | 'confirm' | 'list';
  title: string;
  /** Small line under the title ("7 events", "3 overdue"). */
  caption?: string;
  facts?: { k: string; v: string; tel?: string }[];
  items?: PanelItem[];
  /** How many rows exist beyond the ones shown. */
  more?: number;
  note?: string;
}

const MAX = 7;
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

const clock = (iso: unknown): string => {
  const d = typeof iso === 'string' ? DateTime.fromISO(iso, { zone: FIRM_TZ }) : null;
  return d?.isValid ? d.toFormat('h:mm a') : '';
};
const day = (iso: unknown): string => {
  const d = typeof iso === 'string' ? DateTime.fromISO(iso, { zone: FIRM_TZ }) : null;
  return d?.isValid ? d.toFormat('ccc LLL d') : '';
};
/** "Matter 24-1101 · Peter Grasso" → "Peter Grasso" */
const client = (label: unknown): string | undefined => str(label)?.replace(/^Matter \S+ · /, '');
const cap = <T>(xs: T[]): { shown: T[]; more: number } => ({ shown: xs.slice(0, MAX), more: Math.max(0, xs.length - MAX) });
const withMore = (p: Panel, more: number): Panel => (more > 0 ? { ...p, more } : p);
const tel = (phone: unknown): string | undefined => str(phone)?.replace(/[^\d+]/g, '') || undefined;

const taskItem = (t: Rec): PanelItem => {
  const late = typeof t['daysOverdue'] === 'number' && t['daysOverdue'] > 0 ? (t['daysOverdue'] as number) : 0;
  const sub = [client(t['matter']), late ? `${late} day${late === 1 ? '' : 's'} late` : undefined].filter(Boolean).join(' · ');
  return {
    lead: late ? 'late' : day(str(t['dueDate']) ? `${String(t['dueDate'])}T12:00:00` : undefined).replace(/^\w+ /, ''),
    title: str(t['subject']) ?? 'Task',
    ...(sub ? { sub } : {}),
    ...(late ? { tone: 'alert' as const } : {}),
    ...(str(t['matterId']) ? { matterId: str(t['matterId'])! } : {}),
  };
};

const STATUS_WORDS: Record<string, { label: string; tone: PanelItem['tone'] }> = {
  in_negotiation: { label: 'In negotiation', tone: 'ok' },
  sent_acknowledged: { label: 'Sent · acknowledged', tone: 'ok' },
  sent_verified: { label: 'Sent · awaiting response', tone: 'warn' },
  prepared_unverified: { label: 'Prepared · sending unverified', tone: 'info' },
  ready_in_suit: { label: 'Ready — in suit', tone: 'warn' },
  demand_made: { label: 'Demand made', tone: 'info' },
};

/** The firm titles calendar entries and tasks with the owner's initials
 *  ("JTM Deposition - …"). On a panel that is noise — but only a prefix that
 *  really is a staff member's initials is removed ("IME - Dr. Patel" stays). */
export function stripInitials(subject: string, initials: Iterable<string> = []): string {
  const m = subject.match(/^([A-Z]{2,4})\s*[-–:]?\s+(?=\S)/);
  if (!m) return subject;
  for (const i of initials) if (i && i.toUpperCase() === m[1]) return subject.slice(m[0].length);
  return subject;
}

/** Build the panel for one tool result, or null when there is nothing worth showing. */
export function panelFor(tool: string, params: unknown, data: unknown, opts: { initials?: Iterable<string> } = {}): Panel | null {
  const p0 = buildPanel(tool, params, data);
  if (!p0 || !opts.initials) return p0;
  const ini = [...opts.initials];
  return { ...p0, ...(p0.items ? { items: p0.items.map((it) => ({ ...it, title: stripInitials(it.title, ini) })) } : {}) };
}

function buildPanel(tool: string, params: unknown, data: unknown): Panel | null {
  const d = rec(data);
  if (str(d['error'])) return null;
  const p = rec(params);

  switch (tool) {
    case 'get_calendar_events': {
      const events = arr(d['events']);
      const w = rec(d['window']);
      const oneDay = day(w['start']) === day(w['end']);
      const scope = str(w['scope']);
      const title = scope === 'today' ? 'Today' : oneDay ? day(w['start']) : `${day(w['start'])} – ${day(w['end'])}`;
      if (events.length === 0) return { kind: 'schedule', title, caption: 'Nothing on the calendar' };
      const { shown, more } = cap(events);
      return withMore(
        {
          kind: 'schedule',
          title,
          caption: `${events.length} event${events.length === 1 ? '' : 's'}${str(d['calendar']) ? ` · ${String(d['calendar']).replace(/\s*\(.*\)$/, '')}` : ''}`,
          items: shown.map((e) => {
            const sub = [str(e['location']), client(e['matter'])].filter(Boolean).join(' · ');
            return {
              lead: oneDay ? clock(e['start']) : `${day(e['start']).replace(/ \w+ \d+$/, '')} ${clock(e['start'])}`,
              title: str(e['subject']) ?? 'Event',
              ...(sub ? { sub } : {}),
              ...(str(e['matterId']) ? { matterId: str(e['matterId'])! } : {}),
            };
          }),
        },
        more,
      );
    }

    case 'get_tasks': {
      const overdue = [...arr(d['needsDecision']), ...arr(d['overdue'])];
      const dueToday = arr(d['dueToday']);
      const upcoming = arr(d['upcoming']);
      const statute = arr(rec(d['statuteReminders'])['tasks']);
      const all = [...dueToday, ...overdue.filter((t) => !statute.includes(t)), ...upcoming];
      if (all.length === 0 && statute.length === 0) return { kind: 'tasks', title: 'Tasks', caption: 'Nothing open' };
      const { shown, more } = cap(all);
      const bits = [
        dueToday.length ? `${dueToday.length} due today` : '',
        overdue.length ? `${overdue.length} overdue` : '',
        upcoming.length ? `${upcoming.length} upcoming` : '',
      ].filter(Boolean);
      return withMore(
        {
          kind: 'tasks',
          // An overdue-only lookup is its own panel, not a replacement for the full list.
          title: 'needsDecision' in d ? 'Overdue' : 'Tasks',
          ...(bits.length ? { caption: bits.join(' · ') } : {}),
          items: shown.map(taskItem),
          ...(statute.length ? { note: `${statute.length} statute reminder${statute.length === 1 ? '' : 's'} sitting in overdue — expected, never moved.` } : {}),
        },
        more,
      );
    }

    case 'search_matters': {
      const ms = arr(d['matters']);
      if (ms.length === 0) return null;
      if (ms.length === 1) return null; // the overview that follows is the panel
      const { shown, more } = cap(ms);
      return withMore(
        {
          kind: 'matters',
          title: str(p['clientName']) ? `Matches for “${String(p['clientName'])}”` : 'Matters',
          caption: `${ms.length} matter${ms.length === 1 ? '' : 's'}`,
          items: shown.map((m) => ({
            title: client(m['label']) ?? 'Matter',
            sub: [str(m['label'])?.match(/^Matter (\S+)/)?.[1], str(m['practiceArea']), str(m['status']) !== 'Open' ? str(m['status']) : undefined].filter(Boolean).join(' · '),
            ...(str(m['id']) ? { matterId: str(m['id'])! } : {}),
          })),
        },
        more,
      );
    }

    case 'get_matter_overview': {
      const m = rec(d['matter']);
      if (!str(m['label'])) return null;
      const tasks = arr(d['openTasks']);
      const events = arr(d['upcomingEvents']);
      const facts: Panel['facts'] = [];
      const add = (k: string, v: unknown) => {
        const s = str(v);
        if (s) facts.push({ k, v: s });
      };
      add('Matter', str(m['label'])?.match(/^Matter (\S+)/)?.[1]);
      add('Type', [str(m['practiceArea']), str(m['jurisdiction'])].filter(Boolean).join(' · '));
      add('Date of loss', str(m['dateOfLoss']) ? day(`${String(m['dateOfLoss'])}T12:00:00`).replace(/^\w+ /, '') + `, ${String(m['dateOfLoss']).slice(0, 4)}` : undefined);
      add('Statute', str(m['statuteDate']) ? day(`${String(m['statuteDate'])}T12:00:00`).replace(/^\w+ /, '') + `, ${String(m['statuteDate']).slice(0, 4)}` : undefined);
      if (m['isInSuit'] === true) add('Posture', 'In suit');
      const items: PanelItem[] = [
        ...events.slice(0, 3).map((e) => ({ lead: day(e['start'] ?? e['startTime']).replace(/^\w+ /, ''), title: str(e['subject']) ?? 'Event', sub: 'Calendar' })),
        ...tasks.slice(0, 4).map((t) => ({
          lead: str(t['status']) === 'overdue' ? 'late' : day(str(t['dueDate']) ? `${String(t['dueDate'])}T12:00:00` : undefined).replace(/^\w+ /, ''),
          title: str(t['subject']) ?? 'Task',
          sub: 'Task',
          ...(str(t['status']) === 'overdue' ? { tone: 'alert' as const } : {}),
        })),
      ];
      return {
        kind: 'matter',
        title: client(m['label']) ?? 'Matter',
        caption: `${arr(d['notes']).length} note${arr(d['notes']).length === 1 ? '' : 's'} · ${tasks.length} open task${tasks.length === 1 ? '' : 's'}`,
        facts,
        ...(items.length ? { items } : {}),
      };
    }

    case 'get_settlement_board': {
      const ms = arr(d['matters']);
      if (ms.length === 0) return { kind: 'settlements', title: 'In negotiation', caption: d['warming'] ? 'Still reading the firm’s matters…' : 'No cases with settlement activity' };
      const { shown, more } = cap(ms);
      return withMore(
        {
          kind: 'settlements',
          title: 'Cases in play',
          caption: `${ms.length} shown, most recent first`,
          items: shown.map((m) => {
            const st = STATUS_WORDS[str(m['status']) ?? ''];
            const money = [str(m['offer']) ? `Offer ${String(m['offer'])}` : '', str(m['demand']) ? `Demand ${String(m['demand'])}` : ''].filter(Boolean).join(' · ');
            return {
              title: client(m['matter']) ?? 'Matter',
              sub: [money || st?.label, str(m['insurer'])].filter(Boolean).join(' · '),
              ...(st?.tone ? { tone: st.tone } : {}),
              ...(str(m['matterId']) ? { matterId: str(m['matterId'])! } : {}),
              ...(tel(m['adjusterPhone']) ? { tel: tel(m['adjusterPhone'])! } : {}),
            };
          }),
          ...(d['warming'] ? { note: 'Partial — PAM is still reading the firm’s matters.' } : {}),
        },
        more,
      );
    }

    case 'get_settlement_timeline': {
      const f = rec(d['facts']);
      const facts: Panel['facts'] = [];
      const add = (k: string, v: unknown, t?: string) => {
        const s = str(v);
        if (s) facts.push({ k, v: s, ...(t ? { tel: t } : {}) });
      };
      add('Offer', [str(f['offer']), str(f['offerBy']) ? `from ${String(f['offerBy'])}` : ''].filter(Boolean).join(' '));
      add('Demand', f['demand']);
      add('Limits', f['policyLimits']);
      add('Liens', f['lienTotal']);
      add('Carrier', f['insurer']);
      add('Claim', f['claimNumber']);
      add('Adjuster', [str(f['adjusterName']), str(f['adjusterPhone'])].filter(Boolean).join(' · '), tel(f['adjusterPhone']));
      const tl = arr(d['timeline']);
      return {
        kind: 'timeline',
        title: client(d['matter']) ?? 'Settlement',
        caption: STATUS_WORDS[str(d['status']) ?? '']?.label ?? 'Settlement',
        facts,
        items: tl.slice(-5).map((t) => ({ lead: day(`${String(t['date'])}T12:00:00`).replace(/^\w+ /, ''), title: str(t['event']) ?? '' })),
        ...(str(d['statusReason']) ? { note: String(d['statusReason']) } : {}),
      };
    }

    case 'find_stalled_matters': {
      const ms = arr(d['matters']);
      if (ms.length === 0) return { kind: 'list', title: 'No next step scheduled', caption: 'Every open matter has one' };
      const { shown, more } = cap(ms);
      const total = typeof d['total'] === 'number' ? (d['total'] as number) : ms.length;
      return withMore(
        {
          kind: 'list',
          title: 'No next step scheduled',
          caption: `${total} open matter${total === 1 ? '' : 's'}`,
          items: shown.map((m) => ({
            title: client(m['label']) ?? 'Matter',
            sub: str(m['lastActivity']) ? `Last activity ${day(m['lastActivity']).replace(/^\w+ /, '')}` : '',
            ...(str(m['id']) ? { matterId: str(m['id'])! } : {}),
          })),
        },
        more + Math.max(0, total - ms.length),
      );
    }

    default: {
      // Proposed changes: show exactly what would change.
      const card = rec(d['card']);
      if (tool.startsWith('propose_') && Object.keys(card).length) {
        const note = str(card['note']);
        return {
          kind: 'confirm',
          title: str(card['action']) ?? 'Proposed change',
          caption: 'Nothing changes until you say yes',
          facts: Object.entries(card)
            .filter(([k, v]) => k !== 'action' && k !== 'note' && (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '')
            .map(([k, v]) => ({ k: k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), v: String(v) })),
          ...(note ? { note } : {}),
        };
      }
      return null;
    }
  }
}
