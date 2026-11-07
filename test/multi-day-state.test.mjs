// Multi-day state: it can't double-book, re-contact, or lock up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, cpSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, idOf, draftApprove, outboxHas, groups } from './fixtures/harness.mjs';

const HEAD = 'Name,Title,Company,Email\n';
const PEOPLE = `${HEAD}Ana Berg,VP Ops,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\n`;
const status = (H, at, rows) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--text', `floorboss-status v1 event=${H.slug} at=${at}\n${rows.join('\n')}`]);

function ready() {
  const H = setup({ attendees: PEOPLE });
  triage(H);
  draftApprove(H);
  return H;
}

test('one slot can\'t be booked twice, in one paste or two', () => {
  const H = ready();
  const short = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8'));
  const [a, b] = Object.keys(short.assignments);
  const shared = short.assignments[a].find((s) => short.assignments[b].includes(s)) || short.assignments[a][0];
  const both = status(H, '2026-10-12T07:00:00Z', [`${a} sent=2026-10-12 booked=${shared}`, `${b} sent=2026-10-12 booked=${shared}`]);
  assert.match(both.ERROR, /both booked into/);
  assert.ok(!status(H, '2026-10-12T07:01:00Z', [`${a} sent=2026-10-12 booked=${shared}`]).ERROR);
  assert.match(status(H, '2026-10-12T07:02:00Z', [`${b} sent=2026-10-12 booked=${shared}`]).ERROR, /already has that time/);
});

test('a status from the future or with an impossible date is refused and locks nothing', () => {
  const H = ready();
  const id = idOf(H, 'Ana Berg');
  assert.match(status(H, '2027-01-01T00:00:00Z', [`${id} sent=2026-10-12`]).ERROR, /in the future/);
  assert.match(status(H, '2026-10-12T07:00:00Z', [`${id} sent=2026-13-45`]).ERROR, /isn't a real date/);
  assert.ok(!status(H, '2026-10-12T07:05:00Z', [`${id} sent=2026-10-12`]).ERROR, 'a real status still goes through');
  assert.ok(!todoJobs(H).t.ERROR);
});

test('a sent message is never overwritten', () => {
  const H = ready();
  const id = idOf(H, 'Bo Li');
  status(H, '2026-10-12T07:00:00Z', [`${id} sent=2026-10-12`]);
  const r = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', id, '--touch', '1', '--json', JSON.stringify({ subject: 'x', body: 'TOTALLY DIFFERENT TEXT' })]);
  assert.match(r.ERROR || '', /was sent on|isn't in the current drafting list/);
  assert.ok(!readFileSync(join(H.dir, 'work', 'drafts', `${id}-t1.json`), 'utf8').includes('TOTALLY DIFFERENT'));
});

test('re-running the triage gate keeps who needs new times', () => {
  const H = ready();
  const short = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8'));
  const [a] = Object.keys(short.assignments);
  const slot = short.assignments[a][0];
  status(H, '2026-10-12T07:00:00Z', [`${a} sent=2026-10-12 booked=${slot}`]);
  const before = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).redraft || [];
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  const after = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).redraft || [];
  assert.deepEqual(after.sort(), before.filter((id) => id !== a).sort());
});

test('someone dropped from a reloaded list is gone, and leaves the outbox', () => {
  const H = ready();
  writeFileSync(join(H.dir, 'attendees.csv'), `${HEAD}Ana Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\n`);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.deepEqual(load.gone.people.map((x) => x.name), ['Di Ho']);
  assert.equal(idOf(H, 'Ana Berg'), JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((c) => c.title === 'COO').id, 'a changed title keeps the id');
  cli(H, 'event-outreach', ['render', '--event', H.slug]);
  assert.ok(!outboxHas(H, 'Di Ho'));
});

test('a moved data folder never writes drafts into the old one', () => {
  const H = setup({ attendees: PEOPLE });
  triage(H);
  todoJobs(H);
  const moved = mkdtempSync(join(tmpdir(), 'fb-moved-'));
  cpSync(H.HOME, moved, { recursive: true });
  const H2 = { ...H, HOME: moved, dir: join(moved, 'events', H.slug) };
  const id = idOf(H2, 'Ana Berg');
  cli(H2, 'event-outreach', ['save-draft', '--event', H.slug, '--id', id, '--touch', '1', '--json', JSON.stringify({ subject: 'x', body: 'MOVED' })]);
  assert.ok(existsSync(join(H2.dir, 'work', 'drafts', `${id}-t1.json`)));
  assert.ok(!existsSync(join(H.dir, 'work', 'drafts', `${id}-t1.json`)) || !readFileSync(join(H.dir, 'work', 'drafts', `${id}-t1.json`), 'utf8').includes('MOVED'));
});

test('a cap set at one event\'s gate stays with that event', () => {
  const H = setup({ attendees: PEOPLE });
  triage(H, [], 'cap acme 0');
  const H2 = setup({ home: H.HOME, event: { slug: 'ev2' }, attendees: PEOPLE });
  triage(H2);
  assert.equal(groups(H2)['Ana Berg'], 'cold');
  const f = JSON.parse(readFileSync(join(H2.dir, 'derived', 'compat', 'triage.json'), 'utf8')).final[idOf(H2, 'Ana Berg')];
  assert.ok(!f.over_cap);
});

test('the contacted export lists who was messaged, with stops as unsubscribed; a teammate loading it holds them', () => {
  const H = ready();
  const a = idOf(H, 'Ana Berg'), b = idOf(H, 'Bo Li');
  status(H, '2026-10-12T07:00:00Z', [`${a} sent=2026-10-12`, `${b} sent=2026-10-12 stop`]);
  const x = cli(H, 'event-outreach', ['export', '--event', H.slug]);
  const csv = readFileSync(x.file, 'utf8');
  assert.equal(x.people, 2);
  assert.match(csv, /bo@globex\.test.*asked not to be contacted,yes/);
  const T = setup({ attendees: PEOPLE });
  cli(T, 'crm-triage', ['load', '--event', T.slug, '--known', x.file]);
  assert.equal(JSON.parse(readFileSync(join(T.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre[idOf(T, 'Ana Berg')].group, 'in_touch');
});

test('a stop in a teammate\'s export suppresses', () => {
  const H = ready();
  const b = idOf(H, 'Bo Li');
  status(H, '2026-10-12T07:00:00Z', [`${b} sent=2026-10-12 stop`]);
  const x = cli(H, 'event-outreach', ['export', '--event', H.slug]);
  const T = setup({ attendees: PEOPLE });
  cli(T, 'crm-triage', ['load', '--event', T.slug, '--known', x.file]);
  assert.equal(JSON.parse(readFileSync(join(T.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre[idOf(T, 'Bo Li')].group, 'suppressed');
});

test('a rename at the same address keeps the contact', () => {
  const H = ready();
  const id = idOf(H, 'Ana Berg');
  writeFileSync(join(H.dir, 'attendees.csv'), `${HEAD}Anna Berg-Holm,VP Ops,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\n`);
  const r = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.gone, undefined, 'nobody is gone: the same address is the same person');
  assert.equal(idOf(H, 'Anna Berg-Holm'), id);
});

test('two rows of one person (an accent, one address) are one contact with the address', () => {
  const H = setup({ attendees: `${HEAD}Andreas Mueller,Head of Purchasing,Albrecht Antriebe,\nAndreas Müller,Head of Purchasing,Albrecht Antriebe,a.mueller@albrecht.test\n` });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const all = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  assert.equal(all.length, 1);
  assert.equal(all[0].email, 'a.mueller@albrecht.test');
  assert.equal(load.duplicates_merged.length, 1);
  assert.equal(groups(H)['Andreas Müller'], 'open');
});

test('a person who moves up before anything is sent gets times ahead of strangers on the next gate', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `P${i} Test,VP Ops,Co${i},p${i}@co${i}.test`).join('\n');
  const H = setup({ attendees: `${HEAD}${rows}\n` });
  triage(H);
  const short = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8'));
  const last = short().open_ask?.[0] || short().approved.at(-1);
  cli(H, 'crm-triage', ['note', '--event', H.slug, '--id', last, '--text', 'our reference customer', '--known']);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  assert.ok((short().assignments[last] || []).length > 0, 'gets times now');
  assert.ok(!(short().open_ask || []).includes(last));
});

test('a removed person who turns up on a new row stays removed, and the rows are one contact', () => {
  const H = setup({ attendees: `${HEAD}Jane Doe,COO,Acme,jane@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n` });
  triage(H);
  const jane = idOf(H, 'Jane Doe');
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `remove ${jane}`]);
  writeFileSync(join(H.dir, 'attendees.csv'), `${HEAD}Jane Doe,COO,Acme,jane@acme.test\nJane Doe,COO,Acme,jane.doe.example@gmail.com\nBo Li,VP Ops,Globex,bo@globex.test\n`);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const all = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  const j = all.find((c) => c.name === 'Jane Doe');
  assert.equal(j.id, jane, 'the same id');
  assert.ok(j.emails_seen.includes('jane.doe.example@gmail.com'), 'the new address is hers too');
  assert.equal(load.duplicates_merged.length, 1);
  assert.equal(groups(H)['Jane Doe'], 'suppressed', 'removed stays removed');
  assert.equal(groups(H)['Bo Li'], 'cold');
});

test('an opted-out row that leaves the list still holds the new row for the same person', () => {
  const H = setup({ attendees: `${HEAD}Jane Doe,COO,Acme,jane@acme.test\n`, dnc: 'jane@acme.test\n' });
  triage(H);
  writeFileSync(join(H.dir, 'attendees.csv'), `${HEAD}Jane Doe,COO,Acme,jane.doe.example@gmail.com\n`);
  cli(H, 'crm-triage', ['load', '--event', H.slug, '--full']);
  const all = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre[all.find((c) => c.email === 'jane.doe.example@gmail.com').id].group, 'suppressed');
});
