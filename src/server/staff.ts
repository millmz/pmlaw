import { schema, type Db } from './db/index.js';

/**
 * The golden dataset hardcodes Jeff as 's-jeff'; a real tenant issues UUIDs.
 * After each sync, resolve who "the current user" actually is in the mirror:
 * keep the current id if it still exists, else match by PAM_STAFF_NAME
 * (default "millman"), else fall back to the first staff row so the app
 * degrades to *someone* rather than nobody.
 */
export async function resolveCurrentStaffId(db: Db, current: string): Promise<string> {
  const rows = await db.select().from(schema.staff);
  if (rows.length === 0 || rows.some((r) => r.id === current)) return current;
  const prefer = (process.env['PAM_STAFF_NAME'] ?? 'millman').trim().toLowerCase();
  const hit =
    rows.find((r) => `${r.firstName} ${r.lastName}`.toLowerCase().includes(prefer)) ?? rows[0]!;
  return hit.id;
}
