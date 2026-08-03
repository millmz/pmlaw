import type { z } from 'zod';
import type { Db } from '../db/index.js';
import type { SmokeballClient } from '../../smokeball/client.js';
import type { Citation } from './citations.js';

export interface PendingConfirmation {
  action: 'task_reschedule';
  taskId: string;
  matterId?: string | undefined;
  taskSubject: string;
  oldDueDate?: string | undefined;
  newDueDate: string;
  reason?: string | undefined;
  expiresAt: number;
}

export interface ToolContext {
  db: Db;
  /** Fixed instant for tests/demos; omit for the real clock. */
  fixedNowIso?: string;
  /** The signed-in user's staff id (v1: Jeff). */
  currentStaffId: string;
  /** Live Smokeball client — needed by settlement analysis (file downloads) and writes. */
  smokeball?: SmokeballClient;
  /** Single-use confirmation tokens for the write flow (docs/03). */
  confirmations?: Map<string, PendingConfirmation>;
}

export interface ToolResult {
  data: unknown;
  citations: Citation[];
  asOf: string;
}

export interface ToolDef {
  name: string;
  description: string;
  paramsSchema: z.ZodType;
  run: (ctx: ToolContext, params: unknown) => Promise<ToolResult>;
}
