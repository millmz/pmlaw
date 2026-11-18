import { eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { classifyTask, FIRM_TZ } from '../../core/dates.js';
import type { SmokeballClient } from '../../smokeball/client.js';
import { schema, type Db } from '../db/index.js';
import { bumpMirror, mirrorVersion } from '../db/mirror.js';
import type { Citation } from '../tools/citations.js';
import { cite } from '../tools/citations.js';
import { guardModelFacts, type NoteInput, type NoteReader } from './note-reader.js';

/**
 * Settlement intelligence engine (docs/09 §5, docs/08 §5).
 *
 * Reads what Jeff's firm actually produces — matter NOTES first (his
 * hand-maintained source of truth), then the standard folders — and derives
 * an evidence-backed picture per PI/med-mal matter. Every conclusion stores
 * the record ids it rests on; "sending could not be verified" is a routine
 * honest outcome (mail-only sends), never a failure.
 *
 * Parsing is regex-first against the firm's real note patterns
 * ("Insurance:", "Demand:", "Offer: $X made DATE by NAME"). Notes written as
 * free sentences fall back to a small model whose every value is checked
 * against the note text (note-reader.ts) and flagged as "read from notes".
 */

/** Runtime wiring (main.ts): the model fallback and the firm's email domains. */
const config: { noteReader?: NoteReader | undefined; firmDomains: string[] } = { firmDomains: ['pmlawny.com'] };
export function configureSettlement(c: { noteReader?: NoteReader | undefined; firmDomains?: string[] }): void {
  if ('noteReader' in c) config.noteReader = c.noteReader;
  if (c.firmDomains?.length) config.firmDomains = c.firmDomains.map((d) => d.toLowerCase());
}

export interface SettlementFacts {
  insurer?: string;
  claimNumber?: string;
  policyLimits?: string;
  adjusterName?: string;
  adjusterEmail?: string;
  adjusterPhone?: string;
  demand?: string;
  offer?: string;
  offerDate?: string;
  offerBy?: string;
  defenseCounsel?: string;
  lienTotal?: string;
  injuries?: string;
  sourceMemoIds: string[];
  /** Fields a model read out of free-form notes (verified to appear in the
   *  note text, but not in the firm's labelled format). */
  interpreted?: string[];
}

export type SettlementStatus =
  | 'sent_verified'
  | 'sent_acknowledged'
  | 'prepared_unverified'
  | 'in_negotiation'
  | 'ready_in_suit'
  | 'demand_made'
  | 'no_package';

export interface TimelineEntry {
  date: string;
  label: string;
  evidence: Citation;
}

export interface SettlementSummary {
  matterId: string;
  matterLabel: string;
  status: SettlementStatus;
  statusReason: string;
  facts: SettlementFacts;
  packagePreparedDate?: string;
  packageSentDate?: string;
  packageSentTo?: string;
  followUp?: { taskId: string; subject: string; dueDate?: string; state: string };
  lastNegotiationAt?: string;
  lastNegotiationBy?: string;
  timeline: TimelineEntry[];
  citations: Citation[];
}

const grab = (text: string, re: RegExp): string | undefined => {
  const m = text.match(re);
  return m?.[1]?.trim().replace(/[.,\s]+$/, '');
};

/**
 * Dates the way the office actually writes them — "2026-07-21", "7/21/26",
 * "7/21/2026", "July 21, 2026", "Jul 21" — normalized to ISO. Two-digit years
 * are 20xx; a month-day with no year takes the current year.
 */
export function normalizeMemoDate(raw: string, now: DateTime = DateTime.now()): string | undefined {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  const iso = DateTime.fromISO(s, { zone: FIRM_TZ });
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && iso.isValid) return iso.toISODate()!;
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (slash) {
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : now.year;
    const d = DateTime.fromObject({ year: y, month: Number(slash[1]), day: Number(slash[2]) }, { zone: FIRM_TZ });
    return d.isValid ? d.toISODate()! : undefined;
  }
  for (const fmt of ['MMMM d, yyyy', 'MMMM d yyyy', 'MMM d, yyyy', 'MMM d yyyy', 'MMMM d', 'MMM d']) {
    const d = DateTime.fromFormat(s, fmt, { zone: FIRM_TZ });
    if (d.isValid) return (fmt.includes('yyyy') ? d : d.set({ year: now.year })).toISODate()!;
  }
  return undefined;
}

const DATE_TOKEN = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)`;

const MONEY = String.raw`(\$\s?[\d,]+(?:\.\d+)?(?:\s?(?:k|K|million|mil|M)\b)?)`;
const NOT_A_PERSON = /^(the|a|an|phone|email|e-mail|mail|letter|fax|text|end|close|cob|eod|noon|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

const tidyMoney = (raw: string): string => {
  const m = raw.replace(/\s/g, '').match(/^\$([\d,]+(?:\.\d+)?)(k|K|million|mil|M)?$/);
  if (!m || !m[2]) return raw.replace(/\$\s+/, '$');
  const n = Number(m[1]!.replace(/,/g, '')) * (/^k$/i.test(m[2]) ? 1_000 : 1_000_000);
  return `$${Math.round(n).toLocaleString('en-US')}`;
};

/** Notes are read oldest-edit first, so the latest note's facts win. */
export function parseMemoFacts(memoTexts: { id: string; text: string }[], now?: DateTime): SettlementFacts {
  const facts: SettlementFacts = { sourceMemoIds: [] };
  for (const memo of memoTexts) {
    const t = memo.text;
    let used = false;
    const take = (key: keyof Omit<SettlementFacts, 'sourceMemoIds' | 'interpreted'>, re: RegExp, map: (v: string) => string = (v) => v) => {
      const v = grab(t, re);
      if (v !== undefined && v !== '') {
        (facts as unknown as Record<string, unknown>)[key] = map(v);
        used = true;
      }
    };
    take('insurer', /(?:Insurance|Insurer|Carrier)(?:\s+(?:company|co\.?))?:\s*([^.\n,;]+)/i);
    take('claimNumber', /Claim\s*(?:No\.?|Number|#)[:\s]*([A-Z0-9][A-Z0-9-]+)/i);
    take('policyLimits', new RegExp(String.raw`(?:Policy\s*)?limits?(?:\s+(?:of|is|are))?[:\s]*${MONEY}`, 'i'), tidyMoney);
    take('adjusterName', /Adjuster:\s*([^,\n;(]+)/i);
    take('adjusterEmail', /Adjuster:[^\n]*?([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
    take('adjusterPhone', /Adjuster:[^\n]*?(\(?\d{3}\)?[\s.-]?\d{3}[-.]\d{4})/i);
    take('demand', new RegExp(String.raw`\bDemand(?:ed)?\s*(?:[:\-–—]|of|is|was|at|for)?\s*${MONEY}`, 'i'), tidyMoney);
    take('offer', new RegExp(String.raw`\bOffer(?:ed)?\s*(?:[:\-–—]|of|is|was|at)?\s*${MONEY}`, 'i'), tidyMoney);
    {
      const raw = grab(t, new RegExp(String.raw`\bOffer(?:ed)?\b[^\n]*?(?:made|received|conveyed)?\s+(?:on\s+)?${DATE_TOKEN}`, 'i'));
      const norm = raw ? normalizeMemoDate(raw, now) : undefined;
      if (norm && /\bOffer(?:ed)?\s*(?:[:\-–—]|of|is|was|at)?\s*\$/i.test(t)) {
        facts.offerDate = norm;
        used = true;
      }
    }
    {
      const by = grab(t, /\bOffer(?:ed)?\b[^\n]*?\bby\s+([^—\-.\n(,;]+)/i);
      if (by && /^[A-Z]/.test(by) && !NOT_A_PERSON.test(by)) {
        facts.offerBy = by;
        used = true;
      }
    }
    take('defenseCounsel', /Defense counsel:\s*([^\n(]+)/i); // names contain periods ("R. Calloway"); stop at phone paren
    if (used) facts.sourceMemoIds.push(memo.id);
  }
  return facts;
}

/** Evidence that an email actually carried the package: an attachment named
 *  like the package, or a file-sharing link. */
const SENT_MARKERS = [
  /attachment:?\s*settlement package/i,
  /settlement\s*package[^\n]{0,80}\.(pdf|docx?|zip)\b/i,
  /dropbox\.com/i,
  /wetransfer\.com/i,
  /sharefile/i,
  /box\.com\/s\//i,
  /1drv\.ms|sharepoint\.com/i,
];
const LINK_RE = /dropbox|wetransfer|sharefile|box\.com|1drv\.ms|sharepoint/i;
const PACKAGE_RE = /settlement\s*(?:package|demand|brochure)|demand\s*package/i;
const LIEN_AMOUNT_RE = /\$\s?([\d,]+(?:\.\d{2})?)/;
/** Only emails whose NAME suggests settlement traffic get their bodies
 *  downloaded — a real matter holds hundreds of emails and each download is
 *  a rate-limited API call. Everything else is judged on metadata. */
const EMAIL_WORTH_DOWNLOADING = /settlement|package|demand|offer|adjuster|claim|dropbox|wetransfer|sharefile|re:\s*.*(settle|offer)/i;
const MAX_EMAIL_DOWNLOADS_PER_MATTER = 12;
const MAX_LIEN_DOWNLOADS_PER_MATTER = 6;
const PUBLIC_MAIL = new Set(['gmail.com', 'yahoo.com', 'aol.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'msn.com', 'live.com', 'optonline.net', 'verizon.net']);

// ---------------------------------------------------------------- candidates

/** Matter types that are settlement-bearing by nature, by name or category
 *  (real tenants name these in their own words — never an exact match). */
const PI_TYPE_RE = /personal injur|bodily injur|negligen|malpractice|motor vehicle|\bMVA\b|auto(?:mobile)?\b|accident|slip|trip and|premises|wrongful death|labor law|product|dog bite|\binjur|tort|\bPI\b/i;
const NON_SETTLEMENT_TYPE_RE = /criminal|dwi|dui|traffic|real estate|closing|purchase|sale|probate|estate|will\b|trust|matrimonial|divorce|family|landlord|immigration|bankruptcy/i;
const NOTE_SIGNAL_RE = /\b(demand(?:ed)?|offer(?:ed|s)?|settle(?:ment|d)?|adjuster|policy limits?|counter(?:ed|offer)?|mediation)\b/i;
const MONEY_RE = /\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:k|mil|million)\b/i;

export interface CandidateSignals {
  typeName: string;
  typeCategory: string;
  noteTexts: string[];
  folderNames: string[];
  fileNames: string[];
}

/** Is this open matter worth a settlement analysis? Any one signal is
 *  enough: an injury-type matter, a package on file, or notes that talk
 *  money and settlement on a matter that is not plainly something else. */
export function isSettlementCandidate(c: CandidateSignals): boolean {
  const type = `${c.typeName} ${c.typeCategory}`;
  if (PI_TYPE_RE.test(type)) return true;
  if (c.folderNames.some((n) => PACKAGE_RE.test(n)) || c.fileNames.some((n) => PACKAGE_RE.test(n))) return true;
  if (NON_SETTLEMENT_TYPE_RE.test(type)) return false;
  return c.noteTexts.some((t) => NOTE_SIGNAL_RE.test(t) && MONEY_RE.test(t));
}

// ------------------------------------------------------------ derived store

async function getDerived<T>(db: Db, key: string): Promise<T | undefined> {
  const row = (await db.select().from(schema.derived).where(eq(schema.derived.key, key)))[0];
  return row ? (row.value as T) : undefined;
}
async function putDerived(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(schema.derived)
    .values({ key, value: value as never })
    .onConflictDoUpdate({ target: schema.derived.key, set: { value: value as never, updatedAt: new Date() } });
}

/** What a file's CONTENT says, worked out once per file version and kept —
 *  so a restart never re-downloads a firm's worth of email. Only the
 *  signals are stored, never the body. */
interface FileSignals {
  pkg: boolean;
  sent: boolean;
  link: boolean;
  lienAmount?: string;
  injuries?: string;
}

async function fileSignals(
  db: Db,
  client: SmokeballClient,
  file: { id: string; matterId: string; dateModified: string; sizeBytes: number },
): Promise<FileSignals | null> {
  const key = `file:${file.id}:${file.dateModified}`;
  const hit = await getDerived<FileSignals>(db, key);
  if (hit) return hit;
  let body: string;
  try {
    body = await client.downloadFile(file.matterId, file.id);
  } catch {
    return null; // transient — try again on the next analysis
  }
  const amount = body.match(LIEN_AMOUNT_RE)?.[1];
  const inj = body.match(/Injuries:\s*([^\n]+)/i)?.[1]?.trim();
  const sig: FileSignals = {
    pkg: PACKAGE_RE.test(body),
    sent: SENT_MARKERS.some((re) => re.test(body)),
    link: LINK_RE.test(body),
    ...(amount ? { lienAmount: amount } : {}),
    ...(inj ? { injuries: inj.slice(0, 400) } : {}),
  };
  await putDerived(db, key, sig);
  return sig;
}

/**
 * Per-matter analysis cache. A real board walks dozens of matters and each
 * walk downloads files; recomputing on every page load would be minutes of
 * API time. The key is the freshness of every record the analysis reads plus
 * the calendar day (follow-up state depends on "today"), so a sync that
 * touches a matter — or a new day — invalidates exactly that matter.
 */
const analysisCache = new Map<string, { key: string; summary: SettlementSummary | null }>();
export function clearSettlementCache(): void {
  analysisCache.clear();
  bumpMirror();
}

type Row<T extends keyof typeof schema & ('matters' | 'matterTypes' | 'events' | 'memos' | 'folders' | 'files' | 'tasks' | 'staff')> =
  (typeof schema)[T]['$inferSelect'];

interface AnalysisInputs {
  db: Db;
  client: SmokeballClient;
  matter: Row<'matters'>;
  now: DateTime;
  events: Row<'events'>[];
  memos: Row<'memos'>[];
  folders: Row<'folders'>[];
  files: Row<'files'>[];
  tasks: Row<'tasks'>[];
  staff: Row<'staff'>[];
}

const labelOf = (m: Row<'matters'>): string =>
  `Matter ${m.number} · ${`${m.clientFirstName} ${m.clientLastName}`.trim() || 'Unnamed'}`;

async function analyzeCached(a: AnalysisInputs): Promise<SettlementSummary | null> {
  const tasks = a.tasks.filter((t) => !t.isCompleted);
  const cacheKey = [
    a.matter.updatedAt,
    a.now.toISODate(),
    config.noteReader ? 'm' : '-',
    ...a.memos.map((m) => `${m.id}:${m.updatedAt}`),
    ...a.files.map((f) => `${f.id}:${f.dateModified}`),
    ...tasks.map((t) => `${t.id}:${t.updatedAt}`),
    ...a.events.map((e) => `${e.id}:${e.updatedAt}`),
    a.folders.length,
  ].join('|');
  const hit = analysisCache.get(a.matter.id);
  if (hit && hit.key === cacheKey) return hit.summary;
  const summary = await analyzeMatterUncached({ ...a, tasks });
  analysisCache.set(a.matter.id, { key: cacheKey, summary });
  return summary;
}

export async function analyzeMatter(
  db: Db,
  client: SmokeballClient,
  matterId: string,
  nowIso?: string,
): Promise<SettlementSummary | null> {
  const matter = (await db.select().from(schema.matters).where(eq(schema.matters.id, matterId)))[0];
  if (!matter) return null;
  return analyzeCached({
    db,
    client,
    matter,
    now: nowIso ? DateTime.fromISO(nowIso) : DateTime.now(),
    events: await db.select().from(schema.events).where(eq(schema.events.matterId, matterId)),
    memos: await db.select().from(schema.memos).where(eq(schema.memos.matterId, matterId)),
    folders: await db.select().from(schema.folders).where(eq(schema.folders.matterId, matterId)),
    files: await db.select().from(schema.files).where(eq(schema.files.matterId, matterId)),
    tasks: await db.select().from(schema.tasks).where(eq(schema.tasks.matterId, matterId)),
    staff: await db.select().from(schema.staff),
  });
}

/** Free-form notes → verified facts, via the model fallback. Runs only when
 *  the labelled parse found neither a demand nor an offer and the notes
 *  plainly talk settlement money. The outcome (including "nothing") is kept
 *  per note-version so the model is asked once. */
async function readNotesWithModel(
  db: Db,
  matterId: string,
  memos: Row<'memos'>[],
  facts: SettlementFacts,
): Promise<void> {
  if (!config.noteReader || facts.demand || facts.offer) return;
  const relevant = memos.filter((m) => NOTE_SIGNAL_RE.test(m.text));
  if (!relevant.some((m) => MONEY_RE.test(m.text))) return;
  const notes: NoteInput[] = relevant
    .slice(-12) // newest dozen (memos arrive oldest-edit first)
    .map((m) => ({ id: m.id, date: m.updatedAt, text: m.text.slice(0, 4000) }));
  const key = `notes:${matterId}:${notes.map((n) => `${n.id}@${n.date}`).join(',')}`.slice(0, 2000);
  type Kept = { facts: Record<string, string>; sourceMemoIds: string[] };
  let kept = await getDerived<Kept>(db, key);
  if (!kept) {
    let raw;
    try {
      raw = await config.noteReader(notes);
    } catch (e) {
      console.error('[pam] note reader failed (labelled notes still work):', e instanceof Error ? e.message.slice(0, 160) : e);
      return; // not persisted — retried on the next analysis
    }
    const g = raw ? guardModelFacts(raw, notes, normalizeMemoDate) : { facts: {}, sourceMemoIds: [], rejected: [] };
    if (g.rejected.length) console.log(`[pam] note reader: ${g.rejected.length} value(s) not found in the notes were discarded`);
    kept = { facts: g.facts as Record<string, string>, sourceMemoIds: g.sourceMemoIds };
    await putDerived(db, key, kept);
  }
  const interpreted: string[] = [];
  const target = facts as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(kept.facts)) {
    if (target[k] === undefined && typeof v === 'string' && v) {
      target[k] = v;
      interpreted.push(k);
    }
  }
  // Without a demand or an offer there is no settlement posture to report.
  if (!kept.facts['demand'] && !kept.facts['offer']) {
    for (const k of interpreted) delete target[k];
    return;
  }
  if (interpreted.length) {
    facts.interpreted = interpreted;
    for (const id of kept.sourceMemoIds) if (!facts.sourceMemoIds.includes(id)) facts.sourceMemoIds.push(id);
  }
}

async function analyzeMatterUncached(a: AnalysisInputs): Promise<SettlementSummary | null> {
  const { db, client, matter, now, events, folders, files, tasks } = a;
  const matterId = matter.id;
  const label = labelOf(matter);
  const staffName = (id: string) => {
    const s = a.staff.find((s) => s.id === id);
    return s ? `${s.firstName} ${s.lastName}`.trim() : id;
  };
  const memos = [...a.memos].sort((x, y) => x.updatedAt.localeCompare(y.updatedAt));
  const firmDomains = [
    ...new Set([
      ...config.firmDomains,
      ...a.staff.map((s) => s.email.split('@')[1]?.toLowerCase() ?? '').filter((d) => d && !PUBLIC_MAIL.has(d)),
    ]),
  ];

  const timeline: TimelineEntry[] = [];
  const citations: Citation[] = [];

  // 1. Facts from notes — Jeff's source of truth.
  const facts = parseMemoFacts(memos.map((m) => ({ id: m.id, text: m.text })), now);
  await readNotesWithModel(db, matterId, memos, facts);
  for (const id of facts.sourceMemoIds) {
    const memo = memos.find((m) => m.id === id);
    if (memo) citations.push(cite('memo', id, `${label} — Note by ${staffName(memo.updatedById)}`));
  }

  // 2. Package prepared? (standard Settlement Package folder)
  const pkgFolder = folders.find((f) => PACKAGE_RE.test(f.name));
  const isEmail = (f: Row<'files'>) => f.emailFrom !== null || /\.(msg|eml)$/i.test(f.name);
  const pkgDocs = files.filter((f) => (pkgFolder && f.folderId === pkgFolder.id) || (PACKAGE_RE.test(f.name) && !isEmail(f)));
  const pkgDoc = pkgDocs.sort((x, y) => x.dateCreated.localeCompare(y.dateCreated))[0];
  if (pkgDoc) {
    timeline.push({
      date: pkgDoc.dateCreated,
      label: `Settlement package prepared (${pkgDoc.name})`,
      evidence: cite('file', pkgDoc.id, `${label} — ${pkgDoc.name}`),
    });
    citations.push(cite('file', pkgDoc.id, `${label} — ${pkgDoc.name}`));
  }

  // 3. Sent verification — email evidence ONLY. Bodies are read only for
  // emails whose name suggests settlement traffic (rate-limited calls); the
  // rest are judged on name + metadata.
  let sentDate: string | undefined;
  let sentTo: string | undefined;
  let acknowledged = false;
  let downloads = 0;
  for (const email of files.filter(isEmail).sort((x, y) => x.dateCreated.localeCompare(y.dateCreated))) {
    const from = (email.emailFrom ?? '').toLowerCase();
    const fromFirm = from !== '' && firmDomains.some((d) => from.includes(d));
    let sig: FileSignals | null = null;
    if (EMAIL_WORTH_DOWNLOADING.test(email.name) && downloads < MAX_EMAIL_DOWNLOADS_PER_MATTER) {
      downloads++;
      sig = await fileSignals(db, client, email);
    }
    const mentionsPackage = PACKAGE_RE.test(email.name) || Boolean(sig?.pkg);
    if (fromFirm && !sentDate && mentionsPackage && sig?.sent) {
      sentDate = email.dateCreated;
      sentTo = email.emailTo ?? undefined;
      timeline.push({
        date: email.dateCreated,
        label: `Package emailed to ${sentTo ?? 'recipient'}${sig.link ? ' (file link)' : ' (attached)'}`,
        evidence: cite('file', email.id, `${label} — Email: ${email.name}`),
      });
      citations.push(cite('file', email.id, `${label} — Email: ${email.name}`));
    } else if (from !== '' && !fromFirm && sentDate && mentionsPackage) {
      acknowledged = true;
      timeline.push({
        date: email.dateCreated,
        label: `Adjuster replied (${email.emailFrom})`,
        evidence: cite('file', email.id, `${label} — Email: ${email.name}`),
      });
      citations.push(cite('file', email.id, `${label} — Email: ${email.name}`));
    }
  }

  // 4. Liens — standard folder + "lien" keyword; amounts from content when
  // the file is readable text (scanned letters are listed without one).
  const lienFolder = folders.find((f) => /^liens?$/i.test(f.name));
  const lienFiles = files.filter((f) => (lienFolder && f.folderId === lienFolder.id) || /\blien/i.test(f.name));
  for (const [i, lf] of lienFiles.entries()) {
    const sig = i < MAX_LIEN_DOWNLOADS_PER_MATTER ? await fileSignals(db, client, lf) : null;
    const amount = sig?.lienAmount;
    if (amount) facts.lienTotal = `$${amount}`;
    timeline.push({
      date: lf.dateCreated,
      label: `Lien on file: ${lf.name}${amount ? ` ($${amount})` : ''}`,
      evidence: cite('file', lf.id, `${label} — ${lf.name}`),
    });
    citations.push(cite('file', lf.id, `${label} — ${lf.name}`));
  }

  // 5. Injuries — bill of particulars (Pleadings).
  const bop = files.find((f) => /bill of particulars/i.test(f.name));
  if (bop) {
    const sig = await fileSignals(db, client, bop);
    if (sig?.injuries) {
      facts.injuries = sig.injuries;
      citations.push(cite('file', bop.id, `${label} — ${bop.name}`));
    }
  }

  // 6. Offer/negotiation entries from notes.
  if (facts.offer && facts.offerDate) {
    const src = facts.sourceMemoIds[facts.sourceMemoIds.length - 1];
    timeline.push({
      date: facts.offerDate,
      label: `Offer ${facts.offer}${facts.offerBy ? ` from ${facts.offerBy}` : ''} (demand ${facts.demand ?? 'n/a'})`,
      evidence: cite('memo', src ?? 'unknown', `${label} — Note`),
    });
  }

  // 7. Follow-up task state.
  const followTask = tasks.find((t) => /adjuster|settlement|call.*back|follow.?up/i.test(t.subject));
  let followUp: SettlementSummary['followUp'];
  if (followTask) {
    const state = classifyTask({ dueDate: followTask.dueDate ?? undefined, isCompleted: false }, now);
    followUp = {
      taskId: followTask.id,
      subject: followTask.subject,
      ...(followTask.dueDate ? { dueDate: followTask.dueDate } : {}),
      state,
    };
    citations.push(cite('task', followTask.id, `${label} — Task: ${followTask.subject}`));
    if (followTask.dueDate) {
      timeline.push({
        date: followTask.dueDate,
        label: `Follow-up task ${state === 'overdue' ? 'OVERDUE' : 'due'}: ${followTask.subject}`,
        evidence: cite('task', followTask.id, `${label} — Task`),
      });
    }
  }

  // 8. Who negotiated last (memo authorship on settlement facts).
  const factMemos = memos.filter((m) => facts.sourceMemoIds.includes(m.id));
  const lastMemo = factMemos.at(-1);

  // Status derivation — never claim "sent" without email evidence.
  let status: SettlementStatus;
  let statusReason: string;
  const past = events.filter((e) => DateTime.fromISO(e.startTime) < now);
  const readyInSuit =
    matter.isInSuit === true &&
    past.some((e) => /deposition/i.test(e.subject)) &&
    past.some((e) => /\bIME\b/i.test(e.subject));
  if (facts.offer) {
    status = 'in_negotiation';
    statusReason = `Offer ${facts.offer} on the table${facts.demand ? ` against demand ${facts.demand}` : ''}.`;
  } else if (sentDate && acknowledged) {
    status = 'sent_acknowledged';
    statusReason = `Package sent ${sentDate.slice(0, 10)} and acknowledged by the adjuster.`;
  } else if (sentDate) {
    status = 'sent_verified';
    statusReason = `Package sent ${sentDate.slice(0, 10)} — no adjuster response on file.`;
  } else if (readyInSuit) {
    // Jeff's second readiness path (docs/08 §11): in suit + depositions and IME done.
    status = 'ready_in_suit';
    statusReason = 'In suit; depositions and IME complete — ready to open negotiations.';
    for (const e of past.filter((e) => /deposition|\bIME\b/i.test(e.subject))) {
      citations.push(cite('event', e.id, `${label} — ${e.subject}`));
    }
  } else if (pkgDoc) {
    status = 'prepared_unverified';
    statusReason = `Package prepared ${pkgDoc.dateCreated.slice(0, 10)}, but sending could not be verified from emails — it may have gone by mail.`;
  } else if (facts.demand) {
    status = 'demand_made';
    statusReason = `Demand ${facts.demand} noted — no offer on file yet.`;
  } else {
    status = 'no_package';
    statusReason = matter.isInSuit ? 'In suit; discovery still under way.' : 'No settlement package found in this matter.';
  }

  timeline.sort((x, y) => x.date.localeCompare(y.date));

  return {
    matterId,
    matterLabel: label,
    status,
    statusReason,
    facts,
    ...(pkgDoc ? { packagePreparedDate: pkgDoc.dateCreated } : {}),
    ...(sentDate ? { packageSentDate: sentDate } : {}),
    ...(sentTo ? { packageSentTo: sentTo } : {}),
    ...(followUp ? { followUp } : {}),
    ...(lastMemo ? { lastNegotiationAt: lastMemo.updatedAt, lastNegotiationBy: staffName(lastMemo.updatedById) } : {}),
    timeline,
    citations,
  };
}

// -------------------------------------------------------------------- board

const rank = (rows: SettlementSummary[]): SettlementSummary[] =>
  [...rows].sort((a, b) =>
    (b.lastNegotiationAt ?? b.packageSentDate ?? b.packagePreparedDate ?? '').localeCompare(
      a.lastNegotiationAt ?? a.packageSentDate ?? a.packagePreparedDate ?? '',
    ),
  );

const groupBy = <T extends { matterId: string | null }>(rows: T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.matterId) continue;
    const list = m.get(r.matterId);
    if (list) list.push(r);
    else m.set(r.matterId, [r]);
  }
  return m;
};

interface BoardRun {
  promise: Promise<SettlementSummary[]>;
  partial: SettlementSummary[];
  done: number;
  total: number;
}
let boardRun: BoardRun | null = null;
const lastBoards = new WeakMap<object, { key: string; summaries: SettlementSummary[] }>();

function startBoard(db: Db, client: SmokeballClient, nowIso?: string): BoardRun {
  const run: BoardRun = { promise: Promise.resolve([]), partial: [], done: 0, total: 0 };
  run.promise = (async () => {
    const now = nowIso ? DateTime.fromISO(nowIso) : DateTime.now();
    // Find the candidates from light reads, then analyze them in chunks —
    // a firm's file table runs to hundreds of thousands of rows (every
    // email), and must never be held in memory whole.
    const open = (await db.select().from(schema.matters)).filter((m) => m.status === 'Open');
    const typeIds = [...new Set(open.map((m) => m.matterTypeId).filter(Boolean))];
    const types = new Map<string, Row<'matterTypes'>>();
    for (let i = 0; i < typeIds.length; i += 500) {
      for (const t of await db.select().from(schema.matterTypes).where(inArray(schema.matterTypes.id, typeIds.slice(i, i + 500)))) types.set(t.id, t);
    }
    const memos = groupBy(await db.select().from(schema.memos));
    const folders = groupBy(await db.select().from(schema.folders));
    const pkgFiles = groupBy(
      await db
        .select({ matterId: schema.files.matterId, name: schema.files.name })
        .from(schema.files)
        .where(sql`${schema.files.name} ~* ${PACKAGE_RE.source}`),
    );
    const staff = await db.select().from(schema.staff);
    const candidates = open.filter((m) => {
      const t = types.get(m.matterTypeId);
      return isSettlementCandidate({
        typeName: t?.name ?? '',
        typeCategory: t?.category ?? '',
        noteTexts: (memos.get(m.id) ?? []).map((x) => x.text),
        folderNames: (folders.get(m.id) ?? []).map((x) => x.name),
        fileNames: (pkgFiles.get(m.id) ?? []).map((x) => x.name),
      });
    });
    run.total = candidates.length;
    const CHUNK = 40;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK);
      const ids = chunk.map((m) => m.id);
      const files = groupBy(await db.select().from(schema.files).where(inArray(schema.files.matterId, ids)));
      const tasks = groupBy(await db.select().from(schema.tasks).where(inArray(schema.tasks.matterId, ids)));
      const events = groupBy(await db.select().from(schema.events).where(inArray(schema.events.matterId, ids)));
      for (const m of chunk) {
        try {
          const s = await analyzeCached({
            db,
            client,
            matter: m,
            now,
            events: events.get(m.id) ?? [],
            memos: memos.get(m.id) ?? [],
            folders: folders.get(m.id) ?? [],
            files: files.get(m.id) ?? [],
            tasks: tasks.get(m.id) ?? [],
            staff,
          });
          if (s && s.status !== 'no_package') run.partial.push(s);
        } catch (e) {
          // One unreadable matter must not blank the board.
          console.error(`[pam] settlement analysis failed for one matter:`, e instanceof Error ? e.message.slice(0, 160) : e);
        }
        run.done++;
      }
    }
    return rank(run.partial);
  })().finally(() => {
    if (boardRun === run) boardRun = null;
  });
  // A caller that stopped waiting must not turn a late failure into an
  // unhandled rejection.
  run.promise.catch(() => undefined);
  return run;
}

export interface BoardResult {
  summaries: SettlementSummary[];
  /** True when the board is still being worked out (first read after a
   *  restart on a large firm) — `summaries` holds what is ready so far. */
  warming: boolean;
  done: number;
  total: number;
}

/**
 * The board, without ever hanging the caller: if the analysis is not done
 * within `maxWaitMs`, return what is ready and say so. Concurrent callers
 * share one run.
 */
export async function getSettlementBoard(
  db: Db,
  client: SmokeballClient,
  nowIso?: string,
  maxWaitMs = Number.POSITIVE_INFINITY,
): Promise<BoardResult> {
  // Nothing moved since the last complete board (same mirror, same day)?
  // Then it is still the board.
  const key = `${mirrorVersion()}:${(nowIso ? DateTime.fromISO(nowIso) : DateTime.now()).toISODate()}:${config.noteReader ? 'm' : '-'}`;
  const last = lastBoards.get(db);
  if (last && last.key === key) return { summaries: last.summaries, warming: false, done: last.summaries.length, total: last.summaries.length };
  const run = (boardRun ??= startBoard(db, client, nowIso));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Number.isFinite(maxWaitMs)
    ? new Promise<null>((r) => {
        timer = setTimeout(() => r(null), maxWaitMs);
      })
    : null;
  try {
    const result = await (timeout ? Promise.race([run.promise, timeout]) : run.promise);
    if (result) {
      lastBoards.set(db, { key, summaries: result });
      return { summaries: result, warming: false, done: run.total, total: run.total };
    }
    return { summaries: rank(run.partial), warming: true, done: run.done, total: run.total };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Every open matter with settlement activity; ranked most-recent first. */
export async function buildSettlementBoard(
  db: Db,
  client: SmokeballClient,
  nowIso?: string,
): Promise<SettlementSummary[]> {
  return (await getSettlementBoard(db, client, nowIso)).summaries;
}
