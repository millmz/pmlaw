import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { classifyTask } from '../../core/dates.js';
import type { SmokeballClient } from '../../smokeball/client.js';
import { schema, type Db } from '../db/index.js';
import type { Citation } from '../tools/citations.js';
import { cite } from '../tools/citations.js';

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
 * ("Insurance:", "Demand:", "Offer: $X made DATE by NAME"); an LLM-assist
 * hook can be layered on later for fuzzier notes.
 */

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
}

export type SettlementStatus =
  | 'sent_verified'
  | 'sent_acknowledged'
  | 'prepared_unverified'
  | 'in_negotiation'
  | 'ready_in_suit'
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

export function parseMemoFacts(memoTexts: { id: string; text: string }[]): SettlementFacts {
  const facts: SettlementFacts = { sourceMemoIds: [] };
  for (const memo of memoTexts) {
    const t = memo.text;
    let used = false;
    const take = (key: keyof Omit<SettlementFacts, 'sourceMemoIds'>, re: RegExp) => {
      const v = grab(t, re);
      if (v !== undefined) {
        (facts as unknown as Record<string, unknown>)[key] = v;
        used = true;
      }
    };
    take('insurer', /(?:Insurance|Carrier):\s*([^.\n]+)/i);
    take('claimNumber', /Claim\s*(?:No\.?|Number)[:\s]*([A-Z0-9-]+)/i);
    take('policyLimits', /(?:Policy\s*)?limits?[:\s]*(\$[\d,]+(?:,\d{3})*)/i);
    take('adjusterName', /Adjuster:\s*([^,\n]+)/i);
    take('adjusterEmail', /Adjuster:[^\n]*?([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
    take('adjusterPhone', /Adjuster:[^\n]*?(\(\d{3}\)\s?\d{3}[-.]\d{4})/i);
    take('demand', /Demand:\s*(\$[\d,]+)/i);
    take('offer', /Offer:\s*(\$[\d,]+)/i);
    take('offerDate', /Offer:[^.\n]*?made\s+(\d{4}-\d{2}-\d{2})/i);
    take('offerBy', /Offer:[^.\n]*?by\s+([^—\-.\n]+)/i);
    take('defenseCounsel', /Defense counsel:\s*([^\n(]+)/i); // names contain periods ("R. Calloway"); stop at phone paren
    if (used) facts.sourceMemoIds.push(memo.id);
  }
  return facts;
}

/** Evidence that an email actually carried the package: attachment marker or a file-sharing link. */
const SENT_MARKERS = [/attachment:?\s*settlement package/i, /dropbox\.com/i, /wetransfer\.com/i, /sharefile/i];
const PACKAGE_RE = /settlement\s*package/i;
const LIEN_AMOUNT_RE = /\$\s?([\d,]+(?:\.\d{2})?)/;

export async function analyzeMatter(
  db: Db,
  client: SmokeballClient,
  matterId: string,
  nowIso?: string,
): Promise<SettlementSummary | null> {
  const matter = (await db.select().from(schema.matters).where(eq(schema.matters.id, matterId)))[0];
  if (!matter) return null;
  const label = `Matter ${matter.number} · ${matter.clientFirstName} ${matter.clientLastName}`;
  const now = nowIso ? DateTime.fromISO(nowIso) : DateTime.now();

  const events = await db.select().from(schema.events).where(eq(schema.events.matterId, matterId));
  const memos = await db.select().from(schema.memos).where(eq(schema.memos.matterId, matterId));
  const folders = await db.select().from(schema.folders).where(eq(schema.folders.matterId, matterId));
  const files = await db.select().from(schema.files).where(eq(schema.files.matterId, matterId));
  const tasks = (await db.select().from(schema.tasks).where(eq(schema.tasks.matterId, matterId))).filter(
    (t) => !t.isCompleted,
  );
  const staffRows = await db.select().from(schema.staff);
  const staffName = (id: string) => {
    const s = staffRows.find((s) => s.id === id);
    return s ? `${s.firstName} ${s.lastName}` : id;
  };

  const timeline: TimelineEntry[] = [];
  const citations: Citation[] = [];

  // 1. Facts from notes — Jeff's source of truth.
  const facts = parseMemoFacts(memos.map((m) => ({ id: m.id, text: m.text })));
  for (const id of facts.sourceMemoIds) {
    const memo = memos.find((m) => m.id === id)!;
    citations.push(cite('memo', id, `${label} — Note by ${staffName(memo.updatedById)}`));
  }

  // 2. Package prepared? (standard Settlement Package folder)
  const pkgFolder = folders.find((f) => PACKAGE_RE.test(f.name));
  const pkgDocs = files.filter(
    (f) => (pkgFolder && f.folderId === pkgFolder.id) || (PACKAGE_RE.test(f.name) && f.emailFrom === null),
  );
  const pkgDoc = pkgDocs.sort((a, b) => a.dateCreated.localeCompare(b.dateCreated))[0];
  if (pkgDoc) {
    timeline.push({
      date: pkgDoc.dateCreated,
      label: `Settlement package prepared (${pkgDoc.name})`,
      evidence: cite('file', pkgDoc.id, `${label} — ${pkgDoc.name}`),
    });
    citations.push(cite('file', pkgDoc.id, `${label} — ${pkgDoc.name}`));
  }

  // 3. Sent verification — email evidence ONLY, downloading candidate bodies.
  let sentDate: string | undefined;
  let sentTo: string | undefined;
  let acknowledged = false;
  const emailFiles = files.filter((f) => f.emailFrom !== null);
  for (const email of emailFiles.sort((a, b) => a.dateCreated.localeCompare(b.dateCreated))) {
    const fromFirm = (email.emailFrom ?? '').includes('pmlawny.com');
    let body = '';
    try {
      body = await client.downloadFile(matterId, email.id);
    } catch {
      // metadata-only is still usable
    }
    const mentionsPackage = PACKAGE_RE.test(email.name) || PACKAGE_RE.test(body);
    if (fromFirm && !sentDate && mentionsPackage && SENT_MARKERS.some((re) => re.test(body))) {
      sentDate = email.dateCreated;
      sentTo = email.emailTo ?? undefined;
      timeline.push({
        date: email.dateCreated,
        label: `Package emailed to ${sentTo ?? 'recipient'}${/dropbox|wetransfer|sharefile/i.test(body) ? ' (file link)' : ' (attached)'}`,
        evidence: cite('file', email.id, `${label} — Email: ${email.name}`),
      });
      citations.push(cite('file', email.id, `${label} — Email: ${email.name}`));
    } else if (!fromFirm && sentDate && mentionsPackage) {
      acknowledged = true;
      timeline.push({
        date: email.dateCreated,
        label: `Adjuster replied (${email.emailFrom})`,
        evidence: cite('file', email.id, `${label} — Email: ${email.name}`),
      });
      citations.push(cite('file', email.id, `${label} — Email: ${email.name}`));
    }
  }

  // 4. Liens — standard folder + "lien" keyword; amounts from content.
  const lienFolder = folders.find((f) => /^liens?$/i.test(f.name));
  const lienFiles = files.filter(
    (f) => (lienFolder && f.folderId === lienFolder.id) || /lien/i.test(f.name),
  );
  for (const lf of lienFiles) {
    let body = '';
    try {
      body = await client.downloadFile(matterId, lf.id);
    } catch {
      /* fine */
    }
    const amount = body.match(LIEN_AMOUNT_RE)?.[1];
    if (amount) facts.lienTotal = `$${amount}`;
    timeline.push({
      date: lf.dateCreated,
      label: `Lien on file: ${lf.name}${amount ? ` ($${amount})` : ''}`,
      evidence: cite('file', lf.id, `${label} — ${lf.name}`),
    });
    citations.push(cite('file', lf.id, `${label} — ${lf.name}`));
  }

  // 5. Injuries — bill of particulars (Pleadings) or the package itself.
  const bop = files.find((f) => /bill of particulars/i.test(f.name));
  if (bop) {
    try {
      const body = await client.downloadFile(matterId, bop.id);
      const inj = body.match(/Injuries:\s*([^\n]+)/i)?.[1];
      if (inj) {
        facts.injuries = inj.trim();
        citations.push(cite('file', bop.id, `${label} — ${bop.name}`));
      }
    } catch {
      /* fine */
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
  const lastMemo = factMemos.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);

  // Status derivation — never claim "sent" without email evidence.
  let status: SettlementStatus;
  let statusReason: string;
  if (facts.offer) {
    status = 'in_negotiation';
    statusReason = `Offer ${facts.offer} on the table${facts.demand ? ` against demand ${facts.demand}` : ''}.`;
  } else if (sentDate && acknowledged) {
    status = 'sent_acknowledged';
    statusReason = `Package sent ${sentDate.slice(0, 10)} and acknowledged by the adjuster.`;
  } else if (sentDate) {
    status = 'sent_verified';
    statusReason = `Package sent ${sentDate.slice(0, 10)} — no adjuster response on file.`;
  } else if (matter.isInSuit) {
    // Jeff's second readiness path (docs/08 §11): in suit + depositions and IME done.
    const past = events.filter((e) => DateTime.fromISO(e.startTime) < now);
    const depoDone = past.some((e) => /deposition/i.test(e.subject));
    const imeDone = past.some((e) => /\bIME\b/i.test(e.subject));
    if (depoDone && imeDone) {
      status = 'ready_in_suit';
      statusReason = 'In suit; depositions and IME complete — ready to open negotiations.';
      for (const e of past.filter((e) => /deposition|\bIME\b/i.test(e.subject))) {
        citations.push(cite('event', e.id, `${label} — ${e.subject}`));
      }
    } else {
      status = 'no_package';
      statusReason = 'In suit; discovery still under way.';
    }
  } else if (pkgDoc) {
    status = 'prepared_unverified';
    statusReason = `Package prepared ${pkgDoc.dateCreated.slice(0, 10)}, but sending could not be verified from emails — it may have gone by mail.`;
  } else {
    status = 'no_package';
    statusReason = 'No settlement package found in this matter.';
  }

  timeline.sort((a, b) => a.date.localeCompare(b.date));

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

/** Analyze every open PI/med-mal matter; ranked most-recent negotiation first. */
export async function buildSettlementBoard(
  db: Db,
  client: SmokeballClient,
  nowIso?: string,
): Promise<SettlementSummary[]> {
  const matters = await db.select().from(schema.matters);
  const types = await db.select().from(schema.matterTypes);
  const relevant = matters.filter((m) => {
    const t = types.find((t) => t.id === m.matterTypeId);
    return (
      m.status === 'Open' &&
      (t?.category === 'Personal Injury' || t?.category === 'Medical Malpractice')
    );
  });
  const summaries: SettlementSummary[] = [];
  for (const m of relevant) {
    const s = await analyzeMatter(db, client, m.id, nowIso);
    if (s && s.status !== 'no_package') summaries.push(s);
  }
  return summaries.sort((a, b) =>
    (b.lastNegotiationAt ?? b.packageSentDate ?? '').localeCompare(a.lastNegotiationAt ?? a.packageSentDate ?? ''),
  );
}
