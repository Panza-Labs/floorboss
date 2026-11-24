// Round 3 of F2: one rule that reads the cells decides whether a profile-alias column is the profile link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const colOf = (h, vals) => {
  const csv = `Name,Company,${h}\n` + vals.map((v, i) => `P${i} Q,Co${i},${v}`).join('\n') + '\n';
  const { headers, records } = readCsvText(csv);
  return propose(headers, records, 'attendees').columns[h];
};

// Round 5 (owner's rule): only LinkedIn person links and event-app profile links are read. Other sites, relative
// links with no app named and handles moved from LINK to NOT.
const LINK = [
  ['LinkedIn profile', ['https://www.linkedin.com/in/ana', 'N/A', '-', 'none']],
  ['Profile URL', ['https://www.linkedin.com/in/ana', '', '']]
];
const NOT = [
  ['Public profile', ['https://x.com/a', 'https://x.com/b']],
  ['Profile URL', ['/people/123', '/people/456']],
  ['LinkedIn', ['johndoe', 'janedoe']],
  ['LinkedIn', ['@johndoe', 'in/janedoe']],
  ['Profile link', ['Not shared', 'Not shared', 'https://x.com/a']],
  ['LinkedIn', ['ana-berg', 'bo.li', 'cy_ng', 'ana-berg']],
  ['LinkedIn', ['yes', 'no', 'yes']],
  ['LinkedIn', ['Connected', 'Not connected']],
  ['LinkedIn', ['✓']],
  ['LinkedIn', ['Yes']],
  ['Profile', ['Public', 'Private', 'Hidden', 'Visible', 'Shown']],
  ['Profile', ['Complete', 'Incomplete']],
  ['Profile completeness', ['80%', '100%']],
  ['Profile visibility', ['Public', 'Hidden']],
  ['Profile URL', ['v1.2', '3.5']]
];

test('LinkedIn person links, with placeholders, keep the profile link', () => {
  for (const [h, v] of LINK) assert.equal(colOf(h, v).field, 'profile_url', `${h}: ${v.join(', ')}`);
});

test('other sites, relative links, handles, setting words, ticks, percentages and numbers are not read, and say why with samples', () => {
  for (const [h, v] of NOT) {
    const c = colOf(h, v);
    assert.equal(c.field, 'ignore', `${h}: ${v.join(', ')}`);
    assert.match(c.why || '', /^not read/, `${h}: ${JSON.stringify(c)}`);
    assert.ok(c.why.includes(v.find((x) => !/^(n\/?a|-+|none|not shared)$/i.test(x))), `${h}: the reason shows sample cells: ${c.why}`);
  }
});

test('"Public title" is still the title', () => {
  assert.equal(colOf('Public title', ['COO', 'VP']).field, 'title');
});
