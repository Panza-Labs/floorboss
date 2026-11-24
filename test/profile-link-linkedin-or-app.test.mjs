// Round 5 of F2, the owner's rule: a profile column is read only when its cells are LinkedIn person links or links to
// a person's page on an event app (a known app, or the event's own app_url).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../skills/crm-triage/scripts/sources.mjs';
import { readCsvText } from '../lib/csv.mjs';
import { setup, cli } from './fixtures/harness.mjs';

const colOf = (h, vals, ev = {}) => {
  const csv = `Name,Company,${h}\n` + vals.map((v, i) => `P${i} Q,Co${i},${v}`).join('\n') + '\n';
  const { headers, records } = readCsvText(csv);
  return propose(headers, records, 'attendees', ev).columns[h];
};

test('event-app profile links are read: known apps, and the event app_url', () => {
  assert.equal(colOf('Profile', ['https://app.brella.io/events/x/people/1', 'https://app.brella.io/events/x/people/2']).field, 'profile_url');
  assert.equal(colOf('Swapcard profile', ['https://app.swapcard.com/event/x/person/abc', 'https://app.swapcard.com/event/x/person/def']).field, 'profile_url');
  assert.equal(colOf('Profile', ['https://meet.myexpo.example/p/1', 'https://meet.myexpo.example/p/2'], { appUrl: 'https://meet.myexpo.example/' }).field, 'profile_url');
  assert.equal(colOf('Profile', ['https://meet.myexpo.example/p/1', 'https://meet.myexpo.example/p/2']).field, 'ignore', 'without app_url it is another site');
  assert.equal(colOf('Profile', ['https://app.brella.io/', 'https://app.brella.io/']).field, 'ignore', "an app's home page is no person's page");
});

test('a relative link counts only when the header names the app', () => {
  assert.equal(colOf('Brella profile', ['/people/123', '/people/456']).field, 'profile_url');
  assert.equal(colOf('Profile', ['/people/123', '/people/456'], { appName: 'Brella' }).field, 'ignore');
  assert.equal(colOf('Meetwise profile', ['/people/123', '/people/456'], { appName: 'Meetwise' }).field, 'profile_url');
  const c = colOf('Profile URL', ['/people/123', '/people/456']);
  assert.match(c.why, /no site.*\/people\/123/, c.why);
});

test('company pages, pictures and other sites are not read, with a reason and samples', () => {
  for (const [h, v, re] of [
    ['LinkedIn', ['https://www.linkedin.com/company/acme', 'https://www.linkedin.com/company/globex'], /only uses LinkedIn profile links and event-app profile links, and these cells are https:\/\/www\.linkedin\.com\/company\/acme/],
    ['Profile photo', ['https://cdn.brella.io/a.jpg', 'https://cdn.brella.io/b.jpg'], /picture/],
    ['Profile', ['https://cdn.brella.io/users/default.png', 'https://cdn.brella.io/users/default.png'], /pictures or files/],
    ['Profile', ['https://github.com/ana', 'https://github.com/bo'], /these cells are https:\/\/github\.com\/ana/]
  ]) {
    const c = colOf(h, v);
    assert.equal(c.field, 'ignore', `${h}: ${v}`);
    assert.match(c.why || '', re, c.why);
  }
});

test('the mapping table shows the reason', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,Profile visibility\nAna Berg,COO,Acme,ana@acme.test,Public\nBo Li,VP,Globex,bo@globex.test,Hidden\n' });
  const p = cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']);
  const md = (p.view && require_(p.view)) || JSON.stringify(p);
  assert.match(md, /Profile visibility \| not read: floorboss only uses LinkedIn profile links and event-app profile links, and these cells are Public, Hidden/, md);
});
import { readFileSync } from 'node:fs';
function require_(f) {
  return readFileSync(f, 'utf8');
}
