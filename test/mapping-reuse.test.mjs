// A column layout is confirmed once: the next event with the same file layout uses that mapping without asking.
// A CRM export with a status value the earlier mapping never saw, and no guess for it, goes back to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli } from './fixtures/harness.mjs';

const LIST = 'Full name,Job role,Org,Mail,Hall\nAna Berg,COO,Acme,ana@acme.test,2\n';
const CRM = (status) => `Name,Company,Email,Owner,Status,Opted Out\nAna Berg,Acme,ana@acme.test,Sam Rivera,${status},no\n`;

test('column mappings: a layout confirmed at one event is used again at the next', () => {
  const A = setup({ attendees: LIST, crm: CRM('Customer'), event: { slug: 'expo-one', name: 'Expo One' } });
  for (const kind of ['attendees', 'crm']) {
    assert.equal(cli(A, 'crm-triage', ['propose-mapping', '--event', A.slug, '--kind', kind]).confirmed, false, kind);
    assert.ok(!cli(A, 'crm-triage', ['confirm-mapping', '--event', A.slug, '--kind', kind, '--accept', '--said', 'ok']).ERROR);
  }
  const B = setup({ home: A.HOME, attendees: LIST.replace('Ana Berg', 'Bo Li'), crm: CRM('Customer'), event: { slug: 'expo-two', name: 'Expo Two' } });
  for (const kind of ['attendees', 'crm']) {
    const p = cli(B, 'crm-triage', ['propose-mapping', '--event', B.slug, '--kind', kind]);
    assert.equal(p.confirmed, true, `${kind}: ${JSON.stringify(p).slice(0, 300)}`);
    assert.match(p.reused_from, /expo-one/);
  }
  // A new status nobody can guess: the CRM mapping is asked again; the attendee one still isn't.
  const C = setup({ home: A.HOME, attendees: LIST, crm: CRM('Zebra stripe'), event: { slug: 'expo-three', name: 'Expo Three' } });
  assert.equal(cli(C, 'crm-triage', ['propose-mapping', '--event', C.slug, '--kind', 'attendees']).confirmed, true);
  const crm = cli(C, 'crm-triage', ['propose-mapping', '--event', C.slug, '--kind', 'crm']);
  assert.equal(crm.confirmed, false);
  assert.match(crm.reused_from, /Zebra stripe/);
});

test('column mappings: the mock event\'s mapping is never used for a real event', () => {
  const A = setup({ attendees: LIST, event: { slug: 'mock-harbour-haul', mock: true } });
  cli(A, 'crm-triage', ['propose-mapping', '--event', A.slug, '--kind', 'attendees']);
  cli(A, 'crm-triage', ['confirm-mapping', '--event', A.slug, '--kind', 'attendees', '--accept', '--said', 'ok']);
  const B = setup({ home: A.HOME, attendees: LIST, event: { slug: 'real-expo' } });
  assert.equal(cli(B, 'crm-triage', ['propose-mapping', '--event', B.slug, '--kind', 'attendees']).confirmed, false);
});
