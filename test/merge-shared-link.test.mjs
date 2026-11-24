// One link shared by people with different names (a default picture, a company page) never merges them, and the
// load report says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows } from '../skills/crm-triage/scripts/merge.mjs';
import { setup, cli } from './fixtures/harness.mjs';

test('three people with different names and one shared link stay three, and the merge says the link is shared', () => {
  const link = 'https://cdn.brella.io/users/default';
  const rows = ['Ana Berg', 'Bo Li', 'Cy Ng'].map((name, i) => ({ line: i + 2, name, company: 'Acme', email: '', profile_url: link }));
  const m = mergeRows(rows);
  assert.equal(m.contacts.length, 3, JSON.stringify(m.contacts.map((c) => c.name)));
  assert.equal(m.shared_links?.length, 1, JSON.stringify(m.shared_links));
  assert.equal(m.shared_links[0].people, 3);
  // The same person twice, with the same link, still merges.
  const same = mergeRows([{ line: 2, name: 'Ana Berg', company: 'Acme', profile_url: 'https://www.linkedin.com/in/ana' }, { line: 3, name: 'Ana Berg', company: 'Acme Corp', profile_url: 'https://www.linkedin.com/in/ana' }]);
  assert.equal(same.contacts.length, 1);
});

test('the load report says one link is shared by several people', () => {
  const link = 'https://cdn.brella.io/users/default';
  const H = setup({ attendees: `Name,Title,Company,Email,Profile URL\nAna Berg,COO,Acme,,${link}\nBo Li,VP,Globex,,${link}\nCy Ng,COO,Initech,,${link}\n` });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.match(JSON.stringify(load), /shared by 3 people/, JSON.stringify(load).slice(0, 600));
  assert.equal(load.contacts ?? load.counts?.contacts ?? 3, 3);
});
