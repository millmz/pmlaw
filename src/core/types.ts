/**
 * Domain types shared by the mock Smokeball server, the sync worker, and the
 * tool layer. Shapes are simplified from the vendored OpenAPI spec
 * (vendor/smokeball-openapi.json) but keep Smokeball's field names where the
 * spec has them, so swapping the mock for the real API stays mechanical.
 */

export interface Staff {
  id: string;
  firstName: string;
  lastName: string;
  /** Diary initials used in event/task titles, e.g. "JTM", "FJP". */
  initials: string;
  email: string;
  role: 'attorney' | 'paralegal' | 'frontdesk';
  updatedAt: string;
}

export interface MatterType {
  id: string;
  name: string;
  /** Practice area, e.g. "Personal Injury", "Criminal", "Medical Malpractice". */
  category: string;
  /** Jurisdiction the statute period derives from. */
  location: 'NY' | 'NJ';
}

export interface Matter {
  id: string;
  /** Firm numbering, e.g. "23-1234". */
  number: string;
  status: 'Open' | 'Closed';
  matterTypeId: string;
  clientFirstName: string;
  clientLastName: string;
  description: string;
  /** ISO date of accident/loss, when applicable. */
  dateOfLoss?: string;
  /** ISO date the statute of limitations runs, when applicable. */
  statuteDate?: string;
  isInSuit?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  matterId?: string;
  subject: string;
  note?: string;
  assigneeIds: string[];
  /** ISO calendar date (no time) — Smokeball's dueDateOnly. */
  dueDate?: string;
  isCompleted: boolean;
  completedAt?: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  id: string;
  matterId?: string;
  subject: string;
  /** ISO datetime with offset. */
  startTime: string;
  endTime: string;
  timeZone: string;
  allDay: boolean;
  /** Staff attendee ids. Office calendar = events attended by anyone + flagged office. */
  attendeeIds: string[];
  /** True when the event was also placed on the shared Office calendar. */
  onOfficeCalendar: boolean;
  location?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: string;
  matterId: string;
  parentId?: string;
  name: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  matterId: string;
  folderId?: string;
  name: string;
  sizeBytes: number;
  /** Email files only. */
  from?: string;
  /** Email files only. */
  to?: string;
  dateCreated: string;
  dateModified: string;
  /** Mock-only stand-in for downloadable content (email bodies, doc text). */
  content?: string;
}

export interface Memo {
  id: string;
  matterId: string;
  text: string;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface FirmDataset {
  staff: Staff[];
  matterTypes: MatterType[];
  matters: Matter[];
  tasks: Task[];
  events: CalendarEvent[];
  folders: Folder[];
  files: FileRecord[];
  memos: Memo[];
}
