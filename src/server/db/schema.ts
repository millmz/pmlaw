import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * PAM's cache of Smokeball data (docs/01 "sync/cache layer"). Every row keeps
 * its Smokeball id as primary key plus syncedAt, so answers can say "as of…".
 * The cache is disposable by design — deletable and re-syncable at any time.
 */

export const staff = pgTable('staff', {
  id: text('id').primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  initials: text('initials').notNull(),
  email: text('email').notNull(),
  role: text('role').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const matterTypes = pgTable('matter_types', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  location: text('location').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const matters = pgTable('matters', {
  id: text('id').primaryKey(),
  number: text('number').notNull(),
  status: text('status').notNull(),
  matterTypeId: text('matter_type_id').notNull(),
  clientFirstName: text('client_first_name').notNull(),
  clientLastName: text('client_last_name').notNull(),
  description: text('description').notNull(),
  dateOfLoss: text('date_of_loss'),
  statuteDate: text('statute_date'),
  isInSuit: boolean('is_in_suit'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  matterId: text('matter_id'),
  subject: text('subject').notNull(),
  note: text('note'),
  assigneeIds: jsonb('assignee_ids').$type<string[]>().notNull(),
  dueDate: text('due_date'),
  isCompleted: boolean('is_completed').notNull(),
  completedAt: text('completed_at'),
  createdById: text('created_by_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  matterId: text('matter_id'),
  subject: text('subject').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  timeZone: text('time_zone').notNull(),
  allDay: boolean('all_day').notNull(),
  attendeeIds: jsonb('attendee_ids').$type<string[]>().notNull(),
  onOfficeCalendar: boolean('on_office_calendar').notNull(),
  location: text('location'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const folders = pgTable('folders', {
  id: text('id').primaryKey(),
  matterId: text('matter_id').notNull(),
  parentId: text('parent_id'),
  name: text('name').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  matterId: text('matter_id').notNull(),
  folderId: text('folder_id'),
  name: text('name').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  emailFrom: text('email_from'),
  emailTo: text('email_to'),
  dateCreated: text('date_created').notNull(),
  dateModified: text('date_modified').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memos = pgTable('memos', {
  id: text('id').primaryKey(),
  matterId: text('matter_id').notNull(),
  text: text('text').notNull(),
  createdById: text('created_by_id').notNull(),
  updatedById: text('updated_by_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per record type: the incremental-sync cursor. */
export const syncState = pgTable('sync_state', {
  recordType: text('record_type').primaryKey(),
  lastSyncedAt: text('last_synced_at').notNull(),
});

/** Chat persistence: conversations survive reloads; "new conversation"
 *  closes ALL open sessions server-side (the Ask Pam lesson — docs/05). */
export const chatSessions = pgTable('chat_sessions', {
  id: text('id').primaryKey(),
  staffId: text('staff_id').notNull(),
  closed: boolean('closed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable('chat_messages', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  sessionId: text('session_id').notNull(),
  /** 'user' | 'assistant' display text, plus the full LLM message JSON. */
  role: text('role').notNull(),
  displayText: text('display_text').notNull(),
  llmJson: jsonb('llm_json'),
  citations: jsonb('citations'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/** Audit log for every tool invocation and (later) every write (docs/03). */
export const auditLog = pgTable('audit_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  params: jsonb('params'),
  result: text('result'),
});
