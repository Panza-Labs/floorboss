// A do-not-contact hold that lands in another event's record with no floorboss command reading it there (a sync pull)
// leaves the holds index behind that record; this event's page is out of date at once, and Copy is no longer offered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, NOW } from './fixtures/harness.mjs';
import { outboxStale } from '../skills/event-outreach/scripts/commands/cards.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const paths = (H) => ({ outbox: join(H.dir, 'outbox.html'), derived: join(H.dir, 'derived') });
const copyable = (H) =>
  [...readFileSync(join(H.dir, 'outbox.html'), 'utf8').matchAll(/<article class="card[^"]*" data-id="(c\d+)" data-touch="(\d+)"[\s\S]*?<\/article>/g)]
    .filter((m) => /class="copy"/.test(m[0]))
    .map((m) => `${m[1]}:${m[2]}`)
    .sort();
const asHome = (H, fn) => {
  const o = { home: process.env.FLOORBOSS_HOME, now: process.env.FLOORBOSS_NOW };
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = NOW;
  try {
    return fn();
  } finally {
    if (o.home === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = o.home;
    if (o.now === undefined) delete process.env.FLOORBOSS_NOW;
    else process.env.FLOORBOSS_NOW = o.now;
  }
};

test('a do-not-contact hold written into another event\'s record by a sync makes this page out of date', () => {
  const A = setup({ attendees: LIST });
  const B = setup({ attendees: LIST, home: A.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  triage(A);
  draftApprove(A);
  cli(A, 'event-outreach', ['open', '--event', A.slug, '--no-open']);
  const ana = idOf(A, 'Ana Berg');
  assert.ok(copyable(A).includes(`${ana}:1`));
  assert.equal(asHome(A, () => outboxStale(paths(A))), false, 'current before');
  appendFileSync(join(B.dir, 'ledger.jsonl'), JSON.stringify({ at: NOW, type: 'hold_seen', who: 'floorboss', id: idOf(B, 'Ana Berg'), rung: 'do_not_contact', says: 'on your do-not-contact list: ana@acme.test is on the list' }) + '\n');
  assert.equal(asHome(A, () => outboxStale(paths(A))), true, 'the hold at Expo B makes the page out of date');
  cli(A, 'event-outreach', ['open', '--event', A.slug, '--no-open']);
  assert.ok(!copyable(A).includes(`${ana}:1`), 'no Copy for her once rebuilt');
});
