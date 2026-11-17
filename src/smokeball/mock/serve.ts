import { DateTime } from 'luxon';
import { buildGoldenDataset } from '../../core/golden.js';
import { FIRM_TZ } from '../../core/dates.js';
import { createMockSmokeball } from './server.js';

/**
 * Standalone mock Smokeball for a production rehearsal: run this, then point
 * PAM at it exactly as it would be pointed at the real API —
 *
 *   MOCK_PORT=8787 MOCK_EXTRA_MATTERS=300 MOCK_TYPES=20000 pnpm mock
 *   SMOKEBALL_BASE_URL=http://127.0.0.1:8787 SMOKEBALL_API_KEY=mock-api-key \
 *     SMOKEBALL_TOKEN=mock-token SMOKEBALL_CLIENT_ID=mock-client-id \
 *     PAM_WRITES=off PAM_DATA_DIR=/tmp/pam-rehearsal pnpm dev
 *
 * PAM then takes its real-mode paths (background first sync, resume on
 * restart, webhooks, live clock) against data anchored to today. The extras
 * bring it to firm scale: hundreds of synthetic matters with notes and
 * files, and a matter-type catalog as large as the real one.
 */

const port = Number(process.env['MOCK_PORT'] ?? 8787);
const extra = Number(process.env['MOCK_EXTRA_MATTERS'] ?? 0);
const types = Number(process.env['MOCK_TYPES'] ?? 0);

const anchor = DateTime.now().setZone(FIRM_TZ).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
const data = buildGoldenDataset(anchor.toISO()!);
const iso = (daysAgo: number) => anchor.minus({ days: daysAgo }).toISO()!;

for (let i = 0; i < types; i++) {
  data.matterTypes.push({ id: `mt-cat-${i}`, name: `Catalog type ${i}`, category: i % 3 ? 'Other' : 'Litigation', location: 'NY' });
}

const FIRST = ['Alan', 'Beth', 'Carl', 'Dina', 'Evan', 'Faye', 'Gus', 'Hana', 'Ivan', 'Joan'];
const LAST = ['Abbott', 'Brandt', 'Castle', 'Dunne', 'Ellery', 'Farrow', 'Gage', 'Holt', 'Irwin', 'Jarvis', 'Kline', 'Lowe'];
for (let i = 0; i < extra; i++) {
  const id = `m-x${i}`;
  const first = FIRST[i % FIRST.length]!;
  const last = `${LAST[i % LAST.length]!}-${i}`;
  const closed = i % 7 === 0;
  data.matters.push({
    id,
    number: `25-${String(2000 + i)}`,
    status: closed ? 'Closed' : 'Open',
    matterTypeId: i % 5 === 0 ? 'mt-cr-ny' : 'mt-pi-ny',
    clientFirstName: first,
    clientLastName: last,
    description: `${first} ${last}`,
    createdAt: iso(400),
    updatedAt: iso(30 + (i % 60)),
  });
  // A third carry a settlement trail: labelled, free-form, or none.
  if (i % 3 === 0) {
    data.memos.push({
      id: `memo-x${i}`,
      matterId: id,
      text:
        i % 6 === 0
          ? `Insurance: Synthetic Mutual. Claim No. SM-${10000 + i}. Demand: $${100 + (i % 9) * 25},000. Offer: $${40 + (i % 5) * 10},000 made ${anchor.minus({ days: 3 + (i % 40) }).toFormat('M/d/yy')} by Pat Adjuster.`
          : `Spoke w/ adjuster at Synthetic Mutual. They came up to ${30 + (i % 7) * 5}k, we are holding at $${150 + (i % 4) * 25},000.`,
      createdById: 's-jeff',
      updatedById: 's-jeff',
      createdAt: iso(60),
      updatedAt: iso(3 + (i % 40)),
    });
  }
  if (i % 4 === 0) {
    data.files.push({
      id: `f-x${i}`,
      matterId: id,
      name: `Correspondence ${i}.pdf`,
      sizeBytes: 120_000,
      dateCreated: iso(50),
      dateModified: iso(50),
      content: '%PDF-1.7 binary',
    });
  }
}

const mock = createMockSmokeball(data);
const url = await mock.listen(port);
console.log(`[mock] Smokeball at ${url} — ${data.matters.length} matters, ${data.matterTypes.length} matter types, ${data.memos.length} notes, ${data.files.length} files (anchored ${anchor.toISODate()})`);
