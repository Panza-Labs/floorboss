// An automatic reply never counts as them writing back, so it can't end the follow-ups: told by the reader's
// "auto", by its subject or by its sender, whatever intent the reader gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSync, autoKind } from '../skills/connectors/scripts/tasks.mjs';
import { planSync } from '../skills/event-outreach/scripts/sync.mjs';

const base = {
  state: { c001: { sent: { 1: '2026-11-01' } } },
  since: { c001: '2026-10-30T00:00:00Z' },
  now: new Date('2026-11-06T12:00:00Z'),
  byId: { c001: { name: 'Ana Ruiz', company: 'Vitrinex', email: 'ana@vitrinex.test' } }
};
const read = (msg, task = 'crm.activity') => {
  const key = task === 'email.messages' ? 'messages' : 'activities';
  const v = validateSync({ people: [{ id: 'c001', [key]: [{ direction: 'in', at: '2026-11-02T09:00:00Z', from: 'ana@vitrinex.test', ...msg }] }] }, task);
  assert.deepEqual(v.errors, []);
  return planSync(v.people, { ...base, source: task === 'email.messages' ? 'mailbox' : 'crm' });
};
const types = (r) => r.entries.map((e) => e.type);

test('subjects and senders that mark an automatic reply', () => {
  for (const s of ['Out of Office: Ticket commission', '[EXT] Out of office', 'Abwesenheitsnotiz: Termin', 'Afwezig: afspraak'])
    assert.equal(autoKind(s), 'ooo', s);
  for (const s of ['Automatic reply: Ticket commission', 'Autoreply: hello', 'Réponse automatique : RDV', 'Automatische Antwort: x'])
    assert.equal(autoKind(s), 'auto', s);
  for (const s of ['[EXTERNAL] Automatic reply: x', 'EXTERNAL: Automatic reply: x', 'Automatyczna odpowiedź: x', 'Autosvar: x', 'Automaattinen vastaus: x'])
    assert.equal(autoKind(s), 'auto', s);
  for (const s of ['Ana Ruiz is out of the office.', 'Fuori ufficio: x', 'EXTERNAL: Out of Office: x', 'Out of office']) assert.equal(autoKind(s), 'ooo', s);
  assert.equal(autoKind('Undelivered Mail Returned to Sender', 'MAILER-DAEMON@mx.test'), 'maybe_bounce');
  assert.equal(autoKind('Failure Notice', '"mail delivery subsystem" <mailer-daemon@mx.test>'), 'maybe_bounce');
  assert.equal(autoKind('Re: x', 'mailer-daemon@mx.test'), 'auto', 'from the mail system: never a reply, not a bounce on its own');
  assert.equal(autoKind('Delivery Status Notification (Delay)', 'mailer-daemon@mx.test'), 'auto', 'late, not failed');
  assert.equal(
    autoKind('Undelivered Mail Returned to Sender', 'mailer-daemon@mx.test', { withText: true }),
    'maybe_bounce',
    'the reader names a bounce about them'
  );
  // Formats from Outlook, Exchange, Lotus and other languages.
  for (const s of [
    'Out of Office AutoReply: x',
    'Out of Office Reply: x',
    'AUTO: Ana Ruiz is out of the office (returning 11/10/2026)',
    'Ana Ruiz is out of the office until 11/10',
    'External: Out of office: x',
    'OOF: x'
  ])
    assert.equal(autoKind(s), 'ooo', s);
  for (const s of ['Automatiskt svar: x', 'Automatisk svar: x', 'Automatická odpověď: x', 'Automatikus válasz: x', 'Odpowiedź automatyczna: x'])
    assert.equal(autoKind(s), 'auto', s);
  // The reader saw the words and called it a reply: only the mail programs' prefixes outrank it.
  assert.equal(autoKind('Automatic reply: x', null, { withText: true }), 'auto');
  assert.equal(autoKind('Out of Office: x', null, { withText: true }), 'ooo');
  for (const s of ['Abwesenheit: Termin am Donnerstag passt', 'Ana is out of the office', 'OOO', 'Afwezig'])
    assert.equal(autoKind(s, null, { withText: true }), null, s);
  assert.equal(autoKind('Undeliverable: Ticket commission'), 'maybe_bounce', 'no sender: whose address failed is asked');
  assert.equal(autoKind('Undeliverable: Ticket commission', 'postmaster@vitrinex.test'), 'maybe_bounce', "Exchange's postmaster");
  assert.equal(autoKind('Undeliverable: Ticket commission', 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@vitrinex.test'), 'maybe_bounce');
  assert.equal(autoKind('Undeliverable: Ticket commission', null, { withText: true }), 'auto', "read: a bounce is the reader's to name, and never a reply");
  // Words in the user's own subject, quoted after the status, don't make a failure a success.
  for (const s of ['Undeliverable: Success stories from Quayside Expo', 'Undeliverable: Relay sponsorship', 'Undeliverable: Tickets delivered to your booth'])
    assert.equal(autoKind(s, 'postmaster@vitrinex.test'), 'maybe_bounce', s);
  assert.equal(autoKind('[AutoReply] Ticket commission'), 'auto');
  assert.equal(autoKind('[EXT] [Out of Office] Ticket commission'), 'ooo');
  assert.equal(autoKind('Re: x', 'postmaster@vitrinex.test'), null, 'a role inbox can be a person');
  for (const s of [
    'Returned mail - resending from my personal address',
    'Delivery failure on my side, sorry, here it is again',
    'Undeliverable?? your last email came back',
    'Re: Ana is out of the office.',
    'Not urgent: Ana is out of the office',
    'Out of office - but happy to meet Thursday',
    'OOO - but yes to Thursday',
    'Quick: OOO - back Monday',
    'Update: OOO',
    'RES: Ausente do escritório: x',
    'Odp: Automatyczna odpowiedź: x',
    'ANTW: Automatisch antwoord: x',
    'Antwort: Automatische Antwort: x',
    'Fwd: Out of office: Ticket',
    'Fwd: Undeliverable: Ticket commission',
    'Auto reply settings - quick question',
    'automatic reply is broken lol',
    'Automobile partnership',
    'Auto: Parkplatz an der Messe?',
    'My boss is out of the office, can I help?',
    'Delivery failure on my side',
    'Undeliverable mail - my fault',
    'Ana is out of the office and asked me to set up a call',
    'Ana Ruiz is out of the office until Monday - can we talk Tuesday?',
    'OOO: back Monday, Tuesday 10:00 works',
    'Out of office until Monday - can we talk Tuesday?'
  ])
    assert.equal(autoKind(s), null, s);
  for (const s of [
    'Re: Ticket commission',
    'Re: Automatic reply: x',
    'Office hours at the event',
    'OOO Mon-Wed; Thursday works',
    'Ooo, love this - Thursday 10:00?',
    'Out of office next week, but can meet Tue 14:00',
    null
  ])
    assert.equal(autoKind(s), null, String(s));
  assert.equal(autoKind('Re: x', 'noreply@scheduler.test'), null, 'a scheduling tool can book');
});

test('a CRM-logged automatic reply with no text is not a reply', () => {
  const r = read({ activity_id: 'a1', type: 'email', subject: 'Automatic reply: Ticket commission' });
  assert.deepEqual(types(r), ['synced']);
  assert.match(r.lines[0], /automatic reply on 2026-11-02, not a reply: follow-ups go on/);
});

test('an automatic subject overrides the reader calling it a reply', () => {
  const r = read({ activity_id: 'a2', type: 'email', subject: 'Automatic reply: Ticket commission', intent: 'reply' });
  assert.deepEqual(types(r), ['synced']);
});

test('the reader marking auto is enough, mailbox or CRM', () => {
  assert.deepEqual(types(read({ message_id: 'm1', subject: 'Re: Ticket commission', intent: 'reply', auto: true }, 'email.messages')), ['synced']);
  assert.deepEqual(types(read({ activity_id: 'a3', type: 'email', subject: 'Re: Ticket commission', auto: true })), ['synced']);
});

test('an out-of-office pauses until the day it gives, and pauses nothing without one', () => {
  const dated = read({ activity_id: 'a4', type: 'email', subject: 'Out of Office: Ticket commission', intent: 'ooo', until: '2026-11-10' });
  assert.deepEqual(types(dated), ['paused']);
  assert.equal(dated.entries[0].until, '2026-11-10');
  const undated = read({ activity_id: 'a5', type: 'email', subject: 'Out of Office: Ticket commission' });
  assert.deepEqual(types(undated), ['synced']);
  assert.match(undated.lines[0], /no return date read from it, not a reply: follow-ups go on as planned/);
});

test('a bounce the reader named still stands, and a real reply still counts', () => {
  assert.deepEqual(types(read({ activity_id: 'a6', type: 'email', subject: 'Undeliverable: x', from: 'postmaster@mx.test', intent: 'bounce' })), ['bounced']);
  assert.ok(types(read({ activity_id: 'a7', type: 'email', subject: 'Re: Ticket commission', intent: 'reply' })).includes('replied'));
});

test("the reader's booking, referral or no stands over an automatic-looking subject", () => {
  const b = read({ activity_id: 'b1', type: 'email', subject: 'Out of Office: Ticket commission', intent: 'booked', time: '2026-11-12 10:00' });
  assert.ok(!types(b).includes('paused') && !types(b).includes('synced'), JSON.stringify(types(b)));
  const ref = read(
    {
      message_id: 'b2',
      subject: 'Automatic reply: I have left Vitrinex',
      intent: 'referral',
      auto: true,
      referral: { name: 'Maria Gil', email: 'maria@vitrinex.test' }
    },
    'email.messages'
  );
  assert.ok(!ref.lines.some((l) => /automatic reply/.test(l)), ref.lines.join('|'));
  const no = read({ message_id: 'b3', subject: 'Auto: x', intent: 'decline', auto: true }, 'email.messages');
  assert.deepEqual(types(no), ['declined']);
});

test('a delivery failure with no text is asked about, never a reply', () => {
  assert.deepEqual(types(read({ activity_id: 'b4', type: 'email', subject: 'Undelivered Mail Returned to Sender', from: 'mailer-daemon@mx.test' })), [
    'bounced'
  ]);
  assert.deepEqual(types(read({ activity_id: 'b5', type: 'email', subject: 'Delivery Status Notification (Delay)', from: 'mailer-daemon@mx.test' })), [
    'synced'
  ]);
  assert.deepEqual(
    types(read({ message_id: 'b6', subject: 'Undelivered Mail Returned to Sender', from: 'mailer-daemon@mx.test', auto: true }, 'email.messages')),
    ['bounced'],
    'the mail system saying it failed stops sends'
  );
});

test('a bounce is never inferred where nothing failed', () => {
  const li = read({ activity_id: 'c1', type: 'message', subject: 'Undeliverable: Ticket commission', from: null });
  assert.ok(!types(li).includes('bounced'), 'a LinkedIn or app message: ' + JSON.stringify(types(li)));
  const own = read({ activity_id: 'c2', type: 'email', subject: 'Undeliverable: Ticket commission' });
  assert.ok(!types(own).includes('bounced'), 'from their own address: ' + JSON.stringify(types(own)));
  const named = read({ message_id: 'c3', subject: 'x', intent: 'bounce' }, 'email.messages');
  assert.deepEqual(types(named), ['synced'], 'a bounce from their own address is neither a failure nor them writing');
  const display = read({ message_id: 'c8', subject: 'x', intent: 'bounce', from: 'Ana Ruiz <Ana@Vitrinex.test> ' }, 'email.messages');
  assert.deepEqual(types(display), ['synced'], 'the same address in display form');
  for (const type of ['message', 'call', 'note', 'other'])
    assert.ok(!types(read({ activity_id: `n-${type}`, type, intent: 'bounce', subject: 'x' })).includes('bounced'), `a ${type} the reader called a bounce`);
  const noSender = read({ message_id: 'c9', subject: 'Undeliverable: x', intent: 'bounce', from: null }, 'email.messages');
  assert.deepEqual(types(noSender), ['bounced'], 'a named bounce with no sender stops sends');
  const anon = read({ activity_id: 'c4', type: 'email', subject: 'Undeliverable: Ticket commission', from: null });
  assert.deepEqual(types(anon), ['bounced'], 'a failure notice stops sends to that address');
  const sys = read({ activity_id: 'c5', type: 'email', subject: 'Undeliverable: Success stories', from: 'postmaster@vitrinex.test' });
  assert.deepEqual(types(sys), ['bounced']);
  const exch = read({ message_id: 'c6', subject: 'Undeliverable: Ticket commission', from: 'postmaster@vitrinex.test', intent: 'reply' }, 'email.messages');
  assert.deepEqual(types(exch), ['bounced'], 'read as a reply, but Exchange is saying delivery failed');
});

test('an automatic reply with a return date pauses', () => {
  const r = read({ activity_id: 'c7', type: 'email', subject: 'Automatic reply: x', intent: 'reply', until: '2026-11-10' });
  assert.deepEqual(types(r), ['paused']);
});

test('Lotus, dated and first-person out-of-office subjects, with no text', () => {
  for (const s of [
    'AUTO: Ana Ruiz is out of the office (returning 10.11.2026)',
    'Ana Ruiz is out of the office until 10.11.2026',
    'Out of office until Monday',
    'Out of the office until 11/10',
    'OOO until 11/10',
    'I am out of the office',
    'Out of office (returning 10 Nov)'
  ])
    assert.equal(autoKind(s), 'ooo', s);
});

test('the sixth review: what a bounce or an out-of-office must not do', () => {
  // A bounce from another address of theirs, or for someone floorboss never emailed.
  const seen = { ...base, byId: { c001: { ...base.byId.c001, emails_seen: ['ana.ruiz@home.test'] } } };
  const v = validateSync(
    { people: [{ id: 'c001', messages: [{ message_id: 'd1', direction: 'in', at: '2026-11-02T09:00:00Z', from: 'ana.ruiz@home.test', intent: 'bounce' }] }] },
    'email.messages'
  );
  assert.deepEqual(types(planSync(v.people, { ...seen, source: 'mailbox' })), ['synced']);
  const noEmail = { ...base, byId: { c001: { name: 'Ana Ruiz', company: 'Vitrinex', email: null } } };
  const w = validateSync(
    {
      people: [
        {
          id: 'c001',
          activities: [{ activity_id: 'd2', type: 'email', direction: 'in', at: '2026-11-02T09:00:00Z', from: 'postmaster@mx.test', intent: 'bounce' }]
        }
      ]
    },
    'crm.activity'
  );
  assert.deepEqual(types(planSync(w.people, { ...noEmail, source: 'crm' })), ['synced']);
  // The user's own out-of-office going out is not a follow-up.
  const out = validateSync(
    {
      people: [
        { id: 'c001', messages: [{ message_id: 'd3', direction: 'out', at: '2026-11-03T09:00:00Z', subject: 'Automatic reply: Re: Ticket', auto: true }] }
      ]
    },
    'email.messages'
  );
  assert.deepEqual(types(planSync(out.people, { ...base, source: 'mailbox' })), []);
  // Failure subjects with no sender, or from a postmaster, stop sends to that address.
  for (const subject of ['Undeliverable mail: Ticket', 'Delivery Failure: Ticket', 'Returned mail: Ticket'])
    assert.deepEqual(types(read({ activity_id: subject, type: 'email', subject, from: null })), ['bounced'], subject);
  assert.deepEqual(types(read({ activity_id: 'd4', type: 'email', subject: 'Returned mail: see transcript for details', from: 'postmaster@vitrinex.test' })), [
    'bounced'
  ]);
  for (const s of [
    'Out of the office until Monday 10th November',
    'Out of Office Re: Ticket commission',
    'On vacation: Ticket',
    'Vacation reply: Ticket',
    'Away: Ticket',
    'Ausente: Ticket'
  ])
    assert.equal(autoKind(s), 'ooo', s);
  assert.equal(autoKind('Away: back Thursday, does 10:00 work?'), null);
});

test('the final review: a failure from the mail system stops sends, a delay never ends the sequence', () => {
  for (const [subject, from] of [
    ['Delivery Status Notification (Failure)', 'mailer-daemon@googlemail.test'],
    ['Undeliverable: Quayside Expo meeting', 'postmaster@outlook.test'],
    ['Undelivered Mail Returned to Sender', 'MAILER-DAEMON@mx.test']
  ])
    assert.deepEqual(types(read({ activity_id: subject, type: 'email', subject, from, auto: true })), ['bounced'], subject);
  assert.deepEqual(types(read({ activity_id: 'e1', type: 'email', subject: 'Delivery delayed:Quayside Expo', from: 'postmaster@vitrinex.test' })), ['synced']);
  assert.deepEqual(types(read({ activity_id: 'e2', type: 'email', subject: 'Delivered: Quayside Expo', from: 'postmaster@vitrinex.test' })), ['synced']);
});
