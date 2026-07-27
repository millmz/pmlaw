import { DateTime } from 'luxon';
import { FIRM_TZ } from './dates.js';
import type {
  CalendarEvent,
  FileRecord,
  FirmDataset,
  Folder,
  Matter,
  Memo,
  Staff,
  Task,
} from './types.js';

/**
 * The golden dataset (docs/04): a fully known fictional firm covering every
 * tricky case, generated relative to an anchor "today" so overdue stays
 * overdue no matter when tests run. All client, adjuster, and insurer names
 * are fictional; staff names are the real roster from docs/08 §7.
 *
 * Cases covered (docs/04 "Golden data"):
 *  - PI sent as email attachment ............. Grasso
 *  - PI sent as Dropbox link, no attachment .. Fontana
 *  - PI mailed only, no email evidence ....... Ricci
 *  - PI prepared but NOT sent (trap) ......... Bailey
 *  - PI with a lien .......................... Okafor
 *  - PI in suit, depos + IME done ............ Tran
 *  - Memo-parsing (insurer/demand/offer) ..... Grasso
 *  - Settlement notes by another staffer ..... Hughes (Isabel)
 *  - Statute reminders 6/3/1 ................. Petrov
 *  - Stalled (no future task/event) .......... Whitfield
 *  - Common first name ambiguity ............. Juan Delgado / Juan Santos
 *  - Closed matter ........................... Marino
 *  - Criminal with court next month .......... Vasquez
 *  - Conflicting policy limits ............... Keller
 *  - Next-week Mon–Fri court dates ........... Grasso/Vasquez/Tran events
 */

export const GOLDEN_ANCHOR_ISO = '2026-07-27T08:00:00';

export function buildGoldenDataset(anchorIso: string = GOLDEN_ANCHOR_ISO): FirmDataset {
  const anchor = DateTime.fromISO(anchorIso, { zone: FIRM_TZ });
  if (!anchor.isValid) throw new Error(`invalid anchor: ${anchorIso}`);

  /** ISO date offset by whole days from anchor. */
  const day = (offset: number) => anchor.plus({ days: offset }).toISODate()!;
  /** ISO datetime at hour:minute offset by whole days from anchor. */
  const ts = (offset: number, hour: number, minute = 0) =>
    anchor.plus({ days: offset }).set({ hour, minute, second: 0, millisecond: 0 }).toISO()!;
  /** Next Monday relative to anchor, plus extra days. */
  const nextMonday = anchor.startOf('week').plus({ weeks: 1 });
  const nextWk = (dow: number, hour: number, minute = 0) =>
    nextMonday.plus({ days: dow }).set({ hour, minute, second: 0, millisecond: 0 }).toISO()!;

  const staff: Staff[] = [
    { id: 's-jeff', firstName: 'Jeff', lastName: 'Millman', initials: 'JTM', email: 'jmillman@pmlawny.com', role: 'attorney', updatedAt: ts(-90, 9) },
    { id: 's-frank', firstName: 'Frank', lastName: 'Phillips', initials: 'FJP', email: 'fphillips@pmlawny.com', role: 'attorney', updatedAt: ts(-90, 9) },
    { id: 's-anthony', firstName: 'Anthony', lastName: 'Burgandy', initials: 'AJB', email: 'aburgandy@pmlawny.com', role: 'attorney', updatedAt: ts(-90, 9) },
    { id: 's-isabel', firstName: 'Isabel', lastName: 'Topel', initials: 'IT', email: 'itopel@pmlawny.com', role: 'paralegal', updatedAt: ts(-90, 9) },
    { id: 's-michelle', firstName: 'Michelle', lastName: 'Treyback', initials: 'MT', email: 'mtreyback@pmlawny.com', role: 'paralegal', updatedAt: ts(-90, 9) },
    { id: 's-frontdesk', firstName: 'Front', lastName: 'Desk', initials: 'FD', email: 'office@pmlawny.com', role: 'frontdesk', updatedAt: ts(-90, 9) },
  ];

  const matterTypes = [
    { id: 'mt-pi-ny', name: 'Personal Injury | Plaintiff', category: 'Personal Injury', location: 'NY' as const },
    { id: 'mt-pi-nj', name: 'Personal Injury | Plaintiff', category: 'Personal Injury', location: 'NJ' as const },
    { id: 'mt-mm-ny', name: 'Medical Malpractice | Plaintiff', category: 'Medical Malpractice', location: 'NY' as const },
    { id: 'mt-cr-ny', name: 'Criminal Defense', category: 'Criminal', location: 'NY' as const },
  ];

  const mkMatter = (
    id: string,
    number: string,
    matterTypeId: string,
    first: string,
    last: string,
    opts: Partial<Matter> = {},
  ): Matter => ({
    id,
    number,
    status: 'Open',
    matterTypeId,
    clientFirstName: first,
    clientLastName: last,
    description: `${first} ${last}`,
    createdAt: ts(-300, 10),
    updatedAt: ts(-1, 16),
    ...opts,
  });

  const matters: Matter[] = [
    mkMatter('m-grasso', '24-1101', 'mt-pi-ny', 'Peter', 'Grasso', { dateOfLoss: day(-420), statuteDate: day(675) }),
    mkMatter('m-fontana', '24-1188', 'mt-pi-ny', 'Maria', 'Fontana', { dateOfLoss: day(-380), statuteDate: day(715) }),
    mkMatter('m-ricci', '23-0977', 'mt-pi-ny', 'Dominic', 'Ricci', { dateOfLoss: day(-520), statuteDate: day(575) }),
    mkMatter('m-bailey', '25-0142', 'mt-pi-ny', 'Susan', 'Bailey', { dateOfLoss: day(-200), statuteDate: day(895) }),
    mkMatter('m-okafor', '24-1240', 'mt-pi-ny', 'Daniel', 'Okafor', { dateOfLoss: day(-400), statuteDate: day(695) }),
    mkMatter('m-tran', '23-0611', 'mt-pi-ny', 'Lily', 'Tran', { dateOfLoss: day(-700), statuteDate: day(395), isInSuit: true }),
    mkMatter('m-delgado', '25-0301', 'mt-pi-ny', 'Juan', 'Delgado', { dateOfLoss: day(-120), statuteDate: day(975) }),
    mkMatter('m-santos', '25-0322', 'mt-cr-ny', 'Juan', 'Santos'),
    mkMatter('m-whitfield', '24-0850', 'mt-pi-ny', 'George', 'Whitfield', {
      dateOfLoss: day(-500),
      statuteDate: day(595),
      updatedAt: ts(-45, 11),
    }),
    mkMatter('m-marino', '22-0455', 'mt-pi-ny', 'Carla', 'Marino', { status: 'Closed', updatedAt: ts(-60, 15) }),
    mkMatter('m-vasquez', '25-0287', 'mt-cr-ny', 'Hector', 'Vasquez'),
    mkMatter('m-keller', '23-0730', 'mt-mm-ny', 'Ruth', 'Keller', { dateOfLoss: day(-600), statuteDate: day(310) }),
    mkMatter('m-petrov', '24-0999', 'mt-pi-ny', 'Anna', 'Petrov', { dateOfLoss: day(-945), statuteDate: day(150) }),
    mkMatter('m-hughes', '24-1310', 'mt-pi-ny', 'Marcus', 'Hughes', { dateOfLoss: day(-350), statuteDate: day(745) }),
  ];

  // ---------------------------------------------------------------- folders
  const folders: Folder[] = [];
  const files: FileRecord[] = [];
  let folderSeq = 0;
  let fileSeq = 0;

  const STANDARD_FOLDERS = ['Correspondence', 'Pleadings', 'Medicals', 'Settlement Package', 'Liens', 'Emails'];
  const folderIds = new Map<string, string>(); // `${matterId}:${name}` -> id

  for (const m of matters) {
    if (m.matterTypeId === 'mt-cr-ny') continue; // criminal matters get minimal folders
    for (const name of STANDARD_FOLDERS) {
      const id = `f-${++folderSeq}`;
      folders.push({ id, matterId: m.id, name, updatedAt: m.createdAt });
      folderIds.set(`${m.id}:${name}`, id);
    }
  }

  const addFile = (
    matterId: string,
    folderName: string,
    name: string,
    createdOffset: number,
    opts: Partial<FileRecord> = {},
  ): FileRecord => {
    const rec: FileRecord = {
      id: `file-${++fileSeq}`,
      matterId,
      name,
      sizeBytes: 250_000,
      dateCreated: ts(createdOffset, 14),
      dateModified: ts(createdOffset, 14),
      ...opts,
    };
    const fid = folderIds.get(`${matterId}:${folderName}`);
    if (fid !== undefined) rec.folderId = fid;
    files.push(rec);
    return rec;
  };

  // Grasso — package prepared and sent BY EMAIL ATTACHMENT; adjuster acknowledged.
  addFile('m-grasso', 'Settlement Package', 'Settlement Package - Grasso.pdf', -82, { sizeBytes: 4_800_000 });
  addFile('m-grasso', 'Emails', 'Settlement Package - Grasso, Peter.msg', -81, {
    from: 'jmillman@pmlawny.com',
    to: 'k.boland@apexmutual-ins.example',
    content:
      'Kevin — attached please find our settlement package in the Grasso matter. ' +
      'Please confirm receipt. Attachment: Settlement Package - Grasso.pdf',
  });
  addFile('m-grasso', 'Emails', 'RE Settlement Package - Grasso, Peter.msg', -78, {
    from: 'k.boland@apexmutual-ins.example',
    to: 'jmillman@pmlawny.com',
    content: 'Received, thank you. I will begin my review and revert.',
  });

  // Fontana — sent as a DROPBOX LINK, no attachment (medicals too large to email).
  addFile('m-fontana', 'Settlement Package', 'Settlement Package - Fontana.pdf', -30, { sizeBytes: 48_000_000 });
  addFile('m-fontana', 'Emails', 'Fontana settlement package link.msg', -28, {
    from: 'itopel@pmlawny.com',
    to: 'claims@granitestate-ins.example',
    content:
      'Please find the settlement package for Maria Fontana at the following link: ' +
      'https://www.dropbox.com/s/example-fontana/Settlement%20Package%20-%20Fontana.pdf?dl=0 ' +
      'The medical records were too large to attach. Please confirm receipt.',
  });

  // Ricci — MAILED ONLY: package exists, no email evidence at all.
  addFile('m-ricci', 'Settlement Package', 'Settlement Package - Ricci.pdf', -45, { sizeBytes: 6_100_000 });

  // Bailey — THE TRAP: prepared, never sent, no email, no follow-up task.
  addFile('m-bailey', 'Settlement Package', 'Settlement Package - Bailey DRAFT.pdf', -14, { sizeBytes: 3_200_000 });

  // Okafor — lien case.
  addFile('m-okafor', 'Settlement Package', 'Settlement Package - Okafor.pdf', -60, { sizeBytes: 5_500_000 });
  addFile('m-okafor', 'Liens', 'NYSIF lien - Okafor.pdf', -55, {
    content: 'New York State Insurance Fund lien in the amount of $97,000.00.',
  });
  addFile('m-okafor', 'Emails', 'Okafor settlement package.msg', -58, {
    from: 'jmillman@pmlawny.com',
    to: 'adj.rivera@tristate-ins.example',
    content: 'Attached is our settlement package for Daniel Okafor. Attachment: Settlement Package - Okafor.pdf',
  });

  // Tran — in suit; bill of particulars carries the injuries.
  addFile('m-tran', 'Pleadings', 'Bill of Particulars - Tran.pdf', -300, {
    content:
      'Injuries: comminuted fracture of the right distal radius requiring ORIF; ' +
      'disc herniation C5-C6; post-traumatic headaches.',
  });

  // Keller — conflicting policy limits: memo says $100k, email says $250k.
  addFile('m-keller', 'Emails', 'RE Keller coverage.msg', -20, {
    from: 'defense@mercercoverage.example',
    to: 'jmillman@pmlawny.com',
    content: 'Confirming the applicable policy limit in this matter is $250,000.',
  });

  // ------------------------------------------------------------------ memos
  const memos: Memo[] = [
    {
      id: 'memo-grasso-1',
      matterId: 'm-grasso',
      text:
        'Insurance: Apex Mutual. Claim No. AM-2024-88213. Policy limits: $300,000. ' +
        'Adjuster: Kevin Boland, k.boland@apexmutual-ins.example, (555) 201-4433. ' +
        `Demand: $250,000 (sent with package). Offer: $110,000 made ${day(-12)} by Kevin Boland. ` +
        'Spoke to Boland — he needs updated authorizations before improving the number.',
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: ts(-80, 15),
      updatedAt: ts(-12, 16),
    },
    {
      id: 'memo-okafor-1',
      matterId: 'm-okafor',
      text:
        'Insurance: Tri-State Indemnity. Claim No. TS-77120. Policy limits: $500,000. ' +
        'Adjuster: Marisol Rivera, adj.rivera@tristate-ins.example, (555) 887-2210. ' +
        'Demand: $250,000. NYSIF lien $97,000 — settlement floor ~$350,000 accounting for lien.',
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: ts(-58, 15),
      updatedAt: ts(-58, 15),
    },
    {
      id: 'memo-tran-1',
      matterId: 'm-tran',
      text:
        'In suit. Defense counsel: R. Calloway, Calloway & Reed LLP, (555) 640-9911. ' +
        'Depositions complete; IME completed. Carrier: Northline Casualty, limits $1,000,000. ' +
        'No demand conveyed since depositions — ready to open negotiations.',
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: ts(-25, 15),
      updatedAt: ts(-25, 15),
    },
    {
      id: 'memo-keller-1',
      matterId: 'm-keller',
      text:
        'Carrier: Mercer Coverage Group. Policy limits: $100,000 per adjuster call. ' +
        'Adjuster: T. Osei, (555) 310-7788.',
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: ts(-90, 15),
      updatedAt: ts(-90, 15),
    },
    {
      // "Who's negotiating" case — Isabel's memo is the latest settlement touch.
      id: 'memo-hughes-1',
      matterId: 'm-hughes',
      text:
        'Insurance: Beacon National. Claim No. BN-55018. Policy limits: $250,000. ' +
        'Adjuster: Dana Whitcomb, (555) 452-8801. Demand: $175,000. ' +
        `Offer: $85,000 made ${day(-5)} by Dana Whitcomb — relayed to JTM for response.`,
      createdById: 's-isabel',
      updatedById: 's-isabel',
      createdAt: ts(-40, 15),
      updatedAt: ts(-5, 12),
    },
  ];

  // ------------------------------------------------------------------ tasks
  let taskSeq = 0;
  const mkTask = (
    subject: string,
    opts: Partial<Task> & { assigneeIds: string[] },
  ): Task => ({
    id: `task-${++taskSeq}`,
    subject,
    isCompleted: false,
    createdById: 's-jeff',
    createdAt: ts(-30, 9),
    updatedAt: ts(-1, 9),
    ...opts,
  });

  const tasks: Task[] = [
    // Overdue, real (needs a decision) — the Grasso follow-up, 22 days past due.
    mkTask('JTM - Call adjuster Kevin Boland re settlement package (555) 201-4433', {
      matterId: 'm-grasso',
      assigneeIds: ['s-jeff'],
      dueDate: day(-22),
    }),
    // Overdue, real — authorizations, assigned to Anthony + Jeff.
    mkTask('AJB - Obtain updated authorizations from client', {
      matterId: 'm-grasso',
      assigneeIds: ['s-anthony', 's-jeff'],
      dueDate: day(-9),
      createdById: 's-isabel',
    }),
    // Due today ×3 for Jeff.
    mkTask('JTM - Respond to Hughes offer of $85,000', {
      matterId: 'm-hughes',
      assigneeIds: ['s-jeff'],
      dueDate: day(0),
    }),
    mkTask('JTM - Review Fontana medicals before adjuster call', {
      matterId: 'm-fontana',
      assigneeIds: ['s-jeff'],
      dueDate: day(0),
    }),
    mkTask('JTM - Return call to client Daniel Okafor', {
      matterId: 'm-okafor',
      assigneeIds: ['s-jeff'],
      dueDate: day(0),
    }),
    // Upcoming — Fontana two-week follow-up.
    mkTask('JTM - Call Granite State re Fontana package receipt', {
      matterId: 'm-fontana',
      assigneeIds: ['s-jeff'],
      dueDate: day(3),
    }),
    // Statute reminders on Petrov (statute ~150 days out): the 6-month reminder
    // is past due and deliberately left alone; 3-month is upcoming.
    mkTask('Statute of Limitations - 6 Month Reminder - Petrov (statute ' + day(150) + ')', {
      matterId: 'm-petrov',
      assigneeIds: staff.map((s) => s.id), // office-wide, per docs/08 §3
      dueDate: day(-30),
      createdById: 's-michelle',
    }),
    mkTask('Statute of Limitations - 3 Month Reminder - Petrov (statute ' + day(150) + ')', {
      matterId: 'm-petrov',
      assigneeIds: staff.map((s) => s.id),
      dueDate: day(60),
      createdById: 's-michelle',
    }),
    mkTask('Statute of Limitations - 1 Month Reminder - Petrov (statute ' + day(150) + ')', {
      matterId: 'm-petrov',
      assigneeIds: staff.map((s) => s.id),
      dueDate: day(120),
      createdById: 's-michelle',
    }),
    // Completed task — must never appear in active views.
    mkTask('JTM - Serve discovery responses in Tran', {
      matterId: 'm-tran',
      assigneeIds: ['s-jeff'],
      dueDate: day(-7),
      isCompleted: true,
      completedAt: ts(-6, 17),
    }),
    // Front-desk task.
    mkTask('Front Desk - Mail Ricci settlement package (certified)', {
      matterId: 'm-ricci',
      assigneeIds: ['s-frontdesk'],
      dueDate: day(-45),
      isCompleted: true,
      completedAt: ts(-45, 16),
      createdById: 's-jeff',
    }),
    // NOTE: Bailey and Whitfield deliberately have NO open tasks (trap + stalled).
  ];

  // ------------------------------------------------------------------ events
  let eventSeq = 0;
  const mkEvent = (
    subject: string,
    startOffsetDaysOrIso: number | string,
    hour: number,
    durationMin: number,
    opts: Partial<CalendarEvent> = {},
  ): CalendarEvent => {
    const start =
      typeof startOffsetDaysOrIso === 'number'
        ? ts(startOffsetDaysOrIso, hour)
        : startOffsetDaysOrIso;
    const startDt = DateTime.fromISO(start, { zone: FIRM_TZ });
    return {
      id: `event-${++eventSeq}`,
      subject,
      startTime: start,
      endTime: startDt.plus({ minutes: durationMin }).toISO()!,
      timeZone: FIRM_TZ,
      allDay: false,
      attendeeIds: ['s-jeff'],
      onOfficeCalendar: true,
      createdAt: ts(-20, 9),
      updatedAt: ts(-2, 9),
      ...opts,
    };
  };

  const events: CalendarEvent[] = [
    // Today for Jeff: court, deposition, client call. Naming per docs/08 §9.
    mkEvent('JTM Hector Vasquez Town of Clarkstown Justice Court Judge George Kafinas', 0, 9, 45, {
      matterId: 'm-vasquez',
      location: 'Town of Clarkstown Justice Court',
    }),
    mkEvent('JTM Deposition - Tran v. Northline - defense counsel offices', ts(0, 11, 30), 0, 90, {
      matterId: 'm-tran',
      location: 'Calloway & Reed LLP, Nanuet',
    }),
    mkEvent('JTM Client call - Delgado intake follow-up', 0, 14, 30, { matterId: 'm-delgado' }),
    // Later this week.
    mkEvent('JTM Rockland County Court Judge Schwartz - Vasquez pretrial', 2, 9, 60, {
      matterId: 'm-vasquez',
      location: 'Rockland County Courthouse, New City',
    }),
    // Frank's event today (not Jeff's) — person-scoping case.
    mkEvent('FJP Rockland Supreme - Keller compliance conference', 0, 10, 60, {
      matterId: 'm-keller',
      attendeeIds: ['s-frank'],
      location: 'Rockland Supreme, New City',
    }),
    // Next week Mon–Fri court dates (the Wednesday list).
    mkEvent('JTM Vasquez suppression hearing Judge Kafinas', nextWk(0, 9), 9, 120, {
      matterId: 'm-vasquez',
      location: 'Town of Clarkstown Justice Court',
    }),
    mkEvent('JTM/FJP Tran v. Northline - settlement conference Judge Marrero', nextWk(2, 10), 10, 60, {
      matterId: 'm-tran',
      attendeeIds: ['s-jeff', 's-frank'],
      location: 'Rockland Supreme, New City',
    }),
    mkEvent('FJP Santos arraignment', nextWk(4, 9, 30), 9, 45, {
      matterId: 'm-santos',
      attendeeIds: ['s-frank'],
      location: 'Rockland County Courthouse',
    }),
    // Depos + IME already completed in Tran (settlement-ready path 2 evidence).
    mkEvent('JTM Deposition of defendant driver - Tran', -90, 10, 240, { matterId: 'm-tran' }),
    mkEvent('IME - Dr. Feldman - Tran', -40, 9, 60, { matterId: 'm-tran', attendeeIds: ['s-isabel'] }),
    // August court date for Vasquez (criminal court-in-August report case).
    mkEvent('JTM Vasquez trial date Judge Kafinas', 18, 9, 300, {
      matterId: 'm-vasquez',
      location: 'Town of Clarkstown Justice Court',
    }),
  ];

  return { staff, matterTypes, matters, tasks, events, folders, files, memos };
}
