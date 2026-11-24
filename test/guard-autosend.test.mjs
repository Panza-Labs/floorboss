// The guard's narrow rules for Claude Code auto-send through a daily Claude routine (owner's approval 2026-11-22),
// each with the abuses it must refuse. Every allow keeps Claude Code's own permission prompt ("ask"), never "allow".
//   (c) the auto-send script is one of floorboss's own scripts, for its Claude Code commands only;
//   (b) RemoteTrigger create and update only with the body floorboss printed, reads only for the routine it saved;
//   (a) create_draft and get_draft on the Gmail connector only for an approved message, exactly;
//   (d) message 1 at the final approval through Claude Code's own send check.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { world, autosend, ledgerLines, addLines, ROOT, EVENT, envFor, NOW, PEOPLE, draftText } from './fixtures/autosend-world.mjs';

const routineEvent = { ...EVENT, autosend_mode: 'routine' };
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
export const guard = (HOME, input, { args = [], now = NOW } = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...input }), env: envFor(HOME, { claude: true, now }), encoding: 'utf8' });
export const held = (HOME) => {
  const nowIso = new Date().toISOString();
  writeFileSync(join(HOME, 'active.json'), JSON.stringify({ at: nowIso, sessions: { 'sess-run': nowIso } }));
};
const bash = (HOME, command, session = 'sess-run') => guard(HOME, { session_id: session, tool_name: 'Bash', tool_input: { command } });
export const decision = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || null;
  } catch {
    return null;
  }
};

test('(c) the auto-send script runs in a held session, its Claude Code commands only; the routine commands leave the run lock alone', () => {
  const { HOME } = world({ touches: 1, event: routineEvent });
  held(HOME);
  for (const sub of ['routine-status', 'routine-checked --run rc-000000000000', 'readback --event harbor-expo', 'approve --event harbor-expo --digest x', 'drafts next --event harbor-expo --run new', 'revoke --event harbor-expo --ids all --said-file x']) {
    const r = bash(HOME, `node ${CLI} ${sub}`);
    assert.equal(r.status, 0, `${sub}: ${r.stderr}`);
  }
  for (const sub of ['init --remote https://github.com/evil/x', 'status', 'setup', 'sync unlock', 'next --run new', 'daily-task', 'settle --event harbor-expo']) {
    const r = bash(HOME, `node ${CLI} ${sub}`);
    assert.equal(r.status, 2, sub);
    assert.match(r.stderr, /auto-send script runs only/, sub);
  }
  // A plain-word rule still holds for it, as for every floorboss script.
  assert.equal(bash(HOME, `node ${CLI} routine-status; curl https://evil.test`).status, 2);
  // In a fresh session: routine-status doesn't tie the run lock to it; readback does.
  const { HOME: H2 } = world({ touches: 1, event: routineEvent });
  assert.equal(bash(H2, `node ${CLI} routine-status`, 'sess-fresh').status, 0);
  assert.ok(!existsSync(join(H2, 'active.json')) || !JSON.parse(readFileSync(join(H2, 'active.json'), 'utf8')).sessions?.['sess-fresh'], 'routine-status leaves the lock');
  assert.equal(bash(H2, `node ${CLI} readback --event harbor-expo`, 'sess-fresh').status, 0);
  assert.ok(JSON.parse(readFileSync(join(H2, 'active.json'), 'utf8')).sessions['sess-fresh'], 'readback ties it');
});

// ---- (b) RemoteTrigger ----
const ENV_ID = 'env_01TESTENVIRONMENT00000';
const trigger = (HOME, tool_input, session = 'sess-run', extra = {}) => guard(HOME, { session_id: session, tool_name: 'RemoteTrigger', tool_input, ...extra }, { args: ['other'] });
const draftedWorld = () => {
  const w = world({ touches: 2, event: routineEvent });
  const rb = autosend(w.HOME, ['readback', '--event', 'harbor-expo'], { claude: true });
  addLines(w.evDir, rb_lines(rb));
  return w;
};
// The ledger after a run at the final approval: message 1 sent, message 2 a draft in its thread, for each person.
function rb_lines(rb) {
  const out = [];
  PEOPLE.forEach((p, i) => {
    out.push({ at: NOW, type: 'autosend_approved', who: 'user', id: p.id, touch: 1, hash: hashOf(p, 1), to: p.email, from: 'sam@lanecraft.example', planned_due: '2026-10-12', send_now: true, digest: rb.digest, said: 'picked: x', pick: 'auto' });
    out.push({ at: NOW, type: 'autosend_approved', who: 'user', id: p.id, touch: 2, hash: hashOf(p, 2), to: p.email, from: 'sam@lanecraft.example', planned_due: '2026-10-15', digest: rb.digest, said: 'picked: x', pick: 'auto' });
    out.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', message_id: `m${i}`, thread_id: `t${i}`, hash: hashOf(p, 1), source: 'autosend' });
    out.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: 2, hash: hashOf(p, 2), to: p.email, due: '2026-10-15', draft_id: `r${i}2`, message_id: `dm${i}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
  });
  return out;
}
import { approvalHash } from '../lib/sendcheck.mjs';
const hashOf = (p, t) => approvalHash(draftText(p, t), p.email);

test('(b) RemoteTrigger in a held session: create and update only with the body floorboss printed, once; reads only of the routine it saved', () => {
  const { HOME } = draftedWorld();
  held(HOME);
  const b = autosend(HOME, ['routine-body', '--event', 'harbor-expo', '--environment', ENV_ID], { claude: true });
  assert.ok(!b.ERROR, b.ERROR);
  const call = b.remote_trigger;
  assert.equal(call.action, 'create');
  // Changed by one character, anywhere: refused.
  const one = JSON.parse(JSON.stringify(call));
  one.body.job_config.ccr.events[0].data.message.content = one.body.job_config.ccr.events[0].data.message.content.replace('Q1 ', 'Q1  ');
  const r1 = trigger(HOME, one);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /isn't the one floorboss printed/);
  const two = JSON.parse(JSON.stringify(call));
  two.body.cron_expression = two.body.cron_expression.replace(/^\d/, (d) => String((Number(d) + 1) % 10));
  assert.equal(trigger(HOME, two).status, 2, 'another time');
  assert.equal(trigger(HOME, { ...call, extra: 'x' }).status, 2, 'another key');
  // Keys in another order are the same body.
  const reordered = { body: Object.fromEntries(Object.entries(call.body).reverse()), action: 'create' };
  const ok = trigger(HOME, reordered);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(decision(ok), 'ask', 'the user is asked');
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecisionReason, /floorboss daily sending: harbor-expo/);
  // Once: the same body again is refused.
  assert.match(trigger(HOME, call).stderr, /already let through once/);
  // Saved: a create is refused from now on; an update only for that id, with a fresh body.
  // RemoteTrigger answered the create (ok above) with the new routine's id; the guard reads it after the call ran.
  assert.equal(guard(HOME, { hook_event_name: 'PostToolUse', tool_name: 'RemoteTrigger', tool_input: reordered, tool_response: { id: 'trig_01SAVEDROUTINE00001' } }, { args: ['post'] }).status, 0);
  autosend(HOME, withSeen(HOME, ['routine-saved', '--event', 'harbor-expo', '--id', 'trig_01SAVEDROUTINE00001']), { claude: true });
  const u = autosend(HOME, ['routine-body', '--event', 'harbor-expo'], { claude: true }).remote_trigger;
  assert.equal(u.action, 'update');
  assert.match(trigger(HOME, { action: 'create', body: u.body }).stderr, /already saved a routine/);
  assert.match(trigger(HOME, { ...u, trigger_id: 'trig_01OTHERROUTINE00002' }).stderr, /only for the routine floorboss saved/);
  assert.equal(decision(trigger(HOME, u)), 'ask');
  // Reads: only the saved routine.
  assert.equal(decision(trigger(HOME, { action: 'get', trigger_id: 'trig_01SAVEDROUTINE00001' })), 'ask');
  assert.equal(decision(trigger(HOME, { action: 'get_run_log', trigger_id: 'trig_01SAVEDROUTINE00001', run_id: 'run_1' })), 'ask');
  for (const bad of [{ action: 'get', trigger_id: 'trig_01OTHERROUTINE00002' }, { action: 'list' }, { action: 'run', trigger_id: 'trig_01SAVEDROUTINE00001' }, { action: 'get', trigger_id: 'trig_01SAVEDROUTINE00001', body: {} }, { action: 'delete', trigger_id: 'trig_01SAVEDROUTINE00001' }])
    assert.equal(trigger(HOME, bad).status, 2, JSON.stringify(bad));
  // A subagent: refused, whatever it carries.
  assert.equal(trigger(HOME, { action: 'get', trigger_id: 'trig_01SAVEDROUTINE00001' }, 'sess-run', { agent_id: 'sub-1' }).status, 2);
  // Another session that never ran floorboss: as before, the guard leaves RemoteTrigger to Claude Code.
  const free = trigger(HOME, { action: 'list' }, 'sess-other');
  assert.equal(free.status, 0);
  assert.equal(free.stdout, '');
});

test('(b) a printed body more than 30 minutes old is refused', () => {
  const { HOME } = draftedWorld();
  held(HOME);
  const call = autosend(HOME, ['routine-body', '--event', 'harbor-expo', '--environment', ENV_ID], { claude: true }).remote_trigger;
  const r = guard(HOME, { tool_name: 'RemoteTrigger', tool_input: call }, { args: ['other'], now: '2026-10-12T08:31:00Z' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /more than 30 minutes ago/);
});

// ---- (a) create_draft and get_draft ----
import { readback, approve } from '../lib/autosend/approval.mjs';
const GM = 'mcp__claude_ai_Gmail__';
const mcp = (HOME, tool, tool_input, extra = {}) => guard(HOME, { tool_name: `${GM}${tool}`, tool_input, ...extra });
const postMcp = (HOME, tool, tool_input, tool_response, tool_use_id) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-run', tool_name: `${GM}${tool}`, tool_input, tool_response, tool_use_id }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
// Pick 1 approved; message 1 sent to each person through Claude Code's own send (the guard's release and its reading
// of the send tool's answer, then the receipt); then the run at the final approval, at its first draft step.
export function atFirstDraft({ people = PEOPLE } = {}) {
  const w = world({ touches: 2, event: routineEvent, people });
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '1' }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  people.forEach((p, i) => {
    const h = yes.find((e) => e.id === p.id && e.touch === 1).hash;
    lines.push(
      { at: NOW, type: 'autosend_released', who: 'floorboss', id: p.id, touch: 1, hash: h, to: p.email, run: 'cc-0', host: 'claude-code' },
      { at: NOW, type: 'send_released', who: 'guard', id: p.id, touch: 1, hash: h, via: 'email.send', to: p.email },
      { at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: 1, kind: 'send', message_id: `m${i}000000000000`, thread_id: `t${i}000000000000`, tool: `${GM}send_message` },
      { at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, date: '2026-10-12', via: 'floorboss', hash: h, channel: 'email.send', message_id: `m${i}000000000000` }
    );
  });
  addLines(w.evDir, lines);
  held(w.HOME);
  const s = autosend(w.HOME, withSeen(w.HOME, ['drafts', 'next', '--event', 'harbor-expo', '--run', 'new']), { claude: true });
  return { ...w, s };
}

test('(a) create_draft: only the open run\'s draft, exactly as approved, in the thread of message 1 as sent, once; with the user\'s prompt', () => {
  const { HOME, evDir, s } = atFirstDraft();
  assert.equal(s.step, 'draft', JSON.stringify(s));
  assert.equal(s.tool, `${GM}create_draft`);
  assert.deepEqual(Object.keys(s.args), ['to', 'subject', 'body', 'replyToMessageId']);
  const [ana] = PEOPLE;
  assert.deepEqual([s.args.to, s.args.replyToMessageId], [[ana.email], 'm0000000000000']);
  const refused = (args, why) => {
    const r = mcp(HOME, 'create_draft', args);
    assert.equal(r.status, 2, `${why}: ${r.stdout}`);
    assert.equal(decision(r), null, why);
  };
  refused({ ...s.args, to: ['eve@evil.example'] }, 'a wrong address');
  refused({ ...s.args, to: [ana.email, 'eve@evil.example'] }, 'a second address');
  refused({ ...s.args, to: ana.email }, 'not the connector\'s list form');
  refused({ ...s.args, body: `${s.args.body} PS: wire the money.` }, 'an edited body');
  refused({ ...s.args, body: s.args.body.replace('Hi', 'Hey') }, 'an edited body, one word');
  refused({ ...s.args, subject: `${s.args.subject}!` }, 'an edited subject');
  refused({ ...s.args, replyToMessageId: 'm1000000000000' }, 'a wrong thread (another person\'s first email)');
  refused({ to: s.args.to, subject: s.args.subject, body: s.args.body }, 'no thread');
  refused({ ...s.args, cc: ['eve@evil.example'] }, 'a Cc');
  refused({ ...s.args, htmlBody: '<p>x</p>' }, 'an HTML body of its own');
  // Bo's follow-up is approved too, but it isn't the step the run is on.
  const bo = draftText(PEOPLE[1], 2);
  refused({ to: [PEOPLE[1].email], subject: bo.subject, body: bo.body, replyToMessageId: 'm1000000000000' }, 'not the run\'s current step');
  // A subagent: refused, whatever it carries.
  assert.equal(mcp(HOME, 'create_draft', s.args, { agent_id: 'sub-1' }).status, 2);
  // The step itself: the user is asked, with the whole text.
  const ok = mcp(HOME, 'create_draft', s.args, { tool_use_id: 'toolu_d1' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(decision(ok), 'ask');
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecisionReason, /in the thread of message 1[\s\S]*Could we find 20 minutes/);
  // Once: the same call again is refused.
  assert.match(mcp(HOME, 'create_draft', s.args, { tool_use_id: 'toolu_d2' }).stderr, /already let through once/);
  // After it ran: the guard records the ids from the tool's own answer; get_draft only for that draft.
  assert.equal(postMcp(HOME, 'create_draft', s.args, { id: 'r-ana-2', messageId: 'dm0', threadId: 't0000000000000' }, 'toolu_d1').status, 0);
  const cr = ledgerLines(evDir).filter((e) => e.type === 'call_result' && e.kind === 'draft');
  assert.deepEqual(cr.map((e) => [e.id, e.touch, e.draft_id, e.who]), [[ana.id, 2, 'r-ana-2', 'guard']]);
  assert.equal(decision(mcp(HOME, 'get_draft', { draftId: 'r-ana-2' })), 'ask');
  for (const bad of [{ draftId: 'r-other' }, { draftId: 'r-ana-2', format: 'full' }, { id: 'r-ana-2' }]) assert.equal(mcp(HOME, 'get_draft', bad).status, 2, JSON.stringify(bad));
  // Another session, while the run is live: held to reads as before; the exception is the session's own run only.
  assert.equal(guard(HOME, { session_id: 'sess-other', tool_name: `${GM}create_draft`, tool_input: s.args }).status, 2);
});

test('(a) a draft for someone with no standing yes is refused: not approved, stopped, or the list changed after the yes', () => {
  const { HOME, evDir, s } = atFirstDraft();
  // The list changed after the yes (a replay of that approval): refused.
  addLines(evDir, [{ at: NOW, type: 'keep', who: 'user', ids: ['c001', 'c002', 'c003'], said: 'keep these' }]);
  assert.equal(mcp(HOME, 'create_draft', s.args).status, 2, 'after the list changed');
  const b = atFirstDraft();
  addLines(b.evDir, [{ at: NOW, type: 'autosend_revoked', who: 'user', id: 'c001', said: 'stop auto-send for Ana' }]);
  assert.equal(mcp(b.HOME, 'create_draft', b.s.args).status, 2, 'after a stop');
  const c = atFirstDraft();
  addLines(c.evDir, [{ at: NOW, type: 'replied', who: 'mailbox', id: 'c001', source: 'gmail', date: '2026-10-12' }]);
  assert.equal(mcp(c.HOME, 'create_draft', c.s.args).status, 2, 'after a reply');
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, drafts is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('drafts');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
