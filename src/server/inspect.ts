/**
 * Shape-only view of a record: every primitive is replaced by its TYPE NAME,
 * arrays keep one representative element, objects keep their keys. Safe to
 * paste anywhere — it carries field names, never client data. Used by
 * /api/smokeball/inspect to map the real tenant's custom fields.
 */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0], depth + 1)];
  switch (typeof v) {
    case 'string':
      return /^\d{4}-\d{2}-\d{2}/.test(v) ? 'date-string' : /^\d{15,}$/.test(v) ? 'ticks-string' : 'string';
    case 'number':
      return Number.isInteger(v) && Math.abs(v) > 1e14 ? 'ticks' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = shapeOf(val, depth + 1);
      return out;
    }
    default:
      return typeof v;
  }
}
