// Review of a590969 (2026-11-22): the gaps in "a stop on the laptop deletes the routine's queued drafts".
//   1. "not found" is not "never sent": a draft due today or earlier may be gone because the routine sent it. Only a
//      draft due after today is recorded gone on not-found; the rest is left to reconciliation, which now also reads
//      a stopped person's drafts due on or before today, and records sent (or gone unsent) from in:sent.
//   2. outcomes status (outbox ticks) and sync (mailbox, CRM, LinkedIn, app replies) hand out the delete steps too.
//   3. a delete answer counts only when empty or a known success shape.
//   4. get_draft is gone only on an error answer that says not found; a readable draft is never gone.
//   5. a confirmed-deleted draft leaves the routine's queue. 6. create is refused whenever a saved routine file exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as H_ from './fixtures/harness.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { world, addLines, ledgerLines, autosend, said, PEOPLE, NOW, EVENT, SLUG, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, readEvent, eventJson } from '../lib/autosend/common.mjs';
import { routineQueue, reconcileItems, reconcileSteps, reconcile, routineBody, routineStopWords, ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import { afterDraftGone } from '../hooks/guard/autosend-drafts.mjs';
import { remoteTriggerCall } from '../hooks/guard/routine-trigger.mjs';
import { writeJson } from '../lib/jsonio.mjs';
import { join } from 'node:path';
import { seen, withSeen, withoutRecord } from './fixtures/guard-seen.mjs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
// Ana's message 2 due today (2026-10-12) when dueToday; every other draft due after the 20th.
function routineWorld({ dueToday = true, anaThree = null } = {}) {
  const w = world({ touches: 3, people: [ANA, BO], event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  [ANA, BO].forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-09', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= 3; t++) {
      const due = i === 0 && t === 2 && dueToday ? '2026-10-12' : i === 0 && t === 3 && anaThree ? anaThree : `2026-10-${20 + t}`;
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  return { ...w, nowMs };
}
const heldNow = (w, id, touch) => routineHeld(eventJson(w.evDir), readEvent(w.evDir).entries, id, touch);
const revokeAna = (w) => autosend(w.HOME, withSeen(w.HOME, ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')]), { claude: true });
const LATER = Date.parse(NOW) + 6 * 3600e3; // 14:00 UTC the same day
const notFound = (tool, draftId) => ({ hook_event_name: 'PostToolUseFailure', tool_name: `${GM}${tool}`, tool_input: { draftId }, error: 'Requested entity was not found.' });

test('1. a draft due today that reads not found is not recorded gone: it stays held, and reconciliation finds the send', () => {
  const w = routineWorld();
  const out = revokeAna(w);
  assert.ok(out.drafts_delete.some((s) => s.args.draftId === 'r02'));
  assert.match(out.next, /may already have sent/);
  for (const tool of ['delete_draft', 'get_draft']) assert.equal(afterDraftGone(notFound(tool, 'r02'), w.HOME, LATER), false, tool);
  assert.ok(heldNow(w, ANA.id, 2), 'still off the outbox and the send list');
  // A draft due after today: not found is gone.
  assert.equal(afterDraftGone(notFound('delete_draft', 'r03'), w.HOME, LATER), true);
  assert.equal(heldNow(w, ANA.id, 3), null);
  // Reconciliation reads the stopped draft due today: one in:sent search, one get_draft.
  const items = reconcileItems(w.evDir, LATER);
  const x = items.find((i) => i.draft_id === 'r02');
  assert.ok(x, 'reconcile covers a stopped draft due today');
  const steps = reconcileSteps(items);
  assert.ok(steps.some((s) => s.step === 'get_draft' && s.args.draftId === 'r02'));
  assert.ok(steps.some((s) => s.step === 'search' && s.key === ANA.email));
  const sent = JSON.stringify({ threads: [{ id: 't0', messages: [{ id: 's02', threadId: 't0', labelIds: ['SENT'], toRecipients: [ANA.email], date: '2026-10-12T08:01:00Z' }] }] });
  const gone = JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Requested entity was not found.' }] });
  const r = reconcile(w.evDir, items, { search: { [ANA.email]: sent }, draft: { r02: gone } }, LATER);
  assert.deepEqual(r.went.map((y) => [y.id, y.touch, y.message_id]), [[ANA.id, 2, 's02']]);
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'sent' && e.id === ANA.id && e.touch === 2 && e.message_id === 's02'));
  assert.equal(heldNow(w, ANA.id, 2), null, 'recorded sent: never offered again as unsent');
  // Gone with nothing in Sent (answers the session wrote, a search that may lag): never released from here. It stays
  // held, and the user is asked to check Gmail Sent; only their own word releases it (draft-gone, below).
  const w2 = routineWorld();
  revokeAna(w2);
  const r2 = reconcile(w2.evDir, reconcileItems(w2.evDir, LATER), { search: { [ANA.email]: '{}' }, draft: { r02: gone } }, LATER);
  assert.deepEqual(r2.gone, []);
  assert.match(r2.say, /check Gmail Sent for Ana Ito's message 2/);
  assert.match(r2.say, /draft-gone/);
  assert.ok(heldNow(w2, ANA.id, 2));
  assert.ok(!ledgerLines(w2.evDir).some((e) => e.type === 'autosend_draft_bad'));
  // Still there: held, said as stopped (not as the routine's hold), and no "paused".
  const w3 = routineWorld();
  revokeAna(w3);
  const r3 = reconcile(w3.evDir, reconcileItems(w3.evDir, LATER), { search: { [ANA.email]: '{}' }, draft: { r02: JSON.stringify({ id: 'r02', messageId: 'x', threadId: 't0' }) } }, LATER);
  assert.equal(r3.paused, false);
  assert.match(r3.say, /stopped/);
  assert.ok(heldNow(w3, ANA.id, 2));
});

test('1b. a successful delete of a draft due today still counts', () => {
  const w = routineWorld();
  revokeAna(w);
  assert.equal(afterDraftGone({ hook_event_name: 'PostToolUse', tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r02' }, tool_response: { content: [{ type: 'text', text: '{}' }] } }, w.HOME, LATER), true);
  assert.equal(heldNow(w, ANA.id, 2), null);
});

// 2. Behavioural (the reviewer's tests): a harness event turned routine, Ana's follow-up queued as a routine draft.
const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
function routineHarness() {
  const H = H_.setup({ attendees: ATT });
  H_.triage(H);
  H_.draftApprove(H);
  const evf = join(H.dir, 'event.json');
  const ev = JSON.parse(readFileSync(evf, 'utf8'));
  writeFileSync(evf, JSON.stringify({ ...ev, autosend: true, autosend_own: 'sam@lanecraft.example', autosend_mode: ROUTINE_MODE }));
  const ana = H_.idOf(H, 'Ana Berg');
  const lines = [
    { at: '2026-10-12T07:00:00Z', type: 'sent', who: 'user', id: ana, touch: 1, channel: 'email', date: '2026-10-09' },
    { at: '2026-10-12T07:01:00Z', type: 'autosend_approved', who: 'floorboss', id: ana, touch: 2, hash: 'h2', to: 'ana@acme.test', planned_due: '2026-10-20' },
    { at: '2026-10-12T07:02:00Z', type: 'autosend_drafted', who: 'floorboss', id: ana, touch: 2, hash: 'h2', to: 'ana@acme.test', due: '2026-10-20', draft_id: 'r-ana-2', thread_id: 'tA', run: 'run-1' }
  ];
  writeFileSync(join(H.dir, 'ledger.jsonl'), readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8') + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { H, ana };
}
const ccli = (H, args) => {
  const r = spawnSync('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: '2026-10-12T08:00:00Z', CLAUDECODE: '1', CODEX_SESSION_ID: '', CODEX_THREAD_ID: '' }, encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  }
};
const heldH = (H, id) => routineHeld(JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')), readLedger(join(H.dir, 'ledger.jsonl')).entries, id, 2);

test('2a. a reply read by outcomes sync (mailbox) hands out the delete step for the queued draft', () => {
  const { H, ana } = routineHarness();
  assert.ok(heldH(H, ana), 'auto-send has it before the reply');
  const sl = ccli(H, ['sync-list', '--event', H.slug]);
  assert.ok(!sl.ERROR, sl.ERROR);
  const people = JSON.parse(readFileSync(sl.file, 'utf8')).map((p) => ({ id: p.id, messages: p.id === ana ? [{ message_id: 'in1', direction: 'in', at: '2026-10-12T08:00:00Z', subject: 'Re: Test Expo' }] : [] }));
  const f = join(H.dir, 'mail.json');
  writeFileSync(f, JSON.stringify({ people }));
  const out = ccli(H, ['sync', '--event', H.slug, '--source', 'mailbox', '--file', f]);
  assert.ok(!out.ERROR, out.ERROR);
  assert.equal(out.saved, true);
  assert.deepEqual((out.drafts_delete || []).map((x) => x.args.draftId), ['r-ana-2'], JSON.stringify(out).slice(0, 800));
  assert.match(out.drafts_delete_say || '', /routine-body/);
  assert.ok(heldH(H, ana), 'held off the hand-send list until the delete is confirmed');
});

test('2b. outcomes status --none after a recorded reply still hands out the delete step', () => {
  const { H, ana } = routineHarness();
  const lines = [{ at: '2026-10-12T07:40:00Z', type: 'replied', who: 'user', id: ana, channel: 'email', date: '2026-10-12' }];
  writeFileSync(join(H.dir, 'ledger.jsonl'), readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8') + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = ccli(H, ['status', '--event', H.slug, '--none', '--said', 'nobody else replied']);
  assert.ok(!out.ERROR, out.ERROR);
  assert.deepEqual((out.drafts_delete || []).map((x) => x.args.draftId), ['r-ana-2'], JSON.stringify(out).slice(0, 800));
});

test('3. a delete answer counts only when empty or a known success; anything else needs a get_draft that reads not found', () => {
  const del = (w, tool_response) => afterDraftGone({ hook_event_name: 'PostToolUse', tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r02' }, tool_response }, w.HOME, w.nowMs);
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  for (const bad of [text('{"success":false,"message":"could not delete"}'), text('"Draft could not be deleted"'), text('null'), text('{"deleted":false}'), text('{"id":"r02"}'), text('Draft not deleted'), null]) {
    const w = routineWorld({ dueToday: false });
    revokeAna(w);
    assert.equal(del(w, bad), false, JSON.stringify(bad));
    assert.ok(heldNow(w, ANA.id, 2), JSON.stringify(bad));
  }
  for (const ok of [{}, text('{}'), text(''), { content: [] }, text('{"success":true}'), text('{"deleted":true}'), text('Draft deleted successfully.'), text('Successfully deleted draft r02')]) {
    const w = routineWorld({ dueToday: false });
    revokeAna(w);
    assert.equal(del(w, ok), true, JSON.stringify(ok));
  }
});

test('4. get_draft: a readable draft is never gone, whatever its body says; not found only from an error answer', () => {
  const get = (w, tool_response) => afterDraftGone({ hook_event_name: 'PostToolUse', tool_name: `${GM}get_draft`, tool_input: { draftId: 'r02' }, tool_response }, w.HOME, w.nowMs);
  const w = routineWorld({ dueToday: false });
  revokeAna(w);
  for (const body of [{ draft: { id: 'r02', message: { to: ANA.email, body: 'If the booking page shows not found, reply here.' } } }, { id: 'r02', body: 'error 404' }, { message: 'Requested entity was not found.' }])
    assert.equal(get(w, { content: [{ type: 'text', text: JSON.stringify(body) }] }), false, JSON.stringify(body));
  assert.ok(heldNow(w, ANA.id, 2));
  assert.equal(get(w, { isError: true, content: [{ type: 'text', text: 'Requested entity was not found.' }] }), true);
});

test('5. a confirmed-deleted draft leaves the routine\'s queue', () => {
  const w = routineWorld({ dueToday: false });
  addLines(w.evDir, [{ at: NOW, type: 'autosend_draft_deleted', who: 'guard', id: BO.id, touch: 2, draft_id: 'r12', how: 'delete_draft' }]);
  assert.ok(!routineQueue(w.evDir, w.nowMs).items.some((x) => x.draft_id === 'r12'));
});

test('6. RemoteTrigger create is refused whenever a saved routine file exists, recorded id or not', () => {
  const w = routineWorld({ dueToday: false });
  const b = routineBody(w.HOME, { event: SLUG, nowMs: w.nowMs, environmentId: 'env_01ABCDEFGHJK' });
  writeJson(join(w.HOME, 'autosend', 'routines', `${SLUG}.json`), { trigger_id: 'trig_01UNRECORDED0000001', hash: 'x' });
  assert.match(remoteTriggerCall({ action: 'create', body: b.body }, w.HOME, w.nowMs).refuse || '', /already saved a routine/);
});

// ---- Review of e452da2 ----
test('GAP-A: an error that isn\'t Gmail saying the draft is missing (a server, tool, account or auth "not found") records nothing', () => {
  const w = routineWorld({ dueToday: false });
  revokeAna(w);
  for (const error of ['MCP server "claude_ai_Gmail" not found', 'Tool delete_draft not found', 'User not found', 'Account not found', 'auth token not found', 'Connector not found (404)'])
    assert.equal(afterDraftGone({ hook_event_name: 'PostToolUseFailure', tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r03' }, error }, w.HOME, w.nowMs), false, error);
  assert.ok(heldNow(w, ANA.id, 3));
  for (const error of ['Requested entity was not found.', 'Draft r03 not found', 'No such draft'])
    assert.equal(afterDraftGone({ hook_event_name: 'PostToolUseFailure', tool_name: `${GM}get_draft`, tool_input: { draftId: 'r03' }, error }, routineWorldRevoked().HOME, w.nowMs), true, error);
});
const routineWorldRevoked = () => {
  const w = routineWorld({ dueToday: false });
  revokeAna(w);
  return w;
};

test('GAP-B: reconcile never records a stopped draft gone unsent from the answers the session wrote', () => {
  const w = routineWorld();
  revokeAna(w);
  const r = reconcile(w.evDir, reconcileItems(w.evDir, w.nowMs), { search: { [ANA.email]: '{}' }, draft: { r02: '{"isError":true,"content":[{"type":"text","text":"Requested entity was not found."}]}' } }, w.nowMs);
  assert.deepEqual(r.gone, []);
  assert.ok(heldNow(w, ANA.id, 2), 'still held');
  assert.ok(!ledgerLines(w.evDir).some((e) => ['autosend_draft_bad', 'autosend_draft_deleted'].includes(e.type)));
});

test('GAP-C: a stopped draft still in Drafts is never recorded sent from a thread match (the user wrote by hand)', () => {
  const w = routineWorld();
  revokeAna(w);
  const sent = JSON.stringify({ threads: [{ id: 't0', messages: [{ id: 'hand1', threadId: 't0', labelIds: ['SENT'], toRecipients: [ANA.email], date: '2026-10-12T07:50:00Z' }] }] });
  const there = JSON.stringify({ id: 'r02', message: { id: 'm02', threadId: 't0' } });
  const r = reconcile(w.evDir, reconcileItems(w.evDir, w.nowMs), { search: { [ANA.email]: sent }, draft: { r02: there } }, w.nowMs);
  assert.deepEqual(r.went, []);
  assert.ok(heldNow(w, ANA.id, 2));
  assert.ok(routineStopWords(w.evDir, SLUG, w.nowMs).drafts_delete.some((x) => x.args.draftId === 'r02'), 'the delete step is still given');
});

test('dueAfterToday: against the latest calendar day anywhere, so a zone can\'t make a possibly-sent draft read as deleted', () => {
  // 11:00 UTC on the 12th: Lisbon's 12th, already the 13th in Kiritimati. Ana's message 3 is due the 13th.
  const w = routineWorld({ dueToday: false, anaThree: '2026-10-13' });
  revokeAna(w);
  const at = Date.parse('2026-10-12T11:00:00Z');
  assert.equal(afterDraftGone({ hook_event_name: 'PostToolUseFailure', tool_name: `${GM}delete_draft`, tool_input: { draftId: 'r03' }, error: 'Requested entity was not found.' }, w.HOME, at), false);
  assert.ok(heldNow(w, ANA.id, 3));
});

test('draft-gone: the user\'s own word that they checked Gmail Sent and Drafts releases a stopped step; nothing else does', () => {
  const w = routineWorld();
  // In Claude Code each command needs the one-use record the guard writes (test/fixtures/guard-seen.mjs).
  const revArgs = ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')];
  seen(w.HOME, revArgs);
  assert.ok(!autosend(w.HOME, revArgs, { claude: true }).ERROR);
  const bare = (args) => autosend(w.HOME, ['draft-gone', '--event', SLUG, ...args], { claude: true });
  const run = (args) => {
    seen(w.HOME, ['draft-gone', '--event', SLUG, ...args], w.nowMs);
    return bare(args);
  };
  assert.match(run(['--id', ANA.id, '--touch', '2']).ERROR || '', /--said/);
  assert.match(run(['--id', BO.id, '--touch', '2', '--said-file', said(w.HOME, "it's not in Sent or Drafts")]).ERROR || '', /isn't waiting/, 'Bo\'s yes stands');
  assert.match(run(['--id', ANA.id, '--touch', '2', '--said-file', said(w.HOME, 'x')]).ERROR || '', /words/);
  // With no record (a form the guard didn't see): refused, nothing recorded.
  const words = said(w.HOME, "I looked: it's not in Sent and not in Drafts");
  assert.match(bare(['--id', ANA.id, '--touch', '2', '--said-file', words]).ERROR || '', /safety check did not see this command/);
  assert.ok(!ledgerLines(w.evDir).some((x) => x.type === 'autosend_draft_deleted'));
  const ok = run(['--id', ANA.id, '--touch', '2', '--said-file', words]);
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.match(ok.next, /outbox/);
  const e = ledgerLines(w.evDir).find((x) => x.type === 'autosend_draft_deleted');
  assert.deepEqual([e.who, e.draft_id, e.id, e.touch], ['user', 'r02', ANA.id, 2]);
  assert.match(e.said, /not in Sent/);
  assert.equal(heldNow(w, ANA.id, 2), null);
  // Codex refuses it.
  assert.ok(autosend(w.HOME, ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '3', '--said-file', said(w.HOME, 'not in Sent')]).ERROR);
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, draft-gone is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('draft-gone');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
