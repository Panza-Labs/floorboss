// Round 4 of F2: picture and file links are not the profile link, a "/" alone isn't a link, and one link shared by
// people with different names never merges them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const colOf = (h, vals) => {
  const csv = `Name,Company,${h}\n` + vals.map((v, i) => `P${i} Q,Co${i},${v}`).join('\n') + '\n';
  const { headers, records } = readCsvText(csv);
  return propose(headers, records, 'attendees').columns[h];
};

test('picture and file links, or a photo header, are not the profile link, with a reason', () => {
  for (const [h, v] of [
    ['Profile photo', ['https://cdn.brella.io/a.jpg', 'https://cdn.brella.io/b.jpg']],
    ['Profile picture', ['https://cdn.brella.io/users/default.png', 'https://cdn.brella.io/users/default.png', 'https://cdn.brella.io/users/default.png']],
    ['Profile', ['https://x.io/a.webp?w=200', 'https://x.io/b.PNG', 'https://x.io/c.pdf']],
    ['LinkedIn avatar', ['https://www.linkedin.com/in/ana', 'https://www.linkedin.com/in/bo']]
  ]) {
    const c = colOf(h, v);
    assert.equal(c.field, 'ignore', `${h}: ${v.join(', ')}`);
    assert.match(c.why || '', /^not read: .*(picture|file)/, `${h}: ${JSON.stringify(c)}`);
  }
});

test('a slash between words is not a link; LinkedIn links in their usual shapes are', () => {
  assert.equal(colOf('Profile', ['Sales/Marketing', 'Ops/Finance', 'Sales/Marketing']).field, 'ignore');
  // Round 5: '/people/123', 'in/janedoe' and 'www.x.com/a' are no longer read (no app named, no site, another site).
  for (const v of [['/people/123', '/people/456'], ['in/janedoe', 'in/bo-li'], ['www.x.com/a', 'www.x.com/b']]) assert.equal(colOf('Profile URL', v).field, 'ignore', v.join(', '));
  for (const v of [['linkedin.com/in/x', 'linkedin.com/in/y'], ['https://de.linkedin.com/in/ana/', 'www.linkedin.com/in/bo?trk=abc']])
    assert.equal(colOf('Profile URL', v).field, 'profile_url', v.join(', '));
});
