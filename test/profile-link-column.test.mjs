// A column is the profile link only when it holds links: "Profile visibility" (Public / Hidden) is not one (sim run 3, F2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';

const map = (csv) => {
  const { headers, records } = readCsvText(csv);
  return propose(headers, records, 'attendees').columns;
};

test('"Profile visibility" with Public / Hidden is not the profile link', () => {
  const cols = map('Name,Company,Profile visibility\nAna Berg,Acme,Public\nBo Li,Globex,Hidden\nCy Ng,Initech,Public\n');
  assert.notEqual(cols['Profile visibility'].field, 'profile_url');
});

test('privacy and status columns about the profile are not the profile link', () => {
  const cols = map('Name,Company,Profile privacy,Profile status\nAna Berg,Acme,Private,Active\nBo Li,Globex,Open,Inactive\n');
  assert.notEqual(cols['Profile privacy'].field, 'profile_url');
  assert.notEqual(cols['Profile status'].field, 'profile_url');
});

test('a column named "Profile" whose values are not links is not the profile link', () => {
  const cols = map('Name,Company,Profile\nAna Berg,Acme,Public\nBo Li,Globex,Hidden\n');
  assert.notEqual(cols['Profile'].field, 'profile_url');
});

test('a real profile-link column still maps', () => {
  for (const h of ['Profile URL', 'LinkedIn profile', 'Profile', 'LinkedIn']) {
    const cols = map(`Name,Company,${h}\nAna Berg,Acme,https://www.linkedin.com/in/ana-berg\nBo Li,Globex,linkedin.com/in/bo-li\nCy Ng,Initech,\n`);
    assert.equal(cols[h].field, 'profile_url', h);
  }
});

// Owner's rule (round 5): only LinkedIn person links and event-app profile links are read. Relative links with no
// app named, bare handles and other sites are not (they mapped in rounds 2 to 4); a LinkedIn link with placeholders is.
test('relative links, handles and other sites are not read; LinkedIn links with placeholders are', () => {
  const cases = [
    ['Profile URL', ['/people/123', '/people/456'], 'ignore'],
    ['LinkedIn', ['johndoe', 'janedoe'], 'ignore'],
    ['LinkedIn', ['@johndoe', 'in/janedoe'], 'ignore'],
    ['LinkedIn profile', ['https://www.linkedin.com/in/ana', 'N/A', '-', 'none'], 'profile_url'],
    ['Profile link', ['Not shared', 'Not shared', 'https://x.com/a'], 'ignore']
  ];
  for (const [h, vals, want] of cases) {
    const csv = `Name,Company,${h}\n` + vals.map((v, i) => `P${i} Q,Co${i},${v}`).join('\n') + '\n';
    assert.equal(map(csv)[h].field, want, `${h}: ${vals.join(', ')}`);
  }
});

test('a demoted profile column says why in plain words', () => {
  const col = map('Name,Company,Profile\nAna Berg,Acme,Public\nBo Li,Globex,Hidden\n')['Profile'];
  assert.equal(col.field, 'ignore');
  assert.match(col.why || '', /Public.*Hidden|not links/i, JSON.stringify(col));
});

test('visibility words block only the profile link: "Public title" is still the title', () => {
  const cols = map('Name,Company,Public title\nAna Berg,Acme,COO\nBo Li,Globex,VP\n');
  assert.equal(cols['Public title'].field, 'title');
});
