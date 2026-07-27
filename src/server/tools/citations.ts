/**
 * Source citations (docs/00 principle 3): every material answer carries the
 * Smokeball records it came from, with enough identifying information to find
 * them. Deep links are undocumented (docs/02), so citations render as
 * matter-number + record identifiers until Sprint 0 proves URL patterns.
 */

export interface Citation {
  /** Smokeball record kind. */
  kind: 'matter' | 'task' | 'event' | 'file' | 'memo' | 'staff';
  /** Smokeball record id — validated server-side against the cache (docs/04). */
  id: string;
  /** Human-locatable label, e.g. "Matter 24-1101 · Grasso — Task: Call adjuster". */
  label: string;
}

export const cite = (kind: Citation['kind'], id: string, label: string): Citation => ({
  kind,
  id,
  label,
});
