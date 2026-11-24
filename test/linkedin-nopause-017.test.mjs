// 0.1.7 spec section 12 (owner, 2026-11-22): a by-hand LinkedIn step never pauses the sequence. A later step goes on its
// planned day whether or not the LinkedIn message before it was recorded as sent; its spacing counts from the last
// message that really went; one message a day still holds. When the next step goes first, the unsent LinkedIn step is
// dropped: it leaves Due today, its CRM task is offered to close once, the outbox says "skipped: the next message went
// first", and it is never offered after. Holds, the reply check and the first-message rule (owner answer A1) still apply.
// Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { append, readLedger, fold, legacyState } from '../lib/ledger.mjs';
import { touchBefore, wentBefore, linkedInPassed } from '../lib/route.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const TASK = { server: 'crm-a', tool: 'create_task', reading: 'the id it returns', tool_hash: 'f'.repeat(64), test_draft: { draft_id: 't-test', user_confirmed: true }, args: { properties: { hs_task_subject: '{title}', hs_task_body: '{body}', hs_timestamp: '{due}' }, associations: [{ to: { id: '{contact_ref}' } }] } };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => {
  const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const log = (H) => join(H.dir, 'ledger.jsonl');
const state = (H) => legacyState(fold(readLedger(log(H)).entries));
const add = (H, e, now) => append(log(H), { who: 'user', said: 'noted', ...e }, new Date(now));
const guard = (H, input, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
// send-list as a session runs it: a reply check first (unless told not to), then the list.
function sendList(H, now, { check = true } = {}) {
  if (check) nobody(H, now);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug], now);
  assert.ok(!l.ERROR, l.ERROR);
  return { ...l, items: existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [] };
}
// The email of this step as the list would hold it, written to send-list.json, and the real guard on its send call.
function hookOn(H, id, touch, now, { check = true } = {}) {
  if (check) nobody(H, now);
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug], now);
  const listed = existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [];
  const it = listed.find((x) => x.id === id && x.touch === touch) || { id, touch, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now };
  if (!listed.includes(it)) writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([it]));
  return guard(H, { to: it.to, subject: it.subject, body: it.body }, now);
}
const receipt = (H, id, touch, now) => cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id, touch, message_id: `m${touch}` }] })], now);
// The email of this step goes: listed, let through by the guard, its receipt saved.
function sendEmail(H, id, touch, now) {
  const g = hookOn(H, id, touch, now);
  assert.equal(g.status, 0, g.stderr);
  const r = receipt(H, id, touch, now);
  assert.deepEqual(r.recorded, [`${id}:${touch}`], JSON.stringify(r));
}
const record = (H, items, now) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })], now);
const page = (H, now) => {
  const r = cli(H, 'event-outreach', ['render', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  return readFileSync(join(H.dir, 'outbox.html'), 'utf8');
};
const dueSection = (html) => (html.match(/<section class="queue" id="dueToday"[\s\S]*?<\/section>/) || [''])[0];

// Email, then LinkedIn by hand, then email. Gap 2 days: message 1 Mon 12 Oct, LinkedIn Wed 14, email Fri 16.
function world({ route = ['email', 'linkedin', 'email'], tasks = false, sending = true } = {}) {
  const H = setup({ attendees: PEOPLE, settings: { ...(sending ? { sending: { channels: ['email'], followups: 'scheduled' } } : {}), route, linkedin_messages: true, ...(tasks ? { crm_log: 'tasks' } : {}) } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, ...(tasks ? { 'crm.create_task': TASK } : {}) }, followup_gap: [2] }));
  triage(H);
  const r = draftApprove(H);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  const ana = idOf(H, 'Ana Berg');
  return { H, ana, jobs: r.jobs };
}
function started(opts) {
  const w = world(opts);
  assert.deepEqual(
    w.jobs.filter((j) => j.kind === 'message').map((j) => [j.touch, j.channel, j.planned_due ?? null]),
    [
      [1, 'email', null],
      [2, 'paste', '2026-10-14'],
      [3, 'email', '2026-10-16']
    ],
    'the plan these tests are written for'
  );
  sendEmail(w.H, w.ana, 1, NOW);
  return w;
}
const FRI = at('2026-10-16');

test('route: an unsent LinkedIn step is passed over; spacing counts from the step that went; a skipped step still is', () => {
  const li = (t) => (t === 2 ? 'linkedin' : 'email');
  const st = { sent: { 1: '2026-10-12' }, touches: { 1: {}, 2: { approved: { where: 'LinkedIn' } }, 3: {} } };
  assert.equal(touchBefore(st, 3), 2, 'the old rule is kept for drafting: the step before it');
  assert.equal(wentBefore(st, 3, li), 1, 'the LinkedIn step that has not gone is passed over');
  assert.equal(wentBefore({ ...st, sent: { 1: '2026-10-12', 2: '2026-10-14' } }, 3, li), 2, 'one that went is counted from');
  // An email that hasn't gone is never passed over.
  assert.equal(wentBefore({ sent: {}, touches: {} }, 3, () => 'email'), 2);
  // A route that starts on LinkedIn and that message hasn't gone: nothing before it is left, it is the first message
  // (rule A1; owner, 0.1.7 section 12b, which replaced the earlier fallback to the step before it).
  assert.equal(wentBefore({ sent: {}, touches: { 1: {} } }, 2, (t) => (t === 1 ? 'linkedin' : 'email')), 0);
  assert.equal(wentBefore({ sent: {}, touches: { 1: { skipped: true } } }, 2, () => 'email'), 0, 'a skipped step as before');
  // Dropped once a later step went, and only then; never a step that went, nor an email.
  assert.equal(linkedInPassed(st, 2, li), false);
  assert.equal(linkedInPassed({ ...st, sent: { 1: '2026-10-12', 3: '2026-10-16' } }, 2, li), true);
  assert.equal(linkedInPassed({ ...st, sent: { 1: '2026-10-12', 2: '2026-10-14', 3: '2026-10-16' } }, 2, li), false);
  assert.equal(linkedInPassed({ sent: { 3: '2026-10-16' }, touches: {} }, 2, () => 'email'), false);
});

test('a LinkedIn step never marked sent: the next email passes the send check on its planned day, not before', () => {
  const { H, ana } = started();
  // Thu 15: not due yet (planned Fri 16).
  const thu = sendList(H, at('2026-10-15'));
  assert.ok(!thu.items.some((x) => x.id === ana && x.touch === 3), JSON.stringify(thu.items));
  // Fri 16: listed, and the guard lets it through.
  const fri = sendList(H, FRI);
  assert.ok(fri.items.some((x) => x.id === ana && x.touch === 3), JSON.stringify(fri.waiting));
  assert.ok(!(fri.waiting || []).some((w) => /hasn't gone/.test(w.why)), JSON.stringify(fri.waiting));
  const g = hookOn(H, ana, 3, FRI);
  assert.equal(g.status, 0, g.stderr);
});

test('spacing counts from the last message that really went: a LinkedIn message ticked late moves the email on', () => {
  const { H, ana } = started();
  // The user sent the LinkedIn message on Thu 15 and ticked it.
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-15', said: 'I sent it on LinkedIn yesterday' }], FRI).applied, true);
  // She was written to on LinkedIn: the user's word that she hasn't replied there.
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, FRI);
  // Fri 16 is one day after it: the email waits for its gap (2 days, off the weekend: Mon 19).
  const fri = sendList(H, FRI);
  assert.ok(!fri.items.some((x) => x.id === ana && x.touch === 3), JSON.stringify(fri.items));
  const g = hookOn(H, ana, 3, FRI);
  assert.equal(g.status, 2, 'the guard holds it too');
  assert.match(g.stderr, /isn't due until/);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, at('2026-10-19'));
  const mon = sendList(H, at('2026-10-19'));
  assert.ok(mon.items.some((x) => x.id === ana && x.touch === 3), JSON.stringify(mon.waiting));
});

test('spacing counts from the last message that really went: message 1 sent late, the LinkedIn step unsent', () => {
  const { H, ana } = world();
  // Message 1 goes on Thu 15 instead of Mon 12.
  sendEmail(H, ana, 1, at('2026-10-15'));
  const fri = sendList(H, FRI);
  assert.ok(!fri.items.some((x) => x.id === ana && x.touch === 3), 'one day after message 1: too close');
  const g = hookOn(H, ana, 3, FRI);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /isn't due until/);
  assert.ok(sendList(H, at('2026-10-19')).items.some((x) => x.id === ana && x.touch === 3));
});

test('one message a day still holds: the LinkedIn message ticked as sent today keeps the email to another day', () => {
  const { H, ana } = started();
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-16', said: 'sent it on LinkedIn this morning' }], FRI).applied, true);
  const fri = sendList(H, FRI);
  assert.ok(!fri.items.some((x) => x.id === ana && x.touch === 3));
  const g = hookOn(H, ana, 3, FRI);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /already went or is going today/);
});

test('the reply check, a reply and a stop still hold the email after an unsent LinkedIn step', () => {
  const { H, ana } = started();
  // No reply check before the send: refused.
  const g = hookOn(H, ana, 3, FRI, { check: false });
  assert.equal(g.status, 2);
  assert.match(g.stderr, /replies weren't checked/);
  // A reply: nothing more goes.
  add(H, { type: 'replied', id: ana, source: 'user' }, FRI);
  const l = sendList(H, FRI);
  assert.ok(!l.items.length);
  assert.ok((l.waiting || []).some((w) => w.touch === 3 && /replied/.test(w.why)), JSON.stringify(l.waiting));
  assert.equal(hookOn(H, ana, 3, FRI).status, 2);
});

test('a stop holds it the same way', () => {
  const { H, ana } = started();
  add(H, { type: 'stop', id: ana, source: 'user' }, FRI);
  const l = sendList(H, FRI);
  assert.ok(!l.items.length, JSON.stringify(l.items));
  assert.equal(hookOn(H, ana, 3, FRI).status, 2);
});

// Owner, 0.1.7 section 12b, supersedes this test's first answer (that the email stays held): the follow-up text never goes,
// and on its own day the email is written again as a first message for the next approval
// (test/linkedin-nopause-017b.test.mjs takes it through to the send).
test('the first-message rule (A1) holds: LinkedIn message 1 never sent, the email written as its follow-up does not go; it is written again', () => {
  const { H, ana } = world({ route: ['linkedin', 'email'] });
  const l = sendList(H, at('2026-10-20'));
  assert.ok(!l.items.some((x) => x.id === ana && x.touch === 2), JSON.stringify(l.items));
  const g = hookOn(H, ana, 2, at('2026-10-20'));
  assert.equal(g.status, 2, 'its text was written as a follow-up to a message that never went');
  const j = todoJobs(H, at('2026-10-20')).jobs.find((x) => x.id === ana && x.touch === 2);
  assert.equal(j?.followup, false, 'offered again as a first message');
});

test('the outbox: both are offered while the LinkedIn step is unsent; once the email went, the LinkedIn step is dropped', () => {
  const { H, ana } = started();
  // The user said she hasn't replied on LinkedIn (asked once before a LinkedIn follow-up is listed as due).
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, at('2026-10-14'));
  // Wed 14: the LinkedIn message is due today.
  assert.match(dueSection(page(H, at('2026-10-14'))), /Ana Berg/);
  // Fri 16, nothing ticked: still due (overdue), and the email is on the page too.
  const fri = page(H, FRI);
  assert.match(dueSection(fri), /Ana Berg/);
  assert.ok(fri.includes(`data-id="${ana}" data-touch="3"`), 'the email card is on the page');
  assert.ok(fri.includes(`data-id="${ana}" data-touch="2"`), 'and the LinkedIn one');
  sendEmail(H, ana, 3, FRI);
  const after = page(H, FRI);
  assert.doesNotMatch(dueSection(after), /Ana Berg/, 'gone from Due today');
  assert.match(after, /skipped: the next message went first/);
  // Never offered again, on any day after.
  assert.doesNotMatch(dueSection(page(H, at('2026-10-19'))), /Ana Berg/);
  const due = cli(H, 'event-outreach', ['linkedin-due', '--event', H.slug], at('2026-10-19'));
  assert.ok(!due.ERROR, due.ERROR);
  assert.deepEqual(due.ask, []);
  // The send check never lets it go (floorboss never sends LinkedIn, and a later message went).
  assert.ok(!state(H)[ana].sent?.[2]);
});

test('the dropped LinkedIn step is drafted for no one: drafting moves on, it is never offered after the later message', () => {
  const { H, ana } = started();
  sendEmail(H, ana, 3, FRI);
  const t = todoJobs(H, at('2026-10-19'));
  assert.ok(!t.jobs.some((j) => j.id === ana && j.touch === 2), JSON.stringify(t.jobs.map((j) => [j.id, j.touch])));
});

test('by hand (sending off): once the LinkedIn message is approved and unsent, the email after it is drafted on its day', () => {
  const H = setup({ attendees: PEOPLE, settings: { route: ['email', 'linkedin', 'email'], linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: {}, followup_gap: [2] }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent it' }], NOW);
  // Message 2 (LinkedIn) is drafted and approved on its day.
  const r = draftApprove(H, at('2026-10-14'));
  assert.deepEqual(r.jobs.filter((j) => j.kind === 'message').map((j) => j.touch), [2]);
  // Not ticked. On Fri 16 the email after it is drafted, as a follow-up.
  const t = todoJobs(H, FRI);
  const j = t.jobs.find((x) => x.id === ana && x.kind === 'message');
  assert.equal(j?.touch, 3, JSON.stringify(t.jobs.map((x) => [x.id, x.touch])));
  // Drafted, read and approved, it is on the page with the LinkedIn one.
  const d = draftFor({ ...t.t, insights: t.insights }, { ...j, slot_labels: j.slot_labels || [] });
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '3', '--json', JSON.stringify({ subject: 'Test Expo', body: d.body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], FRI);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '3', '--text', 'PASS'], FRI);
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], FRI).ERROR);
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'linkedin' }, FRI);
  const html = page(H, FRI);
  assert.match(dueSection(html), /Ana Berg/, 'the LinkedIn one is still due');
  assert.ok(html.includes(d.body.split('\n')[0]), 'the email is on the page');
});

// Staging into the mailbox's drafts folder keeps the guard's rule (hooks/guard/sends.mjs stageRefusal, unchanged here):
// a follow-up goes in only after the step before it went. The list never offers what the guard refuses.
test('stage-list never lists a draft the guard would refuse as "the message before it hasn\'t gone"', () => {
  const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'c'.repeat(64), test_draft: { draft_id: 't2', user_confirmed: true } };
  const H = setup({ attendees: PEOPLE, settings: { route: ['email', 'linkedin', 'email'], linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE }, followup_gap: [2] }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent it' }], NOW);
  draftApprove(H, at('2026-10-14'));
  const t = todoJobs(H, FRI);
  const j = t.jobs.find((x) => x.id === ana && x.kind === 'message');
  assert.equal(j?.touch, 3);
  const d = draftFor({ ...t.t, insights: t.insights }, { ...j, slot_labels: j.slot_labels || [] });
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '3', '--json', JSON.stringify({ subject: 'Test Expo', body: d.body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], FRI);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '3', '--text', 'PASS'], FRI);
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], FRI).ERROR);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], FRI);
  assert.ok(!sl.ERROR, sl.ERROR);
  const listed = existsSync(sl.file || '') ? JSON.parse(readFileSync(sl.file, 'utf8')) : [];
  process.env.FLOORBOSS_HOME = H.HOME;
  const item = { id: ana, touch: 3, to: 'ana@acme.test', kind: 'message', subject: 'Test Expo', body: d.body, listed_at: FRI };
  const refused = stageRefusal(H.dir, item, Date.parse(FRI));
  if (refused === "the message before it hasn't gone") assert.ok(!listed.some((x) => x.id === ana && x.touch === 3), JSON.stringify(listed));
  else assert.ok(listed.some((x) => x.id === ana && x.touch === 3), `the guard would take it (${refused}), so the list offers it`);
});

// CRM tasks.
const tasks = (H, now) => {
  const r = cli(H, 'event-outreach', ['task-list', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  return JSON.parse(readFileSync(r.file, 'utf8'));
};
const made = (H, items, now) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', `tc-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ tasks: items.map((i) => ({ key: i.key, task_id: `T-${i.key}` })) }));
  const r = cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', f], now);
  assert.ok(!r.ERROR && !r.errors, JSON.stringify(r));
};

test('the CRM task of the dropped LinkedIn step is offered to close once, and no new one is made', () => {
  const { H, ana } = started({ tasks: true });
  const send = tasks(H, at('2026-10-13')).filter((i) => i.kind === 'send');
  assert.deepEqual(send.map((i) => [i.touch, i.due]), [[2, '2026-10-14']], JSON.stringify(send));
  made(H, send, at('2026-10-13'));
  // Before the email goes: nothing to close.
  assert.equal(tasks(H, FRI).filter((i) => i.kind === 'review').length, 0);
  sendEmail(H, ana, 3, FRI);
  const after = tasks(H, FRI);
  assert.equal(after.filter((i) => i.kind === 'send').length, 0, 'no task to send it');
  const close = after.filter((i) => i.kind === 'review' && /close/i.test(i.body));
  assert.equal(close.length, 1, JSON.stringify(after));
  assert.match(close[0].body, /skipped: the next message went first/);
  assert.match(page(H, FRI), /skipped: the next message went first[^<]*close the task/i);
  made(H, close, FRI);
  // Asked once: made, it isn't asked again.
  assert.equal(tasks(H, at('2026-10-19')).filter((i) => i.kind === 'review').length, 0);
  assert.equal(tasks(H, at('2026-10-20')).filter((i) => i.kind === 'review').length, 0);
});
