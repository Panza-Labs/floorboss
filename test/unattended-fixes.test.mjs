// The review of the unattended email drafts build (2026-11-14): one test per confirmed finding, each failing on the
// code before its fix. Through the real guard, flow and launcher in throwaway homes, as the other unattended tests do;
// nothing here starts Claude Code, launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { world, clone, ticket, start, readMail, readCrm, stageItem, stage, draftInput, inRun, hook, logOf, ledgerOf, text, bashCall, scriptCmd, MAIL_OK, OWN, ANA, BO, ROOT, NOW, D13 } from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { mailWitness, crmWitness } from '../hooks/guard/witness.mjs';
import { readSince, buildSummary, unclearDrafts, unseen, otherChannelPeople, authorisable, timeAt } from '../lib/unattended-drafts.mjs';
import { argsRefusal, claudeRun } from '../lib/unattended.mjs';
import { scheduleRefusal } from '../hooks/guard.mjs';
import { optinReason } from '../hooks/guard/unattended.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';
import { loadEvent } from '../lib/event.mjs';
import { loadConfig } from '../lib/config.mjs';

const BASE = world();
const BASE_CRM = world({ crm: true });
const BASE_ITEMS = (await ticket(clone(BASE))).items;
const CRM_ITEMS = (await ticket(clone(BASE_CRM))).items.map((x) => ({ ...x, crm_id: '101' }));
// Two people (Ana, thread T1; Bo, thread T2), for the rules that are about which person a call is for.
const BASE2 = world({ two: true });
const BASE2_ITEMS = (await ticket(clone(BASE2))).items;
const BO_MAIL = { messages: [{ id: 'mb1', threadId: 'T2', from: OWN, to: BO, date: '2026-10-12T09:00:00Z', subject: 'Test Expo' }] };
const D14 = '2026-10-14T08:00:00Z';
const edit = (p, fn) => writeFileSync(p, fn(readFileSync(p, 'utf8')));
const un = (H, ...p) => join(H.HOME, 'unattended', ...p);
const stoppedAt = (H, t) => existsSync(un(H, 'stopped', `${t.session}.json`));
const refused = (r, re) => {
  assert.equal(r.code, 2, `expected a refusal, got ${r.code} ${r.decision} ${r.stderr}`);
  assert.equal(r.decision, null, 'never allow or ask');
  if (re) assert.match(r.stderr, re);
};
async function ready(H, { now = H.now, mail = MAIL_OK, items = BASE_ITEMS } = {}) {
  const t = await ticket(H, { now, items });
  assert.equal(start(H, t, { now }).code, 0);
  const m = readMail(H, t, mail, { now });
  return { t, m };
}
// floorboss's own code, run in this process against a throwaway home.
function inHome(H, fn) {
  const was = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = was;
  }
}
const setRead = (H, args) => edit(join(H.HOME, 'config.json'), (s) => {
  const c = JSON.parse(s);
  c.connectors['email.messages'] = { ...c.connectors['email.messages'], args };
  return JSON.stringify(c);
});
const reply = { messages: [...MAIL_OK.messages, { id: 'r1', threadId: 'T1', from: `Ana Berg <${ANA}>`, date: '2026-10-12T15:00:00Z' }] };
// The launcher as launchd starts it (scripts/scheduled.mjs followups), with a stand-in for Claude Code.
function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'fb-fix-claude-'));
  const p = join(dir, 'claude');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
}
const launch = (H, now, extra = {}) => {
  const env = { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_TEST: '1', FLOORBOSS_CLAUDE: fakeClaude(), ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.FLOORBOSS_UNATTENDED;
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'scheduled.mjs'), 'followups'], { env, encoding: 'utf8', timeout: 60000 });
};

test('A1/B4: a mailbox read the model narrowed is refused and stops the run; only the recipe filled with the run\'s own values passes', async () => {
  for (const [name, input] of [
    ['a later time on the day', { address: ANA, since: '2026-10-12T23:59:59Z' }],
    ['text after the day', { address: ANA, since: '2026-10-11 -from:ana@acme.test' }],
    ['a later day', { address: ANA, since: '2026-10-12' }],
    ['the day left out', { address: ANA }]
  ]) {
    const H = clone(BASE);
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    refused(inRun(H, t, 'mcp__mail__list_messages', input), /the read for c001 isn't the one floorboss lists .*it could miss their answer/);
    assert.ok(stoppedAt(H, t), `${name}: the run stopped`);
    refused(readMail(H, t).pre, /stopped earlier/);
  }
  // A recipe that names the thread: another conversation is refused; the run's own thread passes.
  {
    const H = clone(BASE);
    setRead(H, { address: '{email}', since: '{since}', conversationId: '{thread_id}' });
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    refused(inRun(H, t, 'mcp__mail__list_messages', { address: ANA, since: '2026-10-11', conversationId: 'T-some-other-conversation' }), /"conversationId" isn't as floorboss lists it/);
    const H2 = clone(BASE);
    setRead(H2, { address: '{email}', since: '{since}', conversationId: '{thread_id}' });
    const t2 = await ticket(H2, { items: BASE_ITEMS });
    start(H2, t2);
    assert.equal(inRun(H2, t2, 'mcp__mail__list_messages', { address: ANA, since: '2026-10-11', conversationId: 'T1' }).decision, 'allow');
  }
  // A placeholder an unattended run has no value of its own for ({query}) is never the model's to fill.
  {
    const H = clone(BASE);
    setRead(H, { address: '{email}', since: '{since}', q: '{query}' });
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    refused(inRun(H, t, 'mcp__mail__list_messages', { address: ANA, since: '2026-10-11', q: 'in:spam subject:zzzz-nothing' }), /its recipe needs \{query\}, which an unattended run has no value for/);
  }
  // A literal of the recipe left out (a page size, a folder) is refused too: nothing is left out.
  {
    const H = clone(BASE);
    setRead(H, { address: '{email}', since: '{since}', maxResults: 500 });
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    refused(inRun(H, t, 'mcp__mail__list_messages', { address: ANA, since: '2026-10-11' }), /"maxResults" is left out/);
  }
});

test('A2/B4: a reply the guard saw stays seen for the run: a later read without it never lets the draft in', async () => {
  const H = clone(BASE);
  const { t } = await ready(H, { mail: reply });
  assert.equal(JSON.parse(readFileSync(un(H, 'witness', t.session, 'ev--c001.mail.json'), 'utf8')).inbound, 1);
  // The same read again, its answer without the reply (a moved message, or a server whose answer changed).
  const again = readMail(H, t, MAIL_OK);
  assert.equal(again.pre.decision, 'allow');
  assert.equal(JSON.parse(readFileSync(un(H, 'witness', t.session, 'ev--c001.mail.json'), 'utf8')).inbound, 0, 'the latest witness is clean');
  refused(stage(H, t, stageItem(H, t), { post: false }).pre, /earlier in this run floorboss saw 1 message in from them or someone else in your mailbox: it waits for you/);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
});

test('A3/B5/B6/C11: what the CRM shows from the contact holds by code; the user\'s own hand-written email and a backdated log line are seen', () => {
  const since = Date.parse('2026-10-11T00:00:00Z');
  const ours = [{ day: '2026-10-12', subject: 'At the summit' }];
  const opts = { contact: ANA, own: [OWN], sinceMs: since, ours };
  const blocks = (v) => text(v);
  const hub = (id, type, from, at, subject = '', extra = {}) => ({ id: String(id), engagement: { type, timestamp: Date.parse(at), ...(extra.createdAt ? { createdAt: extra.createdAt } : {}) }, metadata: { subject, text: extra.text || '', from: { email: from }, to: [] } });
  const w = (results) => crmWitness(blocks({ total: results.length, results }), opts);
  const kind = (a) => w([a]).activities[0]?.kind;
  // A3: a logged LinkedIn message, an SMS, a chat, a WhatsApp, a call with no direction: from them, by code.
  for (const type of ['LINKEDIN_MESSAGE', 'SMS', 'CONVERSATION_SESSION', 'CALL', 'WHATS_APP', 'POSTAL_MAIL', 'SOMETHING_NEW'])
    assert.equal(kind(hub(1, type, '', '2026-10-13T09:00:00Z', 'Thanks Sam, Tuesday 10:00 works for me')), 'from_contact', type);
  // B5: a call's direction (v3 properties) and a communication's channel.
  const v3 = (id, type, props) => ({ id, type, properties: { hs_timestamp: '2026-10-13T09:00:00Z', ...props } });
  assert.equal(kind(v3('c1', 'CALL', { hs_call_direction: 'INBOUND' })), 'from_contact', 'an inbound call');
  assert.equal(kind(v3('c2', 'CALL', { hs_call_direction: 'OUTBOUND' })), 'other', 'a call the user made is judged');
  assert.equal(kind(v3('c3', 'COMMUNICATION', { hs_communication_channel_type: 'LINKEDIN_MESSAGE', hs_body_preview: 'Thanks, happy to meet Thursday' })), 'from_contact', 'a logged LinkedIn message');
  // B5: the user's own email the day after floorboss's, with another subject: judged and shown, never "ours".
  assert.equal(kind(hub(2, 'EMAIL', OWN, '2026-10-13T10:00:00Z', 'Quote as discussed on the phone')), 'other');
  // floorboss's own email is ours, once: a second one with the same subject that day is judged.
  const two = w([hub(3, 'EMAIL', OWN, '2026-10-12T08:01:00Z', 'At the summit'), hub(4, 'EMAIL', OWN, '2026-10-12T16:00:00Z', 'Re: At the summit')]);
  assert.deepEqual(two.activities.map((a) => a.kind), ['ours', 'other']);
  // C11: a colleague's outgoing email on the send day is judged, never ours; bounces and unsubscribes hold; Pipedrive's
  // sent_flag 0 from another address of theirs holds.
  assert.equal(kind(hub(5, 'EMAIL', 'lee@lanecraft.example', '2026-10-12T12:00:00Z', 'At the summit')), 'other');
  assert.equal(kind(hub(6, 'BOUNCE', '', '2026-10-12T12:00:00Z', 'Delivery failed')), 'from_contact');
  assert.equal(kind(hub(7, 'UNSUBSCRIBE', '', '2026-10-12T12:00:00Z', '')), 'from_contact');
  const pd = crmWitness(blocks({ success: true, data: [{ id: 8, subject: 'Re: x', snippet: '', from: [{ email_address: 'ana.berg@personal.example' }], to: [], message_time: '2026-10-12 14:00:00', sent_flag: 0 }] }), opts);
  assert.equal(pd.from_contact, 1);
  // B6: logged since floorboss's message, dated before it: seen (a meeting holds, a note is judged).
  const back = w([hub(9, 'MEETING', '', '2026-10-09T10:00:00Z', 'Coffee', { createdAt: Date.parse('2026-10-13T08:00:00Z') }), hub(10, 'NOTE', 'lee@lanecraft.example', '2026-10-08T10:00:00Z', 'Call notes', { createdAt: Date.parse('2026-10-13T08:00:00Z'), text: 'Ana called: not interested, please stop' })]);
  assert.deepEqual([back.from_contact, back.others], [1, 1]);
  // Notes, tasks and deal stage changes are still the model's to judge.
  for (const type of ['NOTE', 'TASK', 'DEAL_STAGE_CHANGE']) assert.equal(kind(hub(11, type, 'lee@lanecraft.example', '2026-10-13T09:00:00Z', 'x')), 'other', type);
});

test('B9/C12 (M08, M09): the later of the Date header and the received time counts; a time in seconds counts; the window starts a day before the email it answers', () => {
  const p = { touches: { 1: { sent: { date: '2026-10-12', thread_id: 'T1' }, approved: { to: ANA }, released_at: '2026-10-12T08:00:00Z', sent_at: '2026-10-12T08:05:00Z' } } };
  const s = readSince(p, 2, ANA);
  // (from_s, for Gmail's search: 15 minutes before the guard let the send through.)
  assert.deepEqual(s, { day: '2026-10-11', ms: Date.parse('2026-10-11T00:00:00Z'), exact: true, from_s: Date.parse('2026-10-12T07:45:00Z') / 1000 });
  const w = (messages) => mailWitness(text({ messages }), { own: [OWN], sinceMs: s.ms });
  const mine = { id: 'm1', threadId: 'T1', from: OWN, date: '2026-10-12T08:05:00Z' };
  assert.equal(w([mine, { id: 'r', threadId: 'T1', from: ANA, date: 'Fri, 09 Oct 2026 10:00:00 +0000', internalDate: String(Date.parse('2026-10-12T15:00:00Z')) }]).inbound, 1, 'an old Date header never hides it');
  assert.equal(w([mine, { id: 'r', threadId: 'T1', from: ANA, date: Math.floor(Date.parse('2026-10-12T15:00:00Z') / 1000) }]).inbound, 1, 'seconds');
  assert.equal(w([mine, { id: 'r', threadId: 'T1', from: ANA, date: '2026-10-11T23:30:00Z' }]).inbound, 1, 'the day before the send day, late');
  // The user's own plus-address is theirs (a reply sent from me+events@ is not "in").
  assert.equal(w([mine, { id: 'm2', threadId: 'T1', from: 'me+events@lanecraft.example', date: '2026-10-12T09:00:00Z' }]).inbound, 0);
});

test('B1: an event east of UTC, and a receipt saved late: the read starts before the send, and an answer with nothing in it is unreadable', () => {
  // Auckland: message 1 went 2026-10-11T20:00Z (Mon 12 Oct 09:00 there); its receipt names Mon 12 Oct.
  const nz = { touches: { 1: { sent: { date: '2026-10-12', thread_id: 'T1' }, approved: { to: ANA }, released_at: '2026-10-11T20:00:00Z', sent_at: '2026-10-11T20:05:00Z' } } };
  const s = readSince(nz, 2, ANA);
  assert.equal(s.day, '2026-10-10');
  const w = (messages) => mailWitness(text({ messages }), { own: [OWN], sinceMs: s.ms });
  assert.equal(w([{ id: 'm1', threadId: 'T1', from: OWN, date: '2026-10-11T20:00:00Z' }, { id: 'r', threadId: 'T1', from: ANA, date: '2026-10-11T21:00:00Z' }]).inbound, 1);
  // A server that read the day as starting later and answered nothing: not "nothing came in".
  const empty = w([]);
  assert.equal(empty.readable, false);
  // A receipt saved three days after the guard let the send through: the read starts from the send, not the receipt.
  const late = { touches: { 1: { sent: { date: '2026-10-15', thread_id: 'T1' }, approved: { to: ANA }, released_at: '2026-10-12T08:00:00Z', sent_at: '2026-10-15T09:00:00Z' } } };
  assert.equal(readSince(late, 2, ANA).day, '2026-10-11');
});

test('A4: a hold judged on a CRM activity stays for the run: a later "go" on it is refused', async () => {
  const H = clone(BASE_CRM);
  const { t } = await ready(H, { items: CRM_ITEMS });
  readCrm(H, t, { total: 1, results: [{ id: '9201', engagement: { type: 'NOTE', timestamp: Date.parse('2026-10-12T13:00:00Z') }, metadata: { subject: 'Pricing', text: 'Asked about pricing', from: { email: 'lee@lanecraft.example' }, to: [] } }] });
  const f = join(H.dir, 'work', 'j.json');
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  const judge = (decision) => {
    writeFileSync(f, JSON.stringify({ judgements: [{ activity_id: '9201', decision, reason: 'a pricing question about this deal' }] }));
    return bashCall(H, scriptCmd('event-outreach', 'crm-judge', '--event', H.slug, '--id', H.ana, '--file', f), { session: t.session, env: { FLOORBOSS_UNATTENDED: t.token } });
  };
  assert.equal(judge('hold').pre.code, 0);
  refused(judge('go').pre, /was judged hold earlier in this run, and a hold stays for the run/);
  assert.equal(JSON.parse(readFileSync(un(H, 'witness', t.session, 'ev--c001.judged.json'), 'utf8')).judgements['9201'].decision, 'hold');
  refused(stage(H, t, stageItem(H, t), { post: false }).pre);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
});

test('A5: the day the authorisation showed binds: a gap changed since never moves a draft earlier', async () => {
  const H = clone(BASE);
  // As if the prompt said Wed 14 Oct for follow-up 1 (a gap of 2), and the gap was set to 1 afterwards.
  edit(un(H, 'authorised.jsonl'), (s) => s.split('\n').filter(Boolean).map((l) => {
    const a = JSON.parse(l);
    return JSON.stringify(a.touch === 2 ? { ...a, due_day: '2026-10-14' } : a);
  }).join('\n') + '\n');
  const due = inHome(H, () => followupsDue(Date.parse(D13), []));
  assert.deepEqual(due.items, []);
  assert.match(due.held.map((x) => x.why).join(' '), /its day moved since you authorised it \(you allowed it for Wed 14 Oct, it's due Tue 13 Oct now\)/);
  const { t } = await ready(H);
  refused(stage(H, t, stageItem(H, t), { post: false }).pre, /its day moved since you authorised it/);
});

test('A6: launchctl setenv, unsetenv and config are refused in every session; the run gets no code-loading variable and no test switch', () => {
  for (const c of ['launchctl setenv FLOORBOSS_HOME /tmp/fb-forged-home', 'launchctl setenv FLOORBOSS_TEST 1', 'launchctl setenv FLOORBOSS_CLAUDE /tmp/c', 'launchctl setenv NODE_OPTIONS --require=/tmp/x.js', 'launchctl unsetenv FLOORBOSS_HOME', 'launchctl config user path /tmp/bin'])
    assert.match(scheduleRefusal(c) || '', /launchctl .*sets what the jobs it starts are given/, c);
  // Through the guard, in a session that never ran floorboss.
  const H = clone(BASE);
  const r = hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'launchctl setenv FLOORBOSS_HOME /tmp/fb-forged-home' }, session_id: 's-fresh', tool_use_id: 'b1' });
  assert.equal(r.code, 2, r.stderr);
  const env = { HOME: '/h/u', PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require /tmp/x.js', BASH_ENV: '/tmp/x.sh', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', FLOORBOSS_HOME: '/h/u/.floorboss', FLOORBOSS_NOW: '2026-01-01T00:00:00Z', FLOORBOSS_CLAUDE: '/tmp/c', CLAUDECODE: '1' };
  const run = claudeRun({ program: '/usr/local/bin/claude', session: '01234567-89ab-cdef-0123-456789abcdef', token: 'a'.repeat(64), env });
  assert.deepEqual(Object.keys(run.env).sort(), ['FLOORBOSS_HOME', 'FLOORBOSS_UNATTENDED', 'HOME', 'PATH']);
  // Under floorboss's own tests the test switches go on (the end-to-end test needs them); code loaders never do.
  const t = claudeRun({ program: '/usr/local/bin/claude', session: '01234567-89ab-cdef-0123-456789abcdef', token: 'a'.repeat(64), env: { ...env, FLOORBOSS_TEST: '1' } });
  assert.ok(t.env.FLOORBOSS_NOW && !t.env.NODE_OPTIONS && !t.env.BASH_ENV && !t.env.DYLD_INSERT_LIBRARIES);
});

test('A8: the CRM record a run reads is the one bound at the authorisation', () => {
  const H = clone(BASE);
  assert.ok(readFileSync(un(H, 'authorised.jsonl'), 'utf8').split('\n').filter(Boolean).every((l) => Object.hasOwn(JSON.parse(l), 'crm_id')));
  assert.equal(inHome(H, () => followupsDue(Date.parse(D13), [])).items.length, 1);
  // A record id written later (a crm-recorded receipt, a triage run): held, not read.
  mkdirSync(join(H.dir, 'derived', 'compat'), { recursive: true });
  writeFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), JSON.stringify({ pre: { [H.ana]: { crm: { crm_id: '999' } } } }));
  const due = inHome(H, () => followupsDue(Date.parse(D13), []));
  assert.deepEqual(due.items, []);
  assert.match(due.held.map((x) => x.why).join(' '), /its CRM record changed since you authorised it/);
});

test('A9/C12 (M15): the launcher\'s list refuses flags that move or widen the run; the test-only pair only under the tests', () => {
  const base = claudeRun({ program: '/usr/local/bin/claude', session: '01234567-89ab-cdef-0123-456789abcdef', token: 'a'.repeat(64), env: {} }).args;
  assert.equal(argsRefusal(base), null);
  for (const extra of [['--environment', 'env_1'], ['--allowedTools', 'Bash'], ['--allowed-tools', 'Bash'], ['--add-dir', '/'], ['--permission-prompts', 'host']])
    assert.ok(argsRefusal([...base, ...extra]), extra.join(' '));
  for (const extra of [['--mcp-config', '/tmp/x.json'], ['--strict-mcp-config'], ['--plugin-dir', '/tmp/p']]) {
    assert.match(argsRefusal([...base, ...extra]) || '', /only under floorboss's own tests/, extra[0]);
    assert.equal(argsRefusal([...base, ...extra], { test: true }), null, extra[0]);
  }
});

test('B2: a draft call that fails, or whose result never comes back, stops the run, is said as maybe in, and the user can let it go again', async () => {
  // a. The failure hook: the result is a failure, and the run stops.
  {
    const H = clone(BASE);
    const { t } = await ready(H);
    const input = draftInput(stageItem(H, t));
    assert.equal(inRun(H, t, 'mcp__mail__create_draft', input, { id: 's1' }).decision, 'allow');
    hook(H, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__mail__create_draft', tool_input: input, tool_use_id: 's1', session_id: t.session, error: 'MCP error -32603: quota exceeded', is_interrupt: false }, { args: ['post'], env: { FLOORBOSS_UNATTENDED: t.token } });
    const res = logOf(H).filter((e) => e.type === 'draft_result').pop();
    assert.deepEqual([res.ok, /quota exceeded/.test(res.error)], [false, true]);
    assert.ok(stoppedAt(H, t));
  }
  // b. No word at all after the allow: the run's next step stops, the guard refuses a next draft, the summary says so.
  const H = clone(BASE);
  const { t } = await ready(H);
  const it = stageItem(H, t);
  assert.equal(stage(H, t, it, { post: false }).pre.decision, 'allow');
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  let n;
  try {
    n = cli(H, 'flow', ['next', '--unattended'], D13);
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
  assert.equal(n.step, 'done');
  assert.match(n.why, /This run stopped: the draft to c001 was let through but its result never came back/);
  const log = logOf(H);
  assert.equal(unclearDrafts(log).length, 1);
  const day = new Date(Date.parse(D13)).toLocaleDateString('sv');
  assert.match(inHome(H, () => buildSummary(log, day)), /May or may not be in your drafts folder: 1\n- \d\d:\d\d Amsterdam time "Ana Berg" \(c001, ana@acme\.test\) at Test Expo \(ev\), follow-up 1: floorboss let the draft call through but never heard back/);
  assert.ok(unseen(log, null).some((e) => e.type === 'run_stopped'));
  // c. The user looked: it isn't there. Their words, confirmed at Claude Code's prompt, let that step go in again, once.
  refused(bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'), { session: t.session, env: { FLOORBOSS_UNATTENDED: t.token } }).pre, /runs only its own steps/);
  const c = bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'Ana-isnt-in-my-drafts'), { now: D13 });
  assert.equal(c.pre.decision, 'ask', c.pre.stderr);
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.who === 'user'));
  const { t: t2 } = await ready(H);
  assert.equal(stage(H, t2, stageItem(H, t2)).pre.decision, 'allow', 'it goes in again');
  // And only once more: the same step can't be taken twice on the one clear.
  const { t: t3 } = await ready(H);
  assert.equal(stageItem(H, t3), null, 'not listed again: its draft is in');
});

test('B3/B11: a follow-up a run held today is not put on another ticket today, so the people after it go and no model run repeats it', () => {
  const H = clone(BASE);
  const log = [{ at: D13, type: 'held', session: '11111111-2222-3333-4444-555555555555', event: H.slug, id: H.ana, touch: 2, why: "your last email to them didn't go through a floorboss prompt you allowed" }];
  assert.deepEqual(inHome(H, () => followupsDue(Date.parse(D13), log)).items, []);
  assert.equal(inHome(H, () => followupsDue(Date.parse('2026-10-13T12:00:00Z'), log)).items.length, 0, 'later that day');
  assert.equal(inHome(H, () => followupsDue(Date.parse(D14), log)).items.length, 1, 'the next day it is tried once more');
  // An item the guard would refuse for the email it answers is never offered or put on a ticket.
  const H2 = clone(BASE);
  edit(join(H2.dir, 'ledger.jsonl'), (s) => s.split('\n').filter((l) => !l.includes('"send_released"')).join('\n'));
  const config = inHome(H2, () => loadConfig());
  const a = inHome(H2, () => authorisable(H2.slug, { config, settings: { ...loadEvent(H2.slug).settings, connectors: config.connectors }, nowMs: Date.parse(D13) }));
  // Follow-up 1 answers that email, so it is never offered; follow-up 2 may still be (its own earlier step can go with a prompt).
  assert.ok(!a.items.some((x) => x.touch === 2));
  assert.match(a.skipped.filter((x) => x.touch === 2).map((x) => x.why).join(' '), /didn't go through a floorboss prompt you allowed/);
  const due = inHome(H2, () => followupsDue(Date.parse(D13), []));
  assert.deepEqual(due.items, []);
  assert.match(due.held.map((x) => x.why).join(' '), /didn't go through a floorboss prompt you allowed/);
});

test('B11: a run whose launcher died is ended at the next launch, so its lock does not hold the later runs', async () => {
  const H = clone(BASE);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const t = await ticket(H, { items: BASE_ITEMS });
  edit(un(H, 'tickets', `${t.session}.json`), (s) => JSON.stringify({ ...JSON.parse(s), pid: dead }));
  // Its session started (its run lock is live), and its launcher was stopped (the Mac turned off) before it ended it.
  assert.equal(start(H, t).code, 0);
  const r = launch(H, D13);
  assert.equal(r.status, 0, r.stderr);
  const log = logOf(H);
  assert.ok(existsSync(un(H, 'tickets', `${t.session}.ended`)));
  assert.ok(log.some((e) => e.type === 'run_ended' && e.session === t.session && /launcher was stopped before the run ended/.test(e.why || '')));
  assert.ok(!log.some((e) => e.type === 'followups_skipped'), JSON.stringify(log.filter((e) => e.type === 'followups_skipped')));
  assert.ok(log.some((e) => e.type === 'run_launched'));
});

test('B7: an attended draft of the same step whose prompt may still be open holds the unattended one', async () => {
  const H = clone(BASE);
  const { t } = await ready(H);
  const it = stageItem(H, t);
  mkdirSync(join(H.dir, 'released'), { recursive: true });
  writeFileSync(join(H.dir, 'released', `stage-call-${H.ana}-2-b123-1`), new Date(Date.parse(D13) - 60000).toISOString());
  refused(stage(H, t, it, { post: false }).pre, /a draft of this same follow-up was started in a session with you there/);
});

test('B8: in a ticketed run every refusal stops the run, and only the run\'s own scripts run', async () => {
  for (const [tool, input, re] of [
    ['WebFetch', { url: 'https://example.com', prompt: 'x' }, /reads nothing on the web/],
    ['Agent', { subagent_type: 'general-purpose', prompt: 'x' }, /starts no agents/],
    ['Bash', { command: scriptCmd('event-outreach', 'send-list', '--event', 'ev') }, /runs only its own steps .*not event-outreach send-list/],
    ['Bash', { command: scriptCmd('connectors', 'forget', '--task', 'stage_draft') }, /runs only its own steps/]
  ]) {
    const H = clone(BASE);
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    const r = hook(H, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: t.session, tool_use_id: 'x1' }, { env: { FLOORBOSS_UNATTENDED: t.token } });
    refused(r, re);
    assert.ok(stoppedAt(H, t), `${tool}: the run stopped`);
    refused(readMail(H, t).pre, /stopped earlier/);
  }
  // The run's own steps still run.
  const H = clone(BASE);
  const t = await ticket(H, { items: BASE_ITEMS });
  start(H, t);
  assert.equal(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: scriptCmd('flow', 'next', '--unattended') }, session_id: t.session, tool_use_id: 'x2' }, { env: { FLOORBOSS_UNATTENDED: t.token } }).code, 0);
  assert.ok(!stoppedAt(H, t));
});

test('C3/C12 (M23): the morning page names only people whose draft can go in on its own today', () => {
  const H = clone(BASE);
  // Follow-up 1 went on LinkedIn on Tue 13; follow-up 2 (email, authorised) is due Wed 14.
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: D13, type: 'sent', who: 'user', id: H.ana, touch: 2, date: '2026-10-13', via: 'user', channel: 'LinkedIn', source: 'user', said: 'sent it on LinkedIn' })}\n`);
  const settings = () => inHome(H, () => ({ ...loadEvent(H.slug).settings, connectors: loadConfig().connectors }));
  assert.deepEqual(inHome(H, () => otherChannelPeople(H.slug, { settings: settings(), nowMs: Date.parse('2026-10-13T05:00:00Z') })), [], 'due tomorrow: not named today');
  assert.equal(inHome(H, () => otherChannelPeople(H.slug, { settings: settings(), nowMs: Date.parse('2026-10-14T05:00:00Z') })).length, 1);
  // The job not installed: nobody is named, and the page says nothing is going in.
  const opener = join(H.HOME, 'opener.sh');
  writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const brief = (now) => spawnSync(process.execPath, [join(ROOT, 'scripts/scheduled.mjs'), 'brief'], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_TEST: '1', FLOORBOSS_OPENER: opener }, encoding: 'utf8' });
  const inst = readFileSync(un(H, 'followups-installed.json'), 'utf8');
  edit(un(H, 'followups-installed.json'), () => JSON.stringify({ ...JSON.parse(inst), version: '0.0.1' }));
  assert.equal(brief('2026-10-14T05:00:00Z').status, 0);
  assert.ok(!existsSync(join(H.HOME, 'today.html')) || !/going into your drafts on their own/.test(readFileSync(join(H.HOME, 'today.html'), 'utf8')));
  writeFileSync(un(H, 'followups-installed.json'), inst);
  // A weekend day in the event's zone (Sat 17, the day after a Friday due day): nobody is named.
  const H2 = clone(BASE);
  appendFileSync(join(H2.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-15T08:00:00Z', type: 'sent', who: 'user', id: H2.ana, touch: 2, date: '2026-10-15', via: 'user', channel: 'LinkedIn', source: 'user', said: 'sent it on LinkedIn' })}\n`);
  const s2 = inHome(H2, () => ({ ...loadEvent(H2.slug).settings, connectors: loadConfig().connectors }));
  assert.equal(inHome(H2, () => otherChannelPeople(H2.slug, { settings: s2, nowMs: Date.parse('2026-10-16T05:00:00Z') })).length, 1, 'Friday, its day');
  assert.deepEqual(inHome(H2, () => otherChannelPeople(H2.slug, { settings: s2, nowMs: Date.parse('2026-10-17T05:00:00Z') })), [], 'Saturday');
});

test('C4/C7: what keeps a due follow-up from going in is said: floorboss in use in the last 30 minutes, a weekend in the event\'s zone, an earlier draft not seen sent; the summary file is there', async () => {
  // a. floorboss ran something in a session just before the job's hour (its run lock's 30 minutes).
  {
    const H = clone(BASE);
    assert.equal(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: scriptCmd('event-outreach', 'status', '--event', H.slug) }, session_id: 's-open', tool_use_id: 'o1' }, { now: D13 }).code, 0);
    const r = launch(H, D13);
    assert.equal(r.status, 0, r.stderr);
    const w = logOf(H).filter((e) => e.type === 'waiting');
    assert.equal(w.length, 1);
    assert.match(w[0].why, /floorboss was in use in the 30 minutes before this hour's run, so its draft didn't go in then/);
    const day = new Date(Date.parse(D13)).toLocaleDateString('sv');
    assert.match(readFileSync(un(H, `summary-${day}.md`), 'utf8'), /Due, but waiting: 1/);
    launch(H, '2026-10-13T09:00:00Z');
    assert.equal(logOf(H).filter((e) => e.type === 'waiting').length, 1, 'said once that day');
  }
  // b. The job runs every hour (owner's decision, 2026-11-14), so the event's own weekday hours decide: nothing to warn
  // about at the opt-in, a Tokyo event goes in at 10:00 there (21:00 the evening before in New York), and only a weekend
  // there keeps a follow-up in its window from going that day, said once.
  {
    assert.doesNotMatch(optinReason({ name: 'Tokyo Expo', slug: 'tx', end: '2026-11-12' }), /Warning/);
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const HT = clone(BASE);
      edit(join(HT.dir, 'event.json'), (s) => JSON.stringify({ ...JSON.parse(s), time_zone: 'Asia/Tokyo' }));
      const dueT = inHome(HT, () => followupsDue(Date.parse('2026-10-13T01:00:00Z'), []));
      assert.deepEqual(dueT.items.map((x) => x.touch), [2]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    const HW = clone(BASE);
    // Follow-up 1 went on LinkedIn on Thu 15; follow-up 2 (email, authorised) is due Fri 16. Sat 17, noon in Amsterdam:
    appendFileSync(join(HW.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-15T08:00:00Z', type: 'sent', who: 'user', id: HW.ana, touch: 2, date: '2026-10-15', via: 'user', channel: 'LinkedIn', source: 'user', said: 'sent it on LinkedIn' })}\n`);
    const dueW = inHome(HW, () => followupsDue(Date.parse('2026-10-17T10:00:00Z'), []));
    assert.deepEqual(dueW.items, []);
    assert.match(dueW.waiting.map((x) => x.why).join(' '), /it's the weekend in Amsterdam, and drafts go in on their own on weekdays only \(Monday to Friday, Amsterdam time\), so it can't go in on its own today/);
  }
  // c. Follow-up 1 went into the drafts unattended; follow-up 2 waits until floorboss sees it sent, and says so.
  {
    const H = clone(BASE);
    const { t } = await ready(H);
    assert.equal(stage(H, t, stageItem(H, t)).pre.decision, 'allow');
    const due = inHome(H, () => followupsDue(Date.parse(D14), []));
    assert.deepEqual(due.items, []);
    assert.match(due.waiting.map((x) => x.why).join(' '), /it waits until floorboss sees your follow-up 1 draft was sent/);
  }
});

test('C5/C7: a finished case is said once, as over, not every day as held; the summary file is written without a run', () => {
  const H = clone(BASE);
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-12T20:00:00Z', type: 'replied', who: 'user', id: H.ana, source: 'user', said: 'Ana replied' })}\n`);
  for (const now of [D13, '2026-10-13T11:00:00Z', D14, '2026-10-15T08:00:00Z']) assert.equal(launch(H, now).status, 0);
  const over = logOf(H).filter((e) => e.type === 'held' && /they replied or booked/.test(e.why));
  assert.equal(over.length, 2, 'follow-ups 1 and 2, once each');
  assert.ok(over.every((e) => e.final === true));
  const day = new Date(Date.parse(D13)).toLocaleDateString('sv');
  const sum = readFileSync(un(H, `summary-${day}.md`), 'utf8');
  assert.match(sum, /Held for you: 0/);
  assert.match(sum, /No more follow-ups go on their own for:\n- "Ana Berg" \(c001, ana@acme\.test\): they replied or booked/);
});

test('C8/C12 (M24): summary times are the event\'s, named; a draft put in shows each judgement with its reason', () => {
  const H = clone(BASE);
  const s = 'a1b2c3d4-0000-4000-8000-000000000000';
  const log = [
    { at: '2026-10-13T08:00:00.000Z', type: 'run_started', session: s },
    { at: '2026-10-13T08:00:10.000Z', type: 'read_witnessed', session: s, kind: 'crm', event: H.slug, id: H.ana, others: 1 },
    { at: '2026-10-13T08:00:20.000Z', type: 'judged', session: s, event: H.slug, id: H.ana, activity: 'note 2026-10-12 13:00 UTC from lee@lanecraft.example, "Invoice"', decision: 'go', reason: 'about billing, not this conversation' },
    { at: '2026-10-13T08:00:30.000Z', type: 'draft_allowed', session: s, event: H.slug, id: H.ana, touch: 2, name: 'Ana Berg', to: ANA },
    { at: '2026-10-13T08:00:31.000Z', type: 'draft_result', session: s, event: H.slug, id: H.ana, touch: 2, name: 'Ana Berg', to: ANA, ok: true }
  ];
  const sum = inHome(H, () => buildSummary(log, new Date(Date.parse('2026-10-13T08:00:31Z')).toLocaleDateString('sv')));
  assert.match(sum, /- 10:00 Amsterdam time to "Ana Berg" \(c001, ana@acme\.test\), follow-up 1, in your thread with them\. CRM read at 10:00 Amsterdam time: 1 other activity, judged below\./);
  assert.match(sum, /\n {2}- go: note 2026-10-12 13:00 UTC from lee@lanecraft\.example, "Invoice"\. Reason given: about billing, not this conversation/);
  assert.equal(inHome(H, () => timeAt('2026-10-13T08:00:00Z', 'no-such-event')), '08:00 UTC');
});

test('C10: wording: the opt-in prompt says "on their day or the day after"; the reminder has its verb; status counts each step once', () => {
  assert.match(BASE.optin.pre.reason, /on their day or the day after/);
  assert.match(BASE.optin.pre.reason, /your mailbox \(no CRM is connected, so only email is checked\)/);
  const H = clone(BASE);
  // A second authorisation line for the same step (an older one stays in the file).
  const first = readFileSync(un(H, 'authorised.jsonl'), 'utf8').split('\n').filter(Boolean)[0];
  appendFileSync(un(H, 'authorised.jsonl'), `${first}\n`);
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'unattended.mjs'), 'status'], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: D13, FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'darwin' }, encoding: 'utf8' });
  assert.match(r.stdout, /\(2 follow-ups authorised\)/, r.stdout + r.stderr);
});

test('C12 (M04): a path from the plugin\'s own folder that names the unattended folder is refused', () => {
  assert.ok(scheduleRefusal(`rm -f ${ROOT}/../home/.floorboss/unattended/off`));
  assert.ok(scheduleRefusal(`rm -f "${ROOT}/../.floorboss/unattended/authorised.jsonl"`));
});

test('C1/C2/C6/C9/B12: the docs say what the code does', () => {
  // Read as one line each (a wrapped line, a quoted block's "> ", a string's quote and plus are joined).
  const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\\'/g, "'").replace(/\n\s*(>\s*)?/g, ' ').replace(/\s+/g, ' ');
  const security = read('SECURITY.md');
  const readme = read('README.md');
  const optin = read('commands/unattended.md');
  const install = read('scripts/unattended.mjs');
  for (const [name, t] of [['SECURITY.md', security], ['README.md', readme], ['hooks/guard/prompts.mjs', read('hooks/guard/prompts.mjs')]]) {
    assert.doesNotMatch(t, /the one "allow"|one place floorboss's guard returns "allow"|The one allow/i, name);
  }
  assert.match(security, /three calls/);
  assert.match(readme, /three calls/);
  // C2: the brief's install text and README no longer say it does nothing on other days, without the exception.
  assert.doesNotMatch(install, /'- On other days it does nothing\.',/);
  assert.doesNotMatch(readme, /On other days, and after the event, it does nothing\./);
  // C6: the usage line, at opt-in, install and in the README.
  for (const t of [optin, install, readme]) assert.match(t, /counts toward your plan's usage and limits/);
  // C9: no sentence that reads as if the drafts don't count toward the provider's limit.
  for (const t of [optin, readme]) assert.doesNotMatch(t, /floorboss doesn't count toward your mail provider's own limits/);
  // B12 and the CRM reader: which CRM activity is read is said.
  for (const t of [optin, readme]) assert.match(t, /CRM activity reader/);
});

// ---------- the third round (2026-11-14): the re-verify's notes and the owner's decisions ----------
// Each test below failed on the code before its fix (FIX-REPORT.md in the session's scratchpad says how each was shown).
const sync = (H, now, messages) => {
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug], now);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'sync.json');
  writeFileSync(f, JSON.stringify({ people: [{ id: H.ana, messages }] }));
  return cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', f], now);
};

test('R3-1: a read with a key its recipe has no place for is refused, an empty object or list included, at any depth', async () => {
  for (const [name, input, key] of [
    ['an empty object', { address: ANA, since: '2026-10-11', filter: {} }, 'filter'],
    ['an empty list', { address: ANA, since: '2026-10-11', labelIds: [] }, 'labelIds'],
    ['an empty list inside an object', { address: ANA, since: '2026-10-11', opts: { folders: [] } }, 'opts']
  ]) {
    const H = clone(BASE);
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    refused(inRun(H, t, 'mcp__mail__list_messages', input), new RegExp(`the read for c001 isn't the one floorboss lists \\("${key}" isn't`));
    assert.ok(stoppedAt(H, t), `${name}: the run stopped`);
  }
  // A recipe with an empty list and an object of its own: those, as written, pass; anything inside them it doesn't have
  // is refused, and so is the list given as an object.
  const args = { address: '{email}', since: '{since}', labelIds: [], opts: { sent: true } };
  for (const [input, ok] of [
    [{ address: ANA, since: '2026-10-11', labelIds: [], opts: { sent: true } }, true],
    [{ address: ANA, since: '2026-10-11', labelIds: [[]], opts: { sent: true } }, false],
    [{ address: ANA, since: '2026-10-11', labelIds: [], opts: { sent: true, folders: [] } }, false],
    [{ address: ANA, since: '2026-10-11', labelIds: {}, opts: { sent: true } }, false]
  ]) {
    const H = clone(BASE);
    setRead(H, args);
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    const r = inRun(H, t, 'mcp__mail__list_messages', input);
    if (ok) assert.equal(r.decision, 'allow', r.stderr);
    else refused(r, /the read for c001 isn't the one floorboss lists/);
  }
  // The draft call too: a key its recipe has no place for, even an empty list, never goes in.
  const H = clone(BASE);
  const { t } = await ready(H);
  refused(stage(H, t, stageItem(H, t), { input: draftInput(stageItem(H, t), { cc: [] }), post: false }).pre);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
});

test('R3-2 (B7): an attended draft of the same step that went in with no receipt saved holds the unattended one, in the launcher and in the guard', async () => {
  const H = clone(BASE);
  // Email sending off for this event, so the attended run puts follow-up 1 in the drafts: its prompt, then the call ran
  // (the post hook marks it went in), and its receipt (outreach staged) is never saved.
  edit(join(H.dir, 'event.json'), (s) => {
    const e = JSON.parse(s);
    e.settings.sending = { channels: [], followups: 'scheduled' };
    return JSON.stringify(e);
  });
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], D13);
  const att = JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 2);
  assert.ok(att, JSON.stringify(sl));
  const input = draftInput(att);
  assert.equal(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: input, session_id: 's-att2', tool_use_id: 'att-1' }, { now: D13 }).decision, 'ask');
  assert.equal(hook(H, { hook_event_name: 'PostToolUse', tool_name: 'mcp__mail__create_draft', tool_input: input, tool_response: text({ id: 'd-att', message: { id: 'm-att', threadId: 'T1' } }), session_id: 's-att2', tool_use_id: 'att-1' }, { args: ['post'], now: D13 }).code, 0);
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' }, { now: D13 });
  assert.ok(!ledgerOf(H).some((e) => e.type === 'staged'), 'no receipt');
  // (What the draft tool answered is recorded by the guard's post hook, apart from the receipt.)
  assert.ok(ledgerOf(H).some((e) => e.type === 'call_result' && e.kind === 'draft' && e.who === 'guard' && e.draft_id === 'd-att' && e.thread_id === 'T1'));
  // An hour later.
  H.now = '2026-10-13T09:00:00Z';
  const due = inHome(H, () => followupsDue(Date.parse(H.now), []));
  assert.deepEqual(due.items, []);
  // (Fix round 5: every attended draft with no receipt is said as maybe in your drafts, test/unattended-fixes-7.test.mjs.)
  assert.match(due.held.map((x) => x.why).join(' '), /a draft of this same follow-up was tried in a session with you there and floorboss has no receipt for it, so it may or may not be in your drafts folder/);
  // A ticket written before it (or by a launcher that missed it): the guard holds it too.
  const { t } = await ready(H, { items: BASE_ITEMS });
  refused(stage(H, t, stageItem(H, t), { post: false }).pre, /a draft of this same follow-up was tried in a session with you there and floorboss has no receipt for it, so it may or may not be in your drafts folder/);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
});

test('R3-3 (C4c): a follow-up sent from its draft within 36 hours of the message before it is filed as that follow-up, so the next one comes due', async () => {
  const cases = {
    'by its subject, the same afternoon': (it) => ({ message_id: 'sent-2', direction: 'out', at: '2026-10-13T15:00:00Z', subject: `Re: ${it.subject}`, thread_id: 'T1' }),
    'by its subject, that evening': (it) => ({ message_id: 'sent-2', direction: 'out', at: '2026-10-13T21:00:00Z', subject: `Re: ${it.subject}` }),
    'by its text, with no subject or thread': (it) => ({ message_id: 'sent-2', direction: 'out', at: '2026-10-13T15:00:00Z', text: `${it.body}\n\n-- \nSent from my phone` })
  };
  for (const [name, sent] of Object.entries(cases)) {
    const H = clone(BASE);
    const { t } = await ready(H);
    const it = stageItem(H, t);
    assert.equal(stage(H, t, it).pre.decision, 'allow');
    // Wed 14, an attended run reads the mailbox: message 1 (Mon) and follow-up 1, sent from the draft on Tue.
    const s = sync(H, '2026-10-14T07:30:00Z', [{ message_id: 'm1', direction: 'out', at: '2026-10-12T08:00:00Z', subject: 'Test Expo', thread_id: 'T1' }, sent(it)]);
    assert.match((s.recorded || []).join(' '), /from the draft floorboss put in your drafts folder, found in your mailbox \(counted as message 2\)/, `${name}: ${JSON.stringify(s)}`);
    assert.ok(ledgerOf(H).some((e) => e.type === 'sent' && e.touch === 2 && e.date === '2026-10-13' && e.message_id === 'sent-2'), name);
    assert.deepEqual(inHome(H, () => followupsDue(Date.parse('2026-10-14T08:00:00Z'), [])).items.map((x) => x.touch), [3], name);
  }
  // Anything that isn't that draft keeps the 36-hour rule: a message in another conversation, or one sent before the
  // draft went in, is the same send as message 1.
  for (const [name, other] of [
    ['another conversation', { message_id: 'x-2', direction: 'out', at: '2026-10-13T15:00:00Z', subject: 'Re: Test Expo', thread_id: 'T9' }],
    ['before the draft went in', { message_id: 'x-2', direction: 'out', at: '2026-10-13T07:00:00Z', subject: 'Re: Test Expo', thread_id: 'T1' }]
  ]) {
    const H = clone(BASE);
    const { t } = await ready(H);
    assert.equal(stage(H, t, stageItem(H, t)).pre.decision, 'allow');
    const s = sync(H, '2026-10-14T07:30:00Z', [{ message_id: 'm1', direction: 'out', at: '2026-10-12T08:00:00Z', subject: 'Test Expo', thread_id: 'T1' }, other]);
    assert.equal(s.saved, true, JSON.stringify(s));
    assert.ok(!ledgerOf(H).some((e) => e.type === 'sent' && e.touch === 2), name);
  }
});

test('R3-4: a draft that may not be there: the summary and the next day\'s line say how to let it go again, and never to send it', async () => {
  const H = clone(BASE);
  const { t } = await ready(H);
  const input = draftInput(stageItem(H, t));
  assert.equal(inRun(H, t, 'mcp__mail__create_draft', input, { id: 's1' }).decision, 'allow');
  hook(H, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__mail__create_draft', tool_input: input, tool_use_id: 's1', session_id: t.session, error: 'MCP error -32603: quota exceeded', is_interrupt: false }, { args: ['post'], env: { FLOORBOSS_UNATTENDED: t.token } });
  const day = new Date(Date.parse(D13)).toLocaleDateString('sv');
  const sum = inHome(H, () => buildSummary(logOf(H), day));
  assert.match(sum, /Tried and failed: 1\n- .*quota exceeded\. Look in your drafts folder\. If it isn't there, tell floorboss in a session \("Ana Berg's draft isn't in my drafts"\): it runs outreach draft-missing, Claude Code asks you to confirm, and that follow-up can go in again\./);
  // The same words for a draft whose result never came back.
  const s2 = 'a1b2c3d4-0000-4000-8000-000000000001';
  const open = inHome(H, () => buildSummary([{ at: D13, type: 'draft_allowed', session: s2, event: H.slug, id: H.ana, touch: 2, name: 'Ana Berg', to: ANA }], day));
  assert.match(open, /May or may not be in your drafts folder: 1\n.*it runs outreach draft-missing, Claude Code asks you to confirm/);
  // One that went in, in another thread: it is there, nothing to let go again.
  const wrong = inHome(H, () => buildSummary([{ at: D13, type: 'draft_result', session: s2, event: H.slug, id: H.ana, touch: 2, name: 'Ana Berg', to: ANA, ok: false, in_drafts: true, error: 'it went into another thread (T9) than your last message\'s (T1)' }], day));
  assert.match(wrong, /It is in your drafts folder: check which conversation it is in before you send it\./);
  assert.doesNotMatch(wrong, /draft-missing/);
  // The next day: follow-up 2's line doesn't tell them to send a draft that may not exist.
  const due = inHome(H, () => followupsDue(Date.parse(D14), []));
  const w = due.waiting.map((x) => x.why).join(' ');
  assert.match(w, /floorboss doesn't know whether your follow-up 1 draft went into your drafts folder .*If it isn't, tell floorboss it isn't there \(outreach draft-missing\)/);
  assert.doesNotMatch(w, /once you've sent it from your mail app/);
  // The skill says it too, in plain words.
  const skill = readFileSync(join(ROOT, 'skills/event-outreach/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(skill, /draft-missing --event <slug> --id <id> --touch "<step>"/);
  assert.match(skill, /Claude Code asks them to confirm, naming the person and the follow-up/);
});

test('R3-5: draft-missing asks the user, naming the person and the step; only the post hook of that allowed call writes stage_cleared', async () => {
  const H = clone(BASE);
  const { t } = await ready(H);
  assert.equal(stage(H, t, stageItem(H, t), { post: false }).pre.decision, 'allow');
  const cleared = () => ledgerOf(H).filter((e) => e.type === 'stage_cleared');
  // The script alone (no guard, no prompt) records nothing.
  const direct = cli(H, 'event-outreach', ['draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'], D13);
  assert.ok(direct.marker, JSON.stringify(direct));
  assert.deepEqual(cleared(), [], 'the script alone records nothing');
  const cmd = scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts');
  // Declined: the prompt named them and the step; nothing is written.
  const no = bashCall(H, cmd, { allowed: false, now: D13 });
  assert.equal(no.pre.decision, 'ask', no.pre.stderr);
  assert.match(no.pre.reason, /the draft of follow-up 1 to "Ana Berg" \(c001, "ana@acme\.test"\) at "Test Expo" isn't in your drafts folder/);
  assert.deepEqual(cleared(), []);
  // A post hook for another call (the script's own output, another tool use id) writes nothing either.
  hook(H, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's-att', tool_use_id: 'someone-else', tool_response: { stdout: JSON.stringify(direct), stderr: '', interrupted: false } }, { args: ['post'], now: D13 });
  assert.deepEqual(cleared(), []);
  // Allowed: the post hook of that call writes it, once, with their words.
  const yes = bashCall(H, cmd, { now: D13 });
  assert.equal(yes.pre.decision, 'ask');
  assert.deepEqual(cleared().map((e) => [e.who, e.id, e.touch, e.said]), [['user', H.ana, 2, 'not-in-my-drafts']]);
});

test('R3-6: a person held for timing only is tried again at the next hour; a hold for what came in keeps them off the tickets that day', async () => {
  const later = '2026-10-13T10:00:00Z';
  const listed = (H, log) => inHome(H, () => followupsDue(Date.parse(later), log)).items.length;
  // A mailbox read older than 90 seconds at the draft.
  {
    const H = clone(BASE);
    const { t } = await ready(H);
    refused(stage(H, t, stageItem(H, t), { now: '2026-10-13T08:02:00Z', post: false }).pre, /wasn't read for them by this run in the last 90 seconds/);
    assert.equal(listed(H, logOf(H)), 1, 'a stale read: tried again');
  }
  // Outside the event's hours (08:30 in Amsterdam).
  {
    const H = clone(BASE);
    H.now = '2026-10-13T06:30:00Z';
    const { t } = await ready(H);
    refused(stage(H, t, stageItem(H, t), { post: false }).pre, /drafts go in from 09:00 to 17:00 only/);
    assert.equal(listed(H, logOf(H)), 1, 'before 09:00: tried again');
  }
  // A draft of the same step started in a session with the user there (its prompt may be open): a timing hold, and
  // the launcher waits for that prompt (V3 B1: 12 hours), so it isn't put on the 10:00 ticket.
  {
    const H = clone(BASE);
    const { t } = await ready(H);
    mkdirSync(join(H.dir, 'released'), { recursive: true });
    writeFileSync(join(H.dir, 'released', `stage-call-${H.ana}-2-b123-1`), new Date(Date.parse(D13) - 60000).toISOString());
    refused(stage(H, t, stageItem(H, t), { post: false }).pre, /started in a session with you there/);
    assert.ok(logOf(H).some((e) => e.type === 'held' && e.retry === true));
    assert.equal(listed(H, logOf(H)), 0, 'a session with them there: the launcher waits for its prompt');
  }
  // Something came in: off the tickets for the rest of the day.
  {
    const H = clone(BASE);
    const { t } = await ready(H, { mail: reply });
    refused(stage(H, t, stageItem(H, t), { post: false }).pre, /came in from them/);
    assert.ok(logOf(H).some((e) => e.type === 'held' && e.retry !== true));
    assert.equal(listed(H, logOf(H)), 0, 'a reply: not again today');
  }
});

test('R3-7: the launcher waits only when floorboss ran something in the last 30 minutes, never for a session merely left open', () => {
  const fakeAt = (H, minutesAgo) => {
    const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
    writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at, browser: false, sessions: { 's-open': at } }));
  };
  // A session that ran floorboss two hours ago is still open (its 12-hour backstop is live): the run goes.
  const H = clone(BASE);
  fakeAt(H, 120);
  assert.equal(launch(H, D13).status, 0);
  assert.ok(logOf(H).some((e) => e.type === 'run_launched'), JSON.stringify(logOf(H).filter((e) => /skipped|waiting/.test(e.type))));
  assert.ok(!logOf(H).some((e) => e.type === 'followups_skipped'));
  // floorboss ran something ten minutes ago: this hour waits, and says so in plain words.
  const H2 = clone(BASE);
  fakeAt(H2, 10);
  assert.equal(launch(H2, D13).status, 0);
  assert.ok(!logOf(H2).some((e) => e.type === 'run_launched'));
  assert.match(logOf(H2).find((e) => e.type === 'followups_skipped')?.reason || '', /floorboss ran something in the last 30 minutes/);
  assert.match(logOf(H2).find((e) => e.type === 'waiting')?.why || '', /floorboss was in use in the 30 minutes before this hour's run/);
  // The README says the same.
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' '), /If floorboss ran something in the last 30 minutes, the schedule waits and tries again the next hour\. A session that ran floorboss and is merely left open doesn't hold it\./);
});

test('R3-9: a CRM floorboss can\'t read on its own (Salesforce, Close) holds every draft for the event, with a plain reason', async () => {
  for (const [server, tool, name] of [
    ['salesforce', 'list_email_messages', 'Salesforce'],
    ['close', 'get_lead_activities', 'Close']
  ]) {
    const H = clone(BASE);
    edit(join(H.HOME, 'config.json'), (s) => {
      const c = JSON.parse(s);
      c.connectors['crm.activity'] = { server, tool, args: { lead_id: '{crm_id}' }, reading: 'x', tool_hash: 'f'.repeat(64), probe: { ok: true } };
      return JSON.stringify(c);
    });
    const why = new RegExp(`your CRM \\(${name}\\) is connected, but floorboss can't read its logged activity on its own .*every draft for this event waits for you`);
    const due = inHome(H, () => followupsDue(Date.parse(D13), []));
    assert.deepEqual(due.items, [], name);
    assert.match(due.held.map((x) => x.why).join(' '), why);
    const { t } = await ready(H);
    refused(stage(H, t, stageItem(H, t), { post: false }).pre, why);
  }
  // A HubSpot server whose tool has "close" in its name is not Close.
  const H = clone(BASE_CRM);
  edit(join(H.HOME, 'config.json'), (s) => {
    const c = JSON.parse(s);
    c.connectors['crm.activity'] = { ...c.connectors['crm.activity'], tool: 'list_closed_engagements' };
    return JSON.stringify(c);
  });
  assert.equal(inHome(H, () => followupsDue(Date.parse(D13), [])).held.filter((x) => /floorboss can't read its logged activity/.test(x.why)).length, 0);
  // README and the opt-in command say so, one sentence each.
  for (const f of ['README.md', 'commands/unattended.md']) assert.match(readFileSync(join(ROOT, f), 'utf8').replace(/\n\s*(>\s*)?/g, ' '), /floorboss can't read Salesforce or Close activity on its own, so with either (of those )?connected every draft waits for you\./, f);
});

test('R3-10: the run\'s list refuses the flags that move it off this Mac, open it to a browser or another program, or replace its agents, instructions or tools', () => {
  const base = claudeRun({ program: '/usr/local/bin/claude', session: '01234567-89ab-cdef-0123-456789abcdef', token: 'a'.repeat(64), env: {} }).args;
  assert.equal(argsRefusal(base), null);
  for (const extra of [['--cloud'], ['--remote-control'], ['--teleport', 'x'], ['--bg'], ['--chrome'], ['--agents', '{}'], ['--system-prompt', 'x'], ['--append-system-prompt', 'x'], ['--tools', 'Bash'], ['--tools=Bash'], ['--system-prompt-file', '/tmp/x'], ['--append-system-prompt-file', '/tmp/x']])
    assert.match(argsRefusal([...base, ...extra]) || '', /is never passed to an unattended run/, extra.join(' '));
  // In the test switch's list too.
  assert.ok(argsRefusal([...base, '--chrome'], { test: true }));
});

test('R3-11: the morning page names its day in its heading, so a page left from an earlier day never reads as today\'s', () => {
  const H = clone(BASE);
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: D13, type: 'sent', who: 'user', id: H.ana, touch: 2, date: '2026-10-13', via: 'user', channel: 'LinkedIn', source: 'user', said: 'sent it on LinkedIn' })}\n`);
  const opener = join(H.HOME, 'opener.sh');
  writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/scheduled.mjs'), 'brief'], { env: { ...process.env, TZ: 'Europe/Amsterdam', FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: '2026-10-14T05:00:00Z', FLOORBOSS_TEST: '1', FLOORBOSS_OPENER: opener }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const page = readFileSync(join(H.HOME, 'today.html'), 'utf8');
  // (V3 B12c: the day alone, never "Today", so a page left on disk from an earlier day still reads true.)
  assert.match(page, /<h1>Wed 14 Oct 2026<\/h1>/);
  assert.match(page, /<title>Wed 14 Oct 2026<\/title>/);
  assert.match(page, /Follow-ups going into your drafts on their own on Wed 14 Oct 2026/);
  assert.doesNotMatch(page, /Today/);
});

test('R3-12 (C5): a follow-up too late to go on its own is held for you, not listed as finished', () => {
  const H = clone(BASE);
  assert.equal(launch(H, '2026-10-15T08:00:00Z').status, 0);
  const day = new Date(Date.parse('2026-10-15T08:00:00Z')).toLocaleDateString('sv');
  const sum = readFileSync(un(H, `summary-${day}.md`), 'utf8');
  assert.match(sum, /Held for you: 1\n- "Ana Berg" \(c001, ana@acme\.test\), follow-up 1: it was due Tue 13 Oct, more than a day ago: it waits for you\./);
  assert.doesNotMatch(sum, /No more follow-ups go on their own for/);
});

test('R3-13 (N17, N39): two people: a read for one never witnesses the other, and a draft whose result never came back stops the guard itself', async () => {
  // N39: Ana's mailbox read witnesses Ana only; Bo's draft can't go in on it.
  {
    const H = clone(BASE2);
    const t = await ticket(H, { items: BASE2_ITEMS });
    assert.deepEqual(t.items.map((x) => x.id).sort(), [H.ana, H.bo].sort());
    start(H, t);
    assert.equal(readMail(H, t).post.code, 0);
    assert.ok(existsSync(un(H, 'witness', t.session, `ev--${H.ana}.mail.json`)));
    assert.ok(!existsSync(un(H, 'witness', t.session, `ev--${H.bo}.mail.json`)), "Ana's read is no witness for Bo");
    refused(stage(H, t, stageItem(H, t, { who: H.bo }), { post: false }).pre, /the mailbox wasn't read for them by this run/);
  }
  // N17: Ana's draft let through, its result never back; Bo read and listed: the guard itself refuses Bo's draft (the
  // run's flow is never asked).
  {
    const H = clone(BASE2);
    const t = await ticket(H, { items: BASE2_ITEMS });
    start(H, t);
    readMail(H, t);
    assert.equal(stage(H, t, stageItem(H, t), { post: false }).pre.decision, 'allow');
    assert.equal(readMail(H, t, BO_MAIL, { address: BO }).pre.decision, 'allow');
    refused(stage(H, t, stageItem(H, t, { who: H.bo }), { post: false }).pre, /earlier in this run was let through but its result never came back/);
    assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released' && e.id === H.bo));
  }
});

test('R3-13 (N38): something from them in the CRM stays seen for the run: a later CRM read without it never lets the draft in', async () => {
  const H = clone(BASE_CRM);
  const { t } = await ready(H, { items: CRM_ITEMS });
  readCrm(H, t, { total: 1, results: [{ id: '9301', engagement: { type: 'MEETING', timestamp: Date.parse('2026-10-12T14:00:00Z') }, metadata: { subject: 'Coffee', text: '', from: { email: ANA }, to: [] } }] });
  assert.equal(JSON.parse(readFileSync(un(H, 'witness', t.session, 'ev--c001.crm.json'), 'utf8')).from_contact, 1);
  // The same read again, its answer without it.
  readCrm(H, t, { total: 0, results: [] });
  assert.equal(JSON.parse(readFileSync(un(H, 'witness', t.session, 'ev--c001.crm.json'), 'utf8')).from_contact, 0, 'the latest witness is clean');
  refused(stage(H, t, stageItem(H, t), { post: false }).pre, /earlier in this run floorboss saw 1 thing from them in your CRM: it waits for you/);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
});

test('R3-13 (N32): draft-missing clears only a step an unattended run let through with no draft recorded', () => {
  const H = clone(BASE);
  // Nothing was let through for follow-up 1: the script refuses and prints no marker; the guard refuses it too.
  const c = cli(H, 'event-outreach', ['draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'], D13);
  assert.ok(!c.marker, JSON.stringify(c));
  assert.match(c.ERROR || '', /wasn't let into your drafts by an unattended run: nothing to clear/);
  refused(bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'), { now: D13 }).pre, /wasn't let into your drafts by an unattended run/);
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_cleared'));
});
