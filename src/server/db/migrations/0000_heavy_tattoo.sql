CREATE TABLE "audit_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb,
	"result" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"matter_id" text,
	"subject" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"time_zone" text NOT NULL,
	"all_day" boolean NOT NULL,
	"attendee_ids" jsonb NOT NULL,
	"on_office_calendar" boolean NOT NULL,
	"location" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"matter_id" text NOT NULL,
	"folder_id" text,
	"name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"email_from" text,
	"email_to" text,
	"date_created" text NOT NULL,
	"date_modified" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"matter_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matter_types" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"location" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"status" text NOT NULL,
	"matter_type_id" text NOT NULL,
	"client_first_name" text NOT NULL,
	"client_last_name" text NOT NULL,
	"description" text NOT NULL,
	"date_of_loss" text,
	"statute_date" text,
	"is_in_suit" boolean,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memos" (
	"id" text PRIMARY KEY NOT NULL,
	"matter_id" text NOT NULL,
	"text" text NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"initials" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"record_type" text PRIMARY KEY NOT NULL,
	"last_synced_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"matter_id" text,
	"subject" text NOT NULL,
	"note" text,
	"assignee_ids" jsonb NOT NULL,
	"due_date" text,
	"is_completed" boolean NOT NULL,
	"completed_at" text,
	"created_by_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
