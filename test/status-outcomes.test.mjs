// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What the status outputs say about how things stand: a cancellation read from the mailbox frees the time (and
// says so when nothing was booked); someone away is shown as away, not as due, until the day they're back; and
// contacted.csv tells a decline, a cancellation, an absence and a bounce apart, with the meeting's time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, NOW } from './fixtures/harness.mjs';
import { validateSync } from '../skills/connectors/scripts/tasks.mjs';
import { planSync } from '../skills/event-outreach/scripts/sync.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';
import { readCsvText } from '../lib/csv.mjs';

const LATER = '2026-10-20T08:00:00Z';
const file = (H, name, data) => {
  const f = join(H.dir, name);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const rec = (H, items, now = LATER) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, `rep-${Math.random().toString(36).slice(2)}.json`, { items })], now);
const people = (H) => {
  const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
  return fold(entries, damaged).people;
};
function ready(att) {
  const H = setup({ attendees: att });
  triage(H);
  draftApprove(H);
  return H;
}

test('sync: "cancelled" is an intent; a cancellation frees the booked time, counts as a reply, and with another_time asks to agree a new one', () => {
  const v = validateSync(
    { people: [{ id: 'c001', messages: [{ message_id: 'm1', direction: 'in', at: '2026-10-14T09:00:00Z', intent: 'cancelled', another_time: true }] }] },
    'email.messages'
  );
  assert.deepEqual(v.errors, []);
  assert.equal(v.people[0].items[0].another_time, true);
  assert.match(validateSync({ people: [{ id: 'c001', messages: [{ message_id: 'm1', direction: 'in', at: '2026-10-14T09:00:00Z', intent: 'canceled' }] }] }, 'email.messages').errors[0], /isn't one of .*cancelled/);
  const byId = { c001: { name: 'Ana Berg', company: 'Acme', email: 'ana@acme.test' }, c002: { name: 'Bo Li', company: 'Globex', email: 'bo@globex.test' } };
  const state = {
    c001: { sent: { 1: '2026-10-12' }, replied: true, booked: 's20261110T1000', booked_blocks: ['s20261110T1000'] },
    c002: { sent: { 1: '2026-10-12' } }
  };
  const msg = (id, extra) => ({ id, items: [{ ext: `m-${id}`, kind: 'message', email: true, direction: 'in', at: '2026-10-14T09:00:00Z', intent: 'cancelled', ...extra }] });
  const since = { c001: '2026-10-12T00:00:00Z', c002: '2026-10-12T00:00:00Z' };
  const p = planSync([msg('c001', { another_time: true, from: 'ana@acme.test' }), msg('c002', { from: 'bo@globex.test' })], { state, since, source: 'mailbox', now: new Date(LATER), byId, zone: 'Europe/Amsterdam' });
  const ana = p.entries.filter((e) => e.id === 'c001');
  assert.deepEqual(
    ana.map((e) => e.type),
    ['unbooked', 'reply_action'],
    'the time is freed; she had replied already, so no second reply'
  );
  assert.deepEqual(ana[0].blocks, ['s20261110T1000']);
  assert.equal(ana[1].action, 'book');
  assert.equal(ana[1].why, 'cancelled');
  assert.match(p.lines[0], /Ana Berg .*cancelled .*free again.*another time/);
  assert.ok(p.asks.some((a) => a.id === 'c001' && /another time/.test(a.why)));
  // Nothing booked with Bo: said so, nothing invented, and his message still counts as a reply.
  const bo = p.entries.filter((e) => e.id === 'c002');
  assert.deepEqual(
    bo.map((e) => e.type),
    ['replied']
  );
  assert.match(p.lines[1], /Bo Li .*no meeting booked/);
});

test('sync through the CLI: the cancelled meeting is off the fold and counts as a reply', () => {
  const H = ready('Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n');
  const ana = idOf(H, 'Ana Berg');
  // Booked (recorded) on 18 Oct, cancelled by her on 19 Oct: the cancellation is about this meeting.
  assert.ok(!rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }, { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'booked' }], '2026-10-18T08:00:00Z').ERROR);
  assert.ok(people(H)[ana].booked);
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug], LATER);
  const answers = { people: [{ id: ana, messages: [{ message_id: 'c1', direction: 'in', at: '2026-10-19T09:00:00Z', intent: 'cancelled', from: 'ana@acme.test' }] }] };
  const r = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', file(H, 'mail.json', answers)], LATER);
  assert.equal(r.saved, true, JSON.stringify(r));
  const p = people(H)[ana];
  assert.equal(p.booked, null, 'the meeting is off');
  assert.equal(p.replied, true, 'a cancellation is them writing back');
  assert.equal(p.cancelled, true);
  assert.equal(p.reply_actions.filter((a) => !a.done).length, 0, 'no new time asked for: no question');
});

test('someone away is listed as away, not due, in the summary and the tracker, and is due again the day they are back', () => {
  const H = ready('Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n');
  const ana = idOf(H, 'Ana Berg'),
    bo = idOf(H, 'Bo Li');
  assert.ok(!rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }, { who: 'Bo Li', what: 'sent', date: '2026-10-12' }], NOW).ERROR);
  assert.ok(!rec(H, [{ who: 'Ana Berg', what: 'away', until: '2026-10-25', said: 'out of office until the 25th' }]).ERROR);
  const s = cli(H, 'event-outreach', ['summary', '--event', H.slug], LATER);
  assert.ok(!s.ERROR, s.ERROR);
  assert.deepEqual(
    s.follow_ups_due.map((d) => d.id),
    [bo],
    'only Bo is due'
  );
  assert.deepEqual(s.away, [{ id: ana, name: 'Ana Berg', until: '2026-10-25', note: 'away until 2026-10-25: no follow-up before then' }]);
  cli(H, 'event-outreach', ['tracker', '--event', H.slug], LATER);
  const html = readFileSync(join(H.dir, 'tracker.html'), 'utf8');
  const row = (name) => html.split('<tr').find((r) => r.includes(name));
  assert.match(row('Ana Berg'), /Away until 2026-10-25: no follow-up before then/);
  assert.doesNotMatch(row('Ana Berg'), /Follow up/);
  assert.match(row('Bo Li'), /Follow up now/);
  // Back on the 25th: due again, that day.
  const back = cli(H, 'event-outreach', ['summary', '--event', H.slug], '2026-10-25T08:00:00Z');
  assert.deepEqual(
    back.follow_ups_due.map((d) => [d.id, d.due]).sort(),
    [
      [ana, '2026-10-25'],
      [bo, '2026-10-25']
    ].sort()
  );
  assert.equal(back.away, undefined);
});

test('contacted.csv: each outcome told apart, the meeting time in the event zone, confirmations counted; old columns first', () => {
  const H = ready(
    'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\nEd Fox,VP Ops,Umbrella,ed@umbrella.test\nFe Gil,VP Ops,Stark,fe@stark.test\nGi Hu,VP Ops,Wayne,gi@wayne.test\nHu Ito,VP Ops,Soylent,hu@soylent.test\n'
  );
  const names = ['Ana Berg', 'Bo Li', 'Cy Ng', 'Di Ho', 'Ed Fox', 'Fe Gil', 'Gi Hu', 'Hu Ito'];
  assert.ok(!rec(H, names.map((who) => ({ who, what: 'sent', date: '2026-10-12' })), NOW).ERROR);
  const r = rec(H, [
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'booked' },
    { who: 'Ana Berg', what: 'sent', touch: 0, said: 'sent the confirmation' },
    { who: 'Bo Li', what: 'declined', said: 'not for us' },
    { who: 'Cy Ng', what: 'booked', time: '2026-11-10 11:00', said: 'booked' },
    { who: 'Cy Ng', what: 'cancelled', said: 'had to cancel' },
    { who: 'Di Ho', what: 'away', until: '2026-10-25', said: 'out of office' },
    { who: 'Ed Fox', what: 'bounced', said: 'bounced' },
    { who: 'Fe Gil', what: 'replied', said: 'will look' },
    { who: 'Gi Hu', what: 'stop', said: 'remove me' }
  ]);
  assert.ok(!r.ERROR, r.ERROR);
  const x = cli(H, 'event-outreach', ['export', '--event', H.slug], LATER);
  const csv = readFileSync(x.file, 'utf8');
  assert.equal(
    csv.split('\n')[0],
    'name,email,company,event,messages_sent,last_contacted,outcome,unsubscribed,owner,meeting_time',
    'the old columns keep their order; new ones at the end'
  );
  const rows = Object.fromEntries(readCsvText(csv).records.map((row) => [row.name, row]));
  const out = Object.fromEntries(Object.entries(rows).map(([n, row]) => [n, row.outcome]));
  assert.deepEqual(out, {
    'Ana Berg': 'meeting booked',
    'Bo Li': 'declined',
    'Cy Ng': 'cancelled',
    'Di Ho': 'away until 2026-10-25',
    'Fe Gil': 'replied',
    'Gi Hu': 'asked not to be contacted',
    'Hu Ito': 'no reply yet',
    'Ed Fox': 'bounced'
  });
  assert.equal(rows['Ed Fox'].messages_sent, '0', 'the bounced send never arrived');
  assert.equal(rows['Ana Berg'].meeting_time, '2026-11-10 10:00', 'event-local time');
  assert.equal(rows['Ana Berg'].messages_sent, '2', 'the confirmation is a message to her');
  assert.equal(rows['Cy Ng'].meeting_time, '', 'no meeting once cancelled');
  assert.equal(rows['Gi Hu'].unsubscribed, 'yes');
});
