import type { SmokeballClient } from './client.js';

/**
 * PAM's webhook subscription on the real tenant. Event-type names are the
 * ones the API itself listed on staging (GET /webhooks/types, Sept 2026).
 * Deliveries are treated as sync TRIGGERS (plus explicit deletes) rather
 * than trusted payloads, so any payload shape is safe — and the `error`
 * type is how Smokeball reports a rejected async write.
 */
export const PAM_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.completed',
  'event.updated',
  'matter.created',
  'matter.updated',
  'matter.closed',
  'matter.statusUpdated',
  'memo.created',
  'memo.updated',
  'memo.deleted',
  'staff.updated',
  'files.updated',
  'error',
];

export interface SubscriptionState {
  id: string;
  created: boolean;
  url: string;
}

type Raw = Record<string, unknown>;
const urlOf = (s: Raw): string => String(s['eventNotificationUrl'] ?? s['callbackUrl'] ?? s['url'] ?? '');

/** Idempotent: reuse an existing subscription for our callback URL, else create one. */
export async function ensureWebhookSubscription(
  client: SmokeballClient,
  callbackUrl: string,
  key: string,
): Promise<SubscriptionState> {
  const existing = (await client.listWebhooks()).value as Raw[];
  const mine = existing.find((s) => urlOf(s) === callbackUrl);
  if (mine && typeof mine['id'] === 'string') return { id: mine['id'], created: false, url: callbackUrl };
  const made = await client.createWebhook(PAM_EVENT_TYPES, callbackUrl, key, 'PAM');
  return { id: made.id, created: true, url: callbackUrl };
}
