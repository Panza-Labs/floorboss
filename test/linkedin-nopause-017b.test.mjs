// 0.1.7 spec section 12b (owner answers, 2026-11-23).
// 1. The guard follows: with unattended drafts on, a follow-up whose step before it is a by-hand LinkedIn message that
//    hasn't gone goes into the drafts folder on its day, through the routine (scripts/scheduled.mjs), the run's stage
//    list and the guard (hooks/guard/unattended.mjs, hooks/guard/sends.mjs stageRefusal). Every other check stays:
//    spacing from the last real send, one a day, replies, stops, holds. stage-list, send-list and the guard agree.
// 2. A route that starts on LinkedIn, and LinkedIn message 1 never goes: the email after it follows rule A1. On its own
//    planned day it is written again as a first message, for the next approval, and goes; never as a follow-up to
//    nothing.
// Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { world, clone, ticket, start, readMail, inRun, afterRun, text, MAIL_OK, ANA, NOW } from './fixtures/unattended-world.mjs';
import { setup, cli, triage, draftApprove, todoJobs, idOf, ROOT } from './fixtures/harness.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { draftFor } from './sims/lib/driver.mjs';

const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const add = (H, e, now) => appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: now, who: 'user', said: 'noted', ...e })}\n`);
const WED = at('2026-10-14');
const THU = at('2026-10-15');

// Email Mon 12 (sent, with its prompt), LinkedIn by hand Tue 13 (never ticked), email Wed 14: authorised for the drafts.
const BASE = world({ route: ['email', 'linkedin', 'email'], people: PEOPLE });

function due(H, now) {
  const was = [process.env.FLOORBOSS_HOME, process.env.FLOORBOSS_NOW];
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = now;
  try {
    return followupsDue(Date.parse(now));
  } finally {
    [process.env.FLOORBOSS_HOME, process.env.FLOORBOSS_NOW] = was;
    if (was[0] === undefined) delete process.env.FLOORBOSS_HOME;
    if (was[1] === undefined) delete process.env.FLOORBOSS_NOW;
  }
}
// The follow-up due on Wed 14, as the routine lists it (the base world, nothing changed): every refusal below is of it.
function dueItem(H) {
  const items = due(H, WED).items;
  assert.equal(items.length, 1, `due on Wed 14: ${JSON.stringify(items)}`);
  return items[0];
}
// The run's stage list (as stageItem in the fixture, for message 3).
function runList(H, t, now) {
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  try {
    const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug, '--unattended'], now);
    assert.ok(sl.file, JSON.stringify(sl));
    return JSON.parse(readFileSync(sl.file, 'utf8'));
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
}
const draftCall = (it) => ({ to: it.to, subject: it.subject, body: it.body, threadId: it.reply_in_thread });
// The item the authorisation names, as a run's list would hold it (for a call the list didn't offer).
function authorisedItem(H, now) {
  const a = readFileSync(join(H.HOME, 'unattended', 'authorised.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.touch === 3);
  const d = JSON.parse(readFileSync(join(H.dir, 'drafts', `${a.hash}.json`), 'utf8'));
  return { id: a.id, touch: 3, to: a.to, subject: d.subject || '', body: d.body, reply_in_thread: 'T1', listed_at: now };
}
// The draft call for the authorised item, written to the run's stage list first (as a list made before the change
// would hold it), so the guard judges the call on its own rules, not on "not listed".
function callListed(H, t, now) {
  const it = { ...authorisedItem(H, now), reply_to_message_id: null };
  writeFileSync(join(H.dir, 'stage-list.json'), JSON.stringify([it]));
  return inRun(H, t, 'mcp__mail__create_draft', draftCall(it), { now });
}
const refused = (r, re) => {
  assert.equal(r.code, 2, `expected a refusal, got ${r.code} ${r.decision} ${r.stderr}`);
  assert.notEqual(r.decision, 'allow');
  assert.doesNotMatch(r.stderr, /isn't one floorboss listed/, 'refused on its own rules, not for want of a listing');
  if (re) assert.match(r.stderr, re);
};

test('routine: the email after an unsent LinkedIn step is due on its day, listed by the run, and the guard lets its draft in', async () => {
  const H = clone(BASE);
  assert.deepEqual(due(H, at('2026-10-13')).items.map((x) => x.touch), [], 'not before its day');
  const d = due(H, WED);
  assert.deepEqual(d.items.map((x) => [x.id, x.touch]), [[H.ana, 3]], JSON.stringify(d));
  const t = await ticket(H, { now: WED, items: d.items });
  assert.equal(start(H, t, { now: WED }).code, 0);
  const m = readMail(H, t, MAIL_OK, { now: WED });
  assert.equal(m.pre.decision, 'allow', m.pre.stderr);
  const it = runList(H, t, WED).find((x) => x.id === H.ana && x.touch === 3);
  assert.ok(it, 'the run lists it');
  assert.equal(it.reply_in_thread, 'T1', 'in the thread of message 1');
  const pre = inRun(H, t, 'mcp__mail__create_draft', draftCall(it), { now: WED, id: 'tu-d3' });
  assert.equal(pre.decision, 'allow', pre.stderr);
  afterRun(H, t, 'mcp__mail__create_draft', draftCall(it), text({ id: 'd3', message: { id: 'm3', threadId: 'T1' } }), { now: WED, id: 'tu-d3' });
  const led = readLedger(join(H.dir, 'ledger.jsonl')).entries;
  assert.ok(led.some((e) => e.type === 'staged' && e.touch === 3 && e.unattended === true));
});

// What the run's guard still refuses, each alone, on a fresh copy.
async function inRunOn(H, now, { mail = MAIL_OK } = {}) {
  const items = [dueItem(H)];
  const t = await ticket(H, { now, items });
  start(H, t, { now });
  const m = readMail(H, t, mail, { now });
  return { t, m, call: callListed(H, t, now) };
}

test('routine: a reply in the mailbox holds it', async () => {
  const H = clone(BASE);
  const r = await inRunOn(H, WED, { mail: { messages: [...MAIL_OK.messages, { id: 'm9', threadId: 'T1', from: `Ana Berg <${ANA}>`, date: '2026-10-13T15:00:00Z' }] } });
  refused(r.call, /came in from them/);
});

test('routine: a stop, a reply recorded and a hold each refuse it, and the routine lists nothing', async () => {
  for (const e of [{ type: 'stop', id: 'c001', source: 'user' }, { type: 'replied', id: 'c001', source: 'user' }, { type: 'decide', id: 'c001', group: 'colleague', because: 'Pat owns the account' }]) {
    const H = clone(BASE);
    const items = [dueItem(H)];
    add(H, e, at('2026-10-13'));
    assert.deepEqual(due(H, WED).items, [], e.type);
    const t = await ticket(H, { now: WED, items });
    start(H, t, { now: WED });
    readMail(H, t, MAIL_OK, { now: WED });
    refused(callListed(H, t, WED), { stop: /said stop/, replied: /replied/, decide: /a colleague holds them/ }[e.type]);
  }
});

test('routine: too early is refused: on Tue 13 nothing is due, and the draft call is refused', async () => {
  const H = clone(BASE);
  const items = [dueItem(H)];
  const TUE = at('2026-10-13');
  assert.deepEqual(due(H, TUE).items, []);
  const t = await ticket(H, { now: TUE, items });
  start(H, t, { now: TUE });
  readMail(H, t, MAIL_OK, { now: TUE });
  refused(callListed(H, t, TUE), /isn't due until Wednesday 14 October/);
});

test('routine: spacing counts from the last real send: the LinkedIn message ticked on Wed 14 moves the email to Thu 15', () => {
  const H = clone(BASE);
  add(H, { type: 'sent', id: H.ana, touch: 2, date: '2026-10-14', via: 'outbox', channel: 'LinkedIn' }, at('2026-10-14', '07:00'));
  assert.deepEqual(due(H, WED).items, []);
  assert.deepEqual(due(H, THU).items.map((x) => x.touch), [3], 'its gap after the LinkedIn message');
});

test('routine: one message a day: the LinkedIn message ticked as sent today refuses the draft today', async () => {
  const H = clone(BASE);
  const items = [dueItem(H)];
  add(H, { type: 'sent', id: H.ana, touch: 2, date: '2026-10-14', via: 'outbox', channel: 'LinkedIn' }, at('2026-10-14', '07:00'));
  assert.deepEqual(due(H, WED).items, []);
  const t = await ticket(H, { now: WED, items });
  start(H, t, { now: WED });
  readMail(H, t, MAIL_OK, { now: WED });
  refused(callListed(H, t, WED), /isn't due until Thursday 15 October|already went or is going today/);
});

// The attended staging check (hooks/guard/sends.mjs stageRefusal) and stage-list agree.
function handStaging() {
  const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'c'.repeat(64), test_draft: { draft_id: 't2', user_confirmed: true } };
  const H = setup({ attendees: PEOPLE, settings: { route: ['email', 'linkedin', 'email'], linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE }, followup_gap: [2] }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', writeTmp(H, { items: [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent it' }] })], NOW);
  draftApprove(H, at('2026-10-14'));
  const FRI = at('2026-10-16');
  const t = todoJobs(H, FRI);
  const j = t.jobs.find((x) => x.id === ana && x.kind === 'message');
  const d = draftFor({ ...t.t, insights: t.insights }, { ...j, slot_labels: j.slot_labels || [] });
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '3', '--json', JSON.stringify({ subject: 'Test Expo', body: d.body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], FRI);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '3', '--text', 'PASS'], FRI);
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], FRI).ERROR);
  return { H, ana, FRI };
}
const writeTmp = (H, data) => {
  const f = join(H.dir, `t${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
function listed(H, now) {
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], now);
  assert.ok(!sl.ERROR, sl.ERROR);
  return existsSync(sl.file || '') ? JSON.parse(readFileSync(sl.file, 'utf8')) : [];
}
const refusal = (H, it, now) => {
  process.env.FLOORBOSS_HOME = H.HOME;
  return stageRefusal(H.dir, { ...it, listed_at: now }, Date.parse(now));
};

test('staging by hand: stage-list lists the email after an unsent LinkedIn step on its day, and the guard takes it', () => {
  const { H, ana, FRI } = handStaging();
  const it = listed(H, FRI).find((x) => x.id === ana && x.touch === 3);
  assert.ok(it, 'listed on its day');
  assert.equal(refusal(H, it, FRI), null);
});

test('staging by hand: spacing from the last real send, and one a day, still refuse it', () => {
  for (const [day, re] of [['2026-10-15', /isn't due until/], ['2026-10-16', /already went or is going today|isn't due until/]]) {
    const { H, ana, FRI } = handStaging();
    const it = listed(H, FRI).find((x) => x.id === ana && x.touch === 3);
    assert.ok(it, 'listed before the LinkedIn message is ticked');
    // The LinkedIn message ticked as sent: Thu 15 (one day before; the gap is 2) or Fri 16 (today).
    add(H, { type: 'sent', id: ana, touch: 2, date: day, via: 'outbox', channel: 'LinkedIn' }, `${day}T07:00:00Z`);
    assert.match(refusal(H, it, FRI) || '', re, day);
    assert.ok(!listed(H, FRI).some((x) => x.touch === 3), day);
  }
});

test('staging by hand: a reply, a stop and a hold refuse it', () => {
  for (const e of [{ type: 'replied', id: 'c001', source: 'user' }, { type: 'stop', id: 'c001', source: 'user' }, { type: 'decide', id: 'c001', group: 'colleague', because: 'Pat owns the account' }]) {
    const { H, ana, FRI } = handStaging();
    const it = listed(H, FRI).find((x) => x.id === ana && x.touch === 3);
    assert.ok(it, 'listed before the change');
    assert.equal(refusal(H, it, FRI), null, 'taken before the change');
    add(H, e, FRI);
    assert.ok(refusal(H, it, FRI), e.type);
    assert.ok(!listed(H, FRI).some((x) => x.touch === 3), e.type);
  }
});

// 2. A route that starts on LinkedIn.
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const guard = (H, input, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
function liFirst() {
  const H = setup({ attendees: PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'email'], linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, followup_gap: [2] }));
  triage(H);
  const r = draftApprove(H);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  const ana = idOf(H, 'Ana Berg');
  assert.deepEqual(r.jobs.filter((j) => j.kind === 'message').map((j) => [j.touch, j.channel, j.planned_due ?? null]), [[1, 'paste', null], [2, 'email', WED]].map(([a, b, c]) => [a, b, c && c.slice(0, 10)]));
  return { H, ana };
}
const sendList = (H, now) => {
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug], now);
  assert.ok(!l.ERROR, l.ERROR);
  return { ...l, items: existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [] };
};

test('LinkedIn first, never sent: before its day the email is not rewritten and does not go', () => {
  const { H, ana } = liFirst();
  const t = todoJobs(H, at('2026-10-13'));
  assert.ok(!t.jobs.some((j) => j.id === ana && j.touch === 2), JSON.stringify(t.jobs.map((j) => [j.touch, j.followup])));
  assert.ok(!sendList(H, at('2026-10-13')).items.length);
});

test('LinkedIn first, never sent: on its own day the email is written again as a first message, approved, and goes', () => {
  const { H, ana } = liFirst();
  // Its day: the follow-up text never goes.
  const before = sendList(H, WED);
  assert.ok(!before.items.some((x) => x.id === ana && x.touch === 2), JSON.stringify(before.items));
  const old = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t2.json`), 'utf8'));
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([{ id: ana, touch: 2, name: 'Ana Berg', via: 'email.send', to: ANA, subject: old.subject || '', body: old.body, listed_at: WED }]));
  assert.equal(guard(H, { to: ANA, subject: old.subject || '', body: old.body }, WED).status, 2, 'the guard never lets the follow-up text go as a first message');
  // Drafting offers it again, as a first message, for the next approval.
  const t = todoJobs(H, WED);
  const j = t.jobs.find((x) => x.id === ana && x.touch === 2);
  assert.ok(j, JSON.stringify(t.jobs.map((x) => [x.id, x.touch])));
  assert.equal(j.followup, false, 'a first message, not a follow-up to nothing');
  const d = draftFor({ ...t.t, insights: t.insights }, { ...j, slot_labels: j.slot_labels || [] });
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x, no research profile', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], WED);
  const saved = readLedger(join(H.dir, 'ledger.jsonl')).entries.filter((e) => e.type === 'drafted' && e.touch === 2).pop();
  assert.ok(!saved.previous_hash && !Object.values(saved.before_hashes || {}).some(Boolean), 'written against no earlier text');
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS'], WED);
  assert.ok(!cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], WED).ERROR);
  // Approved, it goes today (its day): listed, and the guard lets it through.
  const l = sendList(H, WED);
  const it = l.items.find((x) => x.id === ana && x.touch === 2);
  assert.ok(it, JSON.stringify(l.waiting));
  assert.equal(guard(H, { to: it.to, subject: it.subject, body: it.body }, WED).status, 0);
  // Drafting doesn't offer it again.
  assert.ok(!todoJobs(H, WED).jobs.some((x) => x.id === ana && x.touch === 2));
});
