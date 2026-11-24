// Round 6 of F2: a profile column is read when most of its filled cells are person links; the other cells are left
// out for that person, never kept as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose, applyMapping } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const run = (h, vals) => {
  const csv = `Name,Company,${h}\n` + vals.map((v, i) => `P${i} Q,Co${i},${v}`).join('\n') + '\n';
  const { headers, records } = readCsvText(csv);
  const p = propose(headers, records, 'attendees');
  const rows = applyMapping(records, { kind: 'attendees', columns: p.columns, values: p.values || {} });
  return { col: p.columns[h], links: rows.map((r) => r.profile_url || '') };
};
const li = (n) => Array.from({ length: n }, (_, i) => `https://www.linkedin.com/in/p${i}`);

test('a LinkedIn column with one bad cell in ten is read; that person has no link', () => {
  for (const bad of ['Ana Berg', 'https://cdn.brella.io/a.jpg']) {
    const { col, links } = run('LinkedIn', [...li(9), bad]);
    assert.equal(col.field, 'profile_url', bad);
    assert.equal(links[9], '', `${bad}: ${links[9]}`);
    assert.equal(links[0], 'https://www.linkedin.com/in/p0');
    assert.match(col.why || '', /read as the profile link; 1 of 10 cells were not LinkedIn or event-app profile links and were left out \(samples: /, col.why);
  }
});

test('five good and five bad is not read; six good and four bad is read and empties the four', () => {
  const bad = ['johndoe', 'linkedin', 'n/a please', 'Bo Li'];
  assert.equal(run('LinkedIn', [...li(5), ...bad, 'x']).col.field, 'ignore');
  const { col, links } = run('LinkedIn', [...li(6), ...bad]);
  assert.equal(col.field, 'profile_url');
  assert.deepEqual(links.slice(6), ['', '', '', '']);
  assert.match(col.why, /4 of 10 cells/);
});
