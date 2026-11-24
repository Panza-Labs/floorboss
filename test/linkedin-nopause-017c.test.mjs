// 0.1.7 section 12, fixes from the independent review of 2612902..0ca723e.
// 1. An unsent LinkedIn step is passed over only for a later step that isn't LinkedIn: two LinkedIn steps in a row (or a
//    one-channel LinkedIn sequence) keep their order, so no two LinkedIn messages are due to one person on one day and
//    none is written as a follow-up to one that may never go.
// 2. A step counts as LinkedIn only when its approval and the route as it is now both say LinkedIn: after the user moves
//    the person to another channel, an old LinkedIn approval is no reason to pass over or drop that step.
// 3. On the day the next message is due, the LinkedIn card says it goes today and to skip this one; ticked as sent anyway,
//    one message a day holds the email; and a LinkedIn message ticked as sent counts, for the reply question, from then.
// Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';
import { wentBefore, linkedInPassed } from '../lib/route.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const FRI = at('2026-10-16');
const file = (H, data) => {
  const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const add = (H, e, now) => append(join(H.dir, 'ledger.jsonl'), { who: 'user', said: 'noted', ...e }, new Date(now));
const record = (H, items, now) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })], now);
const guard = (H, input, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
function sendList(H, now) {
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug], now);
  assert.ok(!l.ERROR, l.ERROR);
  return { ...l, items: existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [] };
}
function hookOn(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  const it = { id, touch, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now };
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([it]));
  return guard(H, { to: it.to, subject: it.subject, body: it.body }, now);
}
const page = (H, now) => {
  const r = cli(H, 'event-outreach', ['render', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  return readFileSync(join(H.dir, 'outbox.html'), 'utf8');
};
const dueSection = (html) => (html.match(/<section class="queue" id="dueToday"[\s\S]*?<\/section>/) || [''])[0];
const cardOf = (html, id, touch) => (html.match(new RegExp(`<article class="card[^"]*" data-id="${id}" data-touch="${touch}"[\\s\\S]*?</article>`)) || [''])[0];

function world(route, { sending = true } = {}) {
  const H = setup({ attendees: PEOPLE, settings: { ...(sending ? { sending: { channels: ['email'], followups: 'scheduled' } } : {}), route, linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: sending ? { 'email.send': RECIPE } : {}, followup_gap: [2] }));
  triage(H);
  const r = draftApprove(H);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  const ana = idOf(H, 'Ana Berg');
  return { H, ana, jobs: r.jobs };
}
// Message 1 (email) goes on Mon 12 through the guard.
function sendFirst(H, ana) {
  nobody(H, NOW);
  assert.ok(sendList(H, NOW).items.some((x) => x.id === ana && x.touch === 1));
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t1.json`), 'utf8'));
  assert.equal(guard(H, { to: 'ana@acme.test', subject: d.subject || '', body: d.body }, NOW).status, 0);
  const r = cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: ana, touch: 1, message_id: 'm1' }] })], NOW);
  assert.deepEqual(r.recorded, [`${ana}:1`]);
}

// 1. Two LinkedIn steps in a row.
test('route: an unsent LinkedIn step is never passed over for a later LinkedIn step', () => {
  const st = { sent: { 1: '2026-10-12' }, touches: { 1: {}, 2: { approved: { where: 'LinkedIn' } }, 3: { approved: { where: 'LinkedIn' } } } };
  const route = (t) => ['email', 'linkedin', 'linkedin'][t - 1];
  assert.equal(wentBefore(st, 3, route), 2, 'LinkedIn after LinkedIn waits for it');
  // A one-channel LinkedIn sequence (no route; every approval says LinkedIn) the same.
  assert.equal(wentBefore({ sent: { 1: '2026-10-12' }, touches: { 1: { approved: { where: 'LinkedIn' } }, 2: { approved: { where: 'LinkedIn' } }, 3: { approved: { where: 'LinkedIn' } } } }, 3, () => null), 2);
  // And an email after them is still not held.
  assert.equal(wentBefore({ ...st, touches: { ...st.touches, 4: {} } }, 4, (t) => ['email', 'linkedin', 'linkedin', 'email'][t - 1]), 1);
});

test('email, LinkedIn, LinkedIn: the second LinkedIn message is not due while the first is unticked, nor drafted after it', () => {
  const { H, ana } = world(['email', 'linkedin', 'linkedin']);
  sendFirst(H, ana);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, FRI);
  const html = page(H, FRI);
  const due = dueSection(html);
  assert.match(due, new RegExp(`data-id="${ana}" data-touch="2"`), 'the first LinkedIn message is due');
  assert.doesNotMatch(due, new RegExp(`data-id="${ana}" data-touch="3"`), 'one LinkedIn message a day, in order');
  assert.ok(!html.includes(`data-id="${ana}" data-touch="3"`), 'the second has no card yet');
});

test('by hand: email, LinkedIn, LinkedIn: the step after an unsent LinkedIn message is not drafted when it is LinkedIn too', () => {
  const { H, ana } = world(['email', 'linkedin', 'linkedin'], { sending: false });
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent it' }], NOW);
  draftApprove(H, at('2026-10-14'));
  const t = todoJobs(H, at('2026-10-19'));
  assert.ok(!t.jobs.some((j) => j.id === ana && j.touch === 3), JSON.stringify(t.jobs.map((j) => [j.id, j.touch])));
});

// 2. The approval and the route as it is now.
test('route: an old LinkedIn approval on a step the route no longer sends on LinkedIn is not passed over, nor dropped', () => {
  const st = { sent: { 1: '2026-10-12', 3: '2026-10-16' }, touches: { 1: {}, 2: { approved: { where: 'LinkedIn' } }, 3: {} } };
  for (const step of [() => 'email', () => 'app', () => null]) {
    assert.equal(wentBefore({ ...st, sent: { 1: '2026-10-12' } }, 3, step), 2);
    assert.equal(linkedInPassed(st, 2, step), false);
  }
  // Both say LinkedIn: passed over, and dropped once the email went.
  const li = (t) => (t === 2 ? 'linkedin' : 'email');
  assert.equal(wentBefore({ ...st, sent: { 1: '2026-10-12' } }, 3, li), 1);
  assert.equal(linkedInPassed(st, 2, li), true);
});

test('moved to email after the LinkedIn approval: the email after it is not sent past it, and nothing says "LinkedIn ... skipped"', () => {
  const { H, ana } = world(['email', 'linkedin', 'email']);
  sendFirst(H, ana);
  assert.ok(!cli(H, 'crm-triage', ['channel', '--event', H.slug, '--id', ana, '--to', 'email'], at('2026-10-13')).ERROR);
  nobody(H, FRI);
  const l = sendList(H, FRI);
  assert.ok(!l.items.some((x) => x.id === ana && x.touch === 3), JSON.stringify(l.items));
  assert.equal(hookOn(H, ana, 3, FRI).status, 2, 'the guard holds it too');
  assert.doesNotMatch(page(H, FRI), /LinkedIn message to Ana Berg: skipped/);
});

// 3. The day the next message is due.
test('on the next message\'s day the LinkedIn card says it goes today and to skip this one; not before', () => {
  const { H, ana } = world(['email', 'linkedin', 'email']);
  sendFirst(H, ana);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, at('2026-10-14'));
  const LINE = /The next message to Ana Berg goes today: skip this LinkedIn message\. It is dropped once that one goes\./;
  const wed = page(H, at('2026-10-14'));
  assert.doesNotMatch(wed, LINE, 'its own day: nothing else is due');
  const fri = page(H, FRI);
  assert.match(cardOf(fri, ana, 2), LINE);
  assert.match(dueSection(fri), LINE, 'in Due today too');
  assert.doesNotMatch(cardOf(fri, ana, 3), LINE, 'said on the LinkedIn card only');
});

test('ticked as sent anyway on that day: one message a day holds the email', () => {
  const { H, ana } = world(['email', 'linkedin', 'email']);
  sendFirst(H, ana);
  // The user sends the LinkedIn message on Fri 16 and ticks it (Copy status, pasted).
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, said: 'Sent on LinkedIn' }], FRI).applied, true);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, FRI);
  nobody(H, FRI);
  assert.ok(!sendList(H, FRI).items.some((x) => x.id === ana && x.touch === 3));
  const g = hookOn(H, ana, 3, FRI);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /already went or is going today/);
});

test('a LinkedIn message ticked as sent counts for the reply question from then: an older word about LinkedIn does not', () => {
  const { H, ana } = world(['email', 'linkedin', 'email']);
  sendFirst(H, ana);
  // Wed 14: the user's word that she hasn't replied on LinkedIn (before the LinkedIn message went).
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, at('2026-10-14'));
  // Thu 15: ticked as sent, the day it went.
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, said: 'Sent on LinkedIn today' }], at('2026-10-15')).applied, true);
  const MON = at('2026-10-19');
  nobody(H, MON);
  const g = hookOn(H, ana, 3, MON);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /weren't checked on every channel they were written to \(linkedin\)/);
  // Asked again after the LinkedIn message went: it goes.
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, MON);
  nobody(H, MON);
  assert.equal(hookOn(H, ana, 3, MON).status, 0);
});
