// A person's sequence goes on a route of channels, one per message, and no message goes until every channel they were
// written to has been checked for a reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setup, cli, triage, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { parseRoute, personRoute, DEFAULT_ROUTE, sentKind, touchBefore } from '../lib/route.mjs';
import { readLedger, fold, legacyState, append } from '../lib/ledger.mjs';
import { uncheckedChannels } from '../lib/sendcheck.mjs';

const EVENT = { app_name: 'Grip' };
const SETTINGS = { channels: ['email', 'paste'], linkedin_messages: true };
const FULL = { email: 'a@x.test', profile_url: 'https://www.linkedin.com/in/a' };

test('the default route is email, app, LinkedIn, email', () => {
  assert.deepEqual([...DEFAULT_ROUTE], ['email', 'app', 'linkedin', 'email']);
  assert.deepEqual(personRoute(FULL, EVENT, SETTINGS), ['email', 'app', 'linkedin', 'email']);
});

test('a step they cannot be reached on is left out', () => {
  assert.deepEqual(personRoute({ email: 'a@x.test' }, EVENT, SETTINGS), ['email', 'app', 'email']);
  assert.deepEqual(personRoute({ email: 'a@x.test' }, {}, SETTINGS), ['email', 'email']);
  assert.deepEqual(personRoute({ profile_url: FULL.profile_url }, EVENT, SETTINGS), ['app', 'linkedin']);
  assert.deepEqual(personRoute(FULL, { app_name: 'Grip', no_app: true }, { ...SETTINGS, linkedin_messages: false }), ['email', 'email']);
});

test('the route can be longer, shorter or in another order', () => {
  assert.deepEqual(parseRoute('LinkedIn, event app, email'), ['linkedin', 'app', 'email']);
  assert.deepEqual(parseRoute('email then linkedin'), ['email', 'linkedin']);
  assert.deepEqual(parseRoute(['email']), ['email']);
  assert.equal(parseRoute('email app linkedin email app linkedin email app').length, 8);
  assert.deepEqual(personRoute(FULL, EVENT, { ...SETTINGS, route: ['linkedin', 'email'] }), ['linkedin', 'email']);
  assert.throws(() => parseRoute('fax'), /isn't a channel/);
  assert.throws(() => parseRoute('email '.repeat(9)), /at most 8/);
  assert.throws(() => parseRoute(''), /at least one/);
});

test('routing someone by hand, or a touches setting with no route, keeps one channel', () => {
  assert.equal(personRoute(FULL, EVENT, SETTINGS, 'app'), null);
  assert.equal(personRoute(FULL, EVENT, { ...SETTINGS, touches_set: true }), null);
  assert.deepEqual(personRoute(FULL, EVENT, { ...SETTINGS, touches_set: true, route: ['email', 'app'] }), ['email', 'app']);
});

test('each planned message of the sequence is on its own channel', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n',
    event: { app_name: 'Grip' },
    settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' } }
  });
  triage(H);
  const jobs = todoJobs(H).jobs.filter((j) => j.id === idOf(H, 'Ana Berg') && j.kind === 'message').sort((a, b) => a.touch - b.touch);
  assert.deepEqual(jobs.map((j) => [j.touch, j.channel, j.routed ?? null]), [[1, 'email', null], [2, 'paste', 'app'], [3, 'paste', null], [4, 'email', null]]);
  assert.match(jobs[1].followup_note, /goes on Grip.*went on email/);
  assert.equal(jobs[2].invite_note, true, 'the first LinkedIn message is an invitation note');
  assert.equal(jobs[1].app_note?.times_in_note, true);
});

const sent = (channel, sent_at, via = 'floorboss') => ({ sent: { channel, via }, sent_at });
const T0 = Date.parse('2026-10-12T08:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const person = { touches: { 1: sent('email', at(-9000), 'email.send'), 2: sent('Grip', at(-5000)) } };
const email = { id: 'c001', touch: 3, via: 'email.send' };

test('an email after an app note waits until the app was checked', () => {
  assert.deepEqual(uncheckedChannels(email, person, [], {}, T0), ['app']);
});

test('a read of that inbox, or the user saying so, clears it', () => {
  for (const e of [{ type: 'reply_checked', id: 'c001', source: 'app', at: at(-5) }, { type: 'no_reply_said', ids: ['c001'], at: at(-5) }])
    assert.deepEqual(uncheckedChannels(email, person, [e], { email: true, other: true }, T0), [], e.type);
});

test('a check of another inbox, an old check, or one before their message does not count', () => {
  for (const e of [{ type: 'reply_checked', id: 'c001', source: 'linkedin', at: at(-5) }, { type: 'reply_checked', id: 'c001', source: 'app', at: at(-11) }, { type: 'reply_checked', id: 'c002', source: 'app', at: at(-5) }])
    assert.deepEqual(uncheckedChannels(email, person, [e], {}, T0), ['app']);
});

test('an app note after an email needs the mailbox checked, and the user\'s word counts only with no mailbox', () => {
  const app = { id: 'c001', touch: 3, via: 'browser', where: 'Grip' };
  const p = { touches: { 1: sent('email', at(-9000), 'email.send') } };
  const said = { type: 'no_reply_said', ids: ['c001'], at: at(-5) };
  assert.deepEqual(uncheckedChannels(app, p, [said], { email: true }, T0), ['email']);
  assert.deepEqual(uncheckedChannels(app, p, [said], { email: false, crm: false }, T0), []);
  assert.deepEqual(uncheckedChannels(app, p, [{ type: 'reply_checked', id: 'c001', source: 'mailbox', at: at(-5) }], { email: true }, T0), []);
});

test('one channel throughout asks nothing new', () => {
  const p = { touches: { 1: sent('email', at(-9000), 'email.send') } };
  assert.deepEqual(uncheckedChannels(email, p, [], {}, T0), []);
});

test('where a message went is read from the send', () => {
  assert.equal(sentKind({ via: 'email.send', channel: 'email.send' }), 'email');
  assert.equal(sentKind({ channel: 'LinkedIn' }), 'linkedin');
  assert.equal(sentKind({ channel: 'Grip' }), 'app');
  assert.equal(sentKind({ via: 'chat.send', channel: 'chat.send' }), null);
});

test('a skipped step is passed over: the next message goes without it and the skipped one never does', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n',
    event: { app_name: 'Grip' },
    settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' } }
  });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  const log = join(H.dir, 'ledger.jsonl');
  const add = (e) => append(log, { who: 'user', said: 'skip it', ...e }, new Date(NOW));
  add({ type: 'sent', id, touch: 1, date: '2026-10-12', via: 'email.send', channel: 'email', source: 'user' });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'skip.json');
  writeFileSync(f, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'skipped', said: 'skip the app for Ana' }] }));
  assert.equal(cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]).applied, true);
  const state = legacyState(fold(readLedger(log).entries));
  assert.equal(touchBefore(state[id], 3), 1, 'the message before step 3 is step 1');
  assert.equal(state[id].touches[2].skipped, true);
  const later = todoJobs(H, '2026-10-20T08:00:00Z').jobs.filter((j) => j.id === id && j.kind === 'message');
  assert.ok(later.some((j) => j.touch === 3 && j.channel === 'paste'), 'step 3 is next');
  assert.ok(!later.some((j) => j.touch === 2), 'step 2 is not written');
  assert.match(later.find((j) => j.touch === 3).followup_note, /never quote it, mention it/);
});
