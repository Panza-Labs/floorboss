// A stop recorded on the laptop must reach the daily Claude routine (audit 2026-11-22, finding 1), and routine-saved
// marks the routine current only with the id RemoteTrigger itself answered for that body (finding 2).
//   Finding 1: the routine's queue is its own prompt and Gmail is its state, so a stop takes effect only when that
//   person's queued drafts are deleted from Gmail. revoke and every laptop stop hand out guarded delete_draft steps;
//   until a delete is confirmed the step stays off the outbox and Claude Code's send list (routineHeld).
//   Finding 2: routine-saved takes only a trigger id the guard recorded from RemoteTrigger's own answer (PostToolUse)
//   for the body that is pending, never the model's --id alone (a declined update, or another of the user's routines).
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { world, addLines, ledgerLines, autosend, said, envFor, PEOPLE, NOW, EVENT, SLUG, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, readEvent, eventJson } from '../lib/autosend/common.mjs';
import { routineBody, routineSaved, routineState, routineStopWords, ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import { afterRemoteTrigger } from '../hooks/guard/routine-trigger.mjs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
const ENV_ID = 'env_01ABCDEFGHJK';
// A routine-mode event: every sequence approved, message 1 sent, each follow-up a Gmail draft the guard saw made.
function routineWorld({ people = [ANA, BO], touches = 3 } = {}) {
  const w = world({ touches, people, event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  people.forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= touches; t++) {
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due: new Date(Date.UTC(2026, 9, 12 + 3 * (t - 1) + i)).toISOString().slice(0, 10), draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  return { ...w, nowMs };
}
const heldNow = (w, id, touch) => routineHeld(eventJson(w.evDir), readEvent(w.evDir).entries, id, touch);
const hold = (HOME, session = 'sess-run') => {
  const t = new Date().toISOString();
  writeFileSync(join(HOME, 'active.json'), JSON.stringify({ at: t, sessions: { [session]: t } }));
};
const hook = (HOME, input, args = []) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, ...input }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
const post = (HOME, input, event = 'PostToolUse') => hook(HOME, { hook_event_name: event, ...input }, ['post']);
const decision = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || null;
  } catch {
    return null;
  }
};
const revokeAna = (w) => autosend(w.HOME, withSeen(w.HOME, ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')]), { claude: true });

// ---- Finding 1 ----
test('revoke in routine mode: delete_draft steps for that person\'s queued drafts, and the routine words, plainly', () => {
  const w = routineWorld();
  const out = revokeAna(w);
  assert.ok(!out.ERROR, out.ERROR);
  assert.deepEqual(out.drafts_delete.map((s) => [s.args.draftId, s.tool, Object.keys(s.args).join()]), [['r02', `${GM}delete_draft`, 'draftId'], ['r03', `${GM}delete_draft`, 'draftId']]);
  assert.match(out.next, /daily routine could still send/);
  assert.match(out.next, /routine-body --event harbor-expo/);
  assert.match(out.next, /RemoteTrigger/);
  assert.match(out.next, /by hand in Gmail Drafts/);
  assert.doesNotMatch(out.next, /back on the outbox page|scheduled task/);
  // Bo's drafts are not handed out: his yes stands.
  assert.ok(!out.drafts_delete.some((s) => /^r1/.test(s.args.draftId)));
});

test('routineHeld stays on after a revoke until each delete is confirmed, then the step is the user\'s again', () => {
  const w = routineWorld();
  assert.ok(heldNow(w, ANA.id, 2), 'the routine has it');
  revokeAna(w);
  assert.match(heldNow(w, ANA.id, 2) || '', /Gmail draft/, 'still off the outbox and the send list');
  assert.match(heldNow(w, ANA.id, 3) || '', /Gmail draft/);
  // The guard reads delete_draft's own answer.
  assert.equal(post(w.HOME, { tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r02' }, tool_response: { content: [{ type: 'text', text: '{}' }] } }).status, 0);
  assert.equal(heldNow(w, ANA.id, 2), null, 'deleted: back to the user');
  assert.ok(heldNow(w, ANA.id, 3), 'the other draft is still there');
  // A get_draft that says it is gone confirms it too (as a failure, the way Claude Code may report an MCP error).
  post(w.HOME, { tool_name: `${GM}get_draft`, tool_input: { draftId: 'r03' }, error: 'Requested entity was not found.' }, 'PostToolUseFailure');
  assert.equal(heldNow(w, ANA.id, 3), null);
  const gone = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_draft_deleted');
  assert.deepEqual(gone.map((e) => [e.draft_id, e.who]), [['r02', 'guard'], ['r03', 'guard']]);
  // An answer that doesn't say it went confirms nothing; a live draft's answer is never recorded.
  const w2 = routineWorld();
  revokeAna(w2);
  post(w2.HOME, { tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r02' }, tool_response: { isError: true, content: [{ type: 'text', text: 'Internal error' }] } });
  assert.ok(heldNow(w2, ANA.id, 2), 'a failed delete keeps it held');
  post(w2.HOME, { tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r12' }, tool_response: {} });
  assert.ok(!ledgerLines(w2.evDir).some((e) => e.type === 'autosend_draft_deleted'), 'Bo\'s live draft: nothing recorded');
  // Reconciliation's own record that a draft is gone counts too.
  addLines(w2.evDir, [{ at: NOW, type: 'autosend_draft_bad', who: 'floorboss', id: ANA.id, touch: 2, draft_id: 'r02', why: 'deleted from Gmail Drafts without being sent', run: 'reconcile' }]);
  assert.equal(heldNow(w2, ANA.id, 2), null);
});

test('guard: delete_draft only for a draft it saw made, whose yes was stopped, with exactly {draftId}, in the run\'s own session, with the user\'s prompt', () => {
  const w = routineWorld();
  revokeAna(w);
  hold(w.HOME);
  const del = (args, extra = {}) => hook(w.HOME, { tool_name: `${GM}delete_draft`, tool_input: args, ...extra });
  const ok = del({ draftId: 'r02' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(decision(ok), 'ask');
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecisionReason, /delete[\s\S]*Ana Ito[\s\S]*never sends it/);
  for (const [args, why] of [[{ draftId: 'rZZ' }, 'an unknown id'], [{ draftId: 'r12' }, 'a draft whose yes still stands'], [{ draftId: 'r02', extra: 1 }, 'an extra key'], [{ id: 'r02' }, 'another key'], [{ draftId: ['r02'] }, 'not a plain id']]) {
    const r = del(args);
    assert.equal(r.status, 2, `${why}: ${r.stdout}`);
    assert.equal(decision(r), null, why);
  }
  assert.equal(del({ draftId: 'r02' }, { agent_id: 'sub-1' }).status, 2, 'a subagent');
  assert.equal(del({ draftId: 'r02' }, { session_id: 'sess-other' }).status, 2, 'another session while the run is held');
  // A draft the guard never saw made (no call_result), though stopped: refused.
  const w2 = routineWorld();
  const lines = ledgerLines(w2.evDir).filter((e) => !(e.type === 'call_result' && e.draft_id === 'r02'));
  writeFileSync(join(w2.evDir, 'ledger.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  revokeAna(w2);
  hold(w2.HOME);
  assert.equal(hook(w2.HOME, { tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r02' } }).status, 2, 'not seen made');
  // get_draft for a stopped draft (to confirm it is gone) is a read with the user's prompt.
  assert.equal(decision(hook(w.HOME, { tool_name: `${GM}get_draft`, tool_input: { draftId: 'r03' } })), 'ask');
});

test('a laptop stop (a booking, an opt-out, a reply on another channel) hands out the same delete steps', async () => {
  const w = routineWorld();
  addLines(w.evDir, [{ at: NOW, type: 'stop', who: 'user', id: ANA.id, said: 'they asked us to stop on LinkedIn' }]);
  const r = routineStopWords(w.evDir, SLUG, w.nowMs);
  assert.deepEqual(r.drafts_delete.map((s) => s.args.draftId), ['r02', 'r03']);
  assert.match(r.say, /could still send/);
  const { withHolds } = await import('../skills/event-outreach/scripts/commands/outcomes.mjs');
  const out = withHolds({ event: SLUG }, { recorded: 1 });
  assert.deepEqual(out.drafts_delete.map((s) => s.args.draftId), ['r02', 'r03']);
  assert.match(out.drafts_delete_say, /by hand in Gmail Drafts/);
  // Nothing stopped: nothing to delete.
  assert.equal(routineStopWords(routineWorld().evDir, SLUG, w.nowMs), null);
});

test('routine-status hands out the deletes still to confirm', () => {
  const w = routineWorld();
  revokeAna(w);
  const st = autosend(w.HOME, ['routine-status'], { claude: true });
  assert.ok(!st.ERROR, st.ERROR);
  assert.deepEqual(st.drafts_delete.map((s) => s.args.draftId), ['r02', 'r03']);
  assert.match(st.drafts_delete_say, /could still send/);
});

test('the words promise only what is true: the routine checks replies and bounces; a stop recorded here takes effect when the drafts are deleted', () => {
  const w = routineWorld();
  const b = autosend(w.HOME, ['routine-body', '--event', SLUG, '--environment', ENV_ID], { claude: true });
  assert.doesNotMatch(b.show, /booked, said stop/);
  assert.match(b.show, /replies and bounces/);
  assert.match(b.show, /delete their drafts/);
  hold(w.HOME);
  const r = hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: b.remote_trigger }, ['other']);
  const why = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.doesNotMatch(why, /booked, said stop/);
  assert.match(why, /replies and bounces/);
});

// ---- Finding 2 ----
const answered = (HOME, call, response) => post(HOME, { tool_name: 'RemoteTrigger', tool_input: call, tool_response: response });
const callOf = (b) => ({ action: b.action, ...(b.trigger_id ? { trigger_id: b.trigger_id } : {}), body: b.body });

test('PoC2 refused: an update that RemoteTrigger never carried leaves the routine due an update', () => {
  const w = routineWorld();
  const a = routineBody(w.HOME, { event: SLUG, nowMs: w.nowMs, environmentId: ENV_ID });
  // The create ran, and the guard read its answer.
  assert.equal(afterRemoteTrigger({ tool_name: 'RemoteTrigger', tool_input: callOf(a), tool_response: { id: 'trig_01ABCDEFGHJKLMNOP', name: 'x' } }, w.HOME, w.nowMs), true);
  routineSaved(w.HOME, { event: SLUG, id: 'trig_01ABCDEFGHJKLMNOP', nowMs: w.nowMs });
  assert.equal(routineState(w.HOME, SLUG, w.nowMs).update_due, null);
  addLines(w.evDir, [{ at: NOW, type: 'autosend_revoked', who: 'user', id: ANA.id, said: 'stop' }]);
  assert.match(routineState(w.HOME, SLUG, w.nowMs).update_due, /changed/);
  const b = routineBody(w.HOME, { event: SLUG, nowMs: w.nowMs });
  assert.equal(b.trigger_id, 'trig_01ABCDEFGHJKLMNOP');
  // The update was declined (no answer at all): routine-saved refuses, and the update stays due.
  assert.throws(() => routineSaved(w.HOME, { event: SLUG, id: b.trigger_id, nowMs: w.nowMs }), /RemoteTrigger's own answer/);
  assert.match(routineState(w.HOME, SLUG, w.nowMs).update_due, /changed/);
  // An answer that is an error, or one for another body: still refused.
  assert.equal(afterRemoteTrigger({ tool_name: 'RemoteTrigger', tool_input: callOf(b), tool_response: { isError: true, content: [{ type: 'text', text: 'failed trig_01ABCDEFGHJKLMNOP' }] } }, w.HOME, w.nowMs), false);
  assert.equal(afterRemoteTrigger({ tool_name: 'RemoteTrigger', tool_input: callOf(a), tool_response: { id: 'trig_01ABCDEFGHJKLMNOP' } }, w.HOME, w.nowMs), false, 'the old body');
  assert.throws(() => routineSaved(w.HOME, { event: SLUG, id: b.trigger_id, nowMs: w.nowMs }), /RemoteTrigger's own answer/);
  // The update ran and answered: saved.
  assert.equal(afterRemoteTrigger({ tool_name: 'RemoteTrigger', tool_input: callOf(b), tool_response: JSON.stringify({ trigger: { id: 'trig_01ABCDEFGHJKLMNOP' } }) }, w.HOME, w.nowMs), true);
  routineSaved(w.HOME, { event: SLUG, id: b.trigger_id, nowMs: w.nowMs });
  assert.equal(routineState(w.HOME, SLUG, w.nowMs).update_due, null);
});

test('routine-saved refuses another of the user\'s routines; the guard then reads and updates only the id RemoteTrigger answered', () => {
  const w = routineWorld();
  hold(w.HOME);
  const b = autosend(w.HOME, ['routine-body', '--event', SLUG, '--environment', ENV_ID], { claude: true });
  // Their other routine, with no create answer behind it: refused.
  const foreign = autosend(w.HOME, withSeen(w.HOME, ['routine-saved', '--event', SLUG, '--id', 'trig_USERSOTHERROUTINE01']), { claude: true });
  assert.match(foreign.ERROR || '', /RemoteTrigger's own answer/);
  assert.equal(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: { action: 'get_run_log', trigger_id: 'trig_USERSOTHERROUTINE01', run_id: 'r1' } }, ['other']).status, 2);
  // The create runs, through the guard, and its answer names the new routine.
  assert.equal(decision(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: b.remote_trigger }, ['other'])), 'ask');
  assert.equal(answered(w.HOME, b.remote_trigger, { content: [{ type: 'text', text: JSON.stringify({ id: 'trig_01NEWROUTINE000001' }) }] }).status, 0);
  // Still not the foreign id: the answer named another.
  assert.match(autosend(w.HOME, withSeen(w.HOME, ['routine-saved', '--event', SLUG, '--id', 'trig_USERSOTHERROUTINE01']), { claude: true }).ERROR || '', /RemoteTrigger's own answer/);
  const s = autosend(w.HOME, withSeen(w.HOME, ['routine-saved', '--event', SLUG, '--id', 'trig_01NEWROUTINE000001']), { claude: true });
  assert.equal(s.saved, 'trig_01NEWROUTINE000001', s.ERROR);
  assert.equal(decision(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: { action: 'get', trigger_id: 'trig_01NEWROUTINE000001' } }, ['other'])), 'ask');
  assert.equal(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: { action: 'get', trigger_id: 'trig_USERSOTHERROUTINE01' } }, ['other']).status, 2);
  // A saved file that names an id the guard never recorded (however it got there) is no routine floorboss saved.
  const f = join(w.HOME, 'autosend', 'routines', `${SLUG}.json`);
  const sv = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...sv, trigger_id: 'trig_USERSOTHERROUTINE01' }));
  assert.equal(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: { action: 'get', trigger_id: 'trig_USERSOTHERROUTINE01' } }, ['other']).status, 2);
  const u = autosend(w.HOME, ['routine-body', '--event', SLUG], { claude: true }).remote_trigger;
  assert.equal(hook(w.HOME, { tool_name: 'RemoteTrigger', tool_input: u }, ['other']).status, 2, 'no update of a foreign routine');
  // A subagent's RemoteTrigger answer is never recorded.
  const w2 = routineWorld();
  const b2 = autosend(w2.HOME, ['routine-body', '--event', SLUG, '--environment', ENV_ID], { claude: true });
  post(w2.HOME, { tool_name: 'RemoteTrigger', tool_input: b2.remote_trigger, tool_response: { id: 'trig_01SUBAGENTROUTINE1' }, agent_id: 'sub-1' });
  assert.match(autosend(w2.HOME, withSeen(w2.HOME, ['routine-saved', '--event', SLUG, '--id', 'trig_01SUBAGENTROUTINE1']), { claude: true }).ERROR || '', /RemoteTrigger's own answer/);
});

test('the outbox offers no copy buttons for a step whose routine draft is not confirmed deleted', async () => {
  const { offersCopy } = await import('../skills/event-outreach/scripts/outbox.mjs');
  assert.equal(offersCopy({ routine_draft: true }), false);
  assert.equal(offersCopy({}), true);
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, routine-saved is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('routine-saved');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
