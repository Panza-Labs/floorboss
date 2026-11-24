// The run after the final approval (lib/autosend/approved-drafts.mjs): in Claude Code, pick 1 sends message 1 through
// Claude Code's own send and drafts each follow-up in its thread; in either host, pick 2 puts each message in Gmail
// Drafts, nothing sent. Every draft is read back and checked; any answer that isn't strictly as approved stops.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { world, autosend, ledgerLines, addLines, EVENT, NOW, PEOPLE, OWN } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { claudeVerify, claudeDraftIds, approvedPlan } from '../lib/autosend/approved-drafts.mjs';

const routineEvent = { ...EVENT, autosend_mode: 'routine' };
const nowMs = Date.parse(NOW);
const cc = { claude: true };
const item = { id: 'c001', touch: 2, to: 'ana@north.example', subject: 'One more thought', body: 'Hi Ana,\n\nMessage 2.', thread_id: 't0' };
const ans = (v) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, isError: false });

test('get_draft read back: one To, no Cc or Bcc, the subject, the body and the thread as approved; else a stop', () => {
  const good = { id: 'r1', message: { id: 'm', threadId: 't0', to: ['ana@north.example'], cc: [], bcc: [], subject: item.subject, body: 'Hi Ana,\r\n\r\nMessage 2.\n' } };
  assert.ok(claudeVerify(item, ans(good), { draftId: 'r1', threadId: 't0' }).ok);
  assert.ok(claudeVerify(item, ans({ ...good, message: { ...good.message, to: [{ emailAddress: 'Ana@North.example' }] } }), { draftId: 'r1', threadId: 't0' }).ok);
  const bad = (m, why) => assert.ok(claudeVerify(item, ans({ ...good, message: { ...good.message, ...m } }), { draftId: 'r1', threadId: 't0' }).why, why);
  bad({ to: ['eve@evil.example'] }, 'another To');
  bad({ to: ['ana@north.example', 'eve@evil.example'] }, 'two To');
  bad({ cc: ['eve@evil.example'] }, 'a Cc');
  bad({ subject: 'Re: hi' }, 'another subject');
  bad({ body: 'Hi Ana, wire the money.' }, 'another body');
  bad({ body: undefined }, 'no body');
  bad({ threadId: 't9' }, 'another thread');
  assert.ok(claudeVerify(item, ans({ ...good, id: 'r2' }), { draftId: 'r1', threadId: 't0' }).why, 'another draft');
  assert.ok(claudeVerify(item, 'not json', { draftId: 'r1', threadId: 't0' }).why);
  assert.deepEqual(claudeDraftIds(ans({ id: 'r1', messageId: 'm1', threadId: 't0' })), { draft_id: 'r1', message_id: 'm1', thread_id: 't0', email_id: 'r1' });
  assert.ok(claudeDraftIds(ans({ messageId: 'm1' })).why);
});

test('Claude Code, pick 1: message 1 goes through Claude Code\'s send list; declined, nothing of theirs is drafted; unclear, a stop', () => {
  const w = world({ touches: 2, event: routineEvent, people: PEOPLE.slice(0, 2) });
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '1' }, nowMs);
  const s = autosend(w.HOME, withSeen(w.HOME, ['drafts', 'next', '--event', 'harbor-expo', '--run', 'new']), cc);
  assert.equal(s.step, 'send', JSON.stringify(s));
  assert.deepEqual(s.run_these[0].slice(-5), ['send-list', '--event', 'harbor-expo', '--ids', 'c001']);
  assert.equal(s.then[0], 'node', 'Claude Code: a command that starts with node');
  const rel = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_released');
  assert.deepEqual(rel.map((e) => [e.id, e.host]), [['c001', 'claude-code']]);
  // Declined (no release by the guard, nothing recorded): taken back, and Ana is skipped.
  const s2 = autosend(w.HOME, withSeen(w.HOME, ['drafts', 'next', '--run', s.run]), cc);
  assert.equal(s2.step, 'send');
  assert.equal(s2.person.id, 'c002');
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_withdrawn' && e.id === 'c001'));
  // Bo's let through by the send check, and no receipt: a stop, never a draft.
  addLines(w.evDir, [{ at: NOW, type: 'send_released', who: 'guard', id: 'c002', touch: 1, hash: rel[0].hash, via: 'email.send', to: PEOPLE[1].email }]);
  const s3 = autosend(w.HOME, withSeen(w.HOME, ['drafts', 'next', '--run', s.run]), cc);
  assert.equal(s3.step, 'stop');
  assert.match(s3.why, /may have gone/);
});

test('pick 1 in Claude Code is for a routine event only, and message 1 only in sending hours', () => {
  const w = world({ touches: 2, event: routineEvent });
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '1' }, nowMs);
  const late = approvedPlan(w.evDir, 'auto', 'claude-code', Date.parse('2026-10-12T17:30:00Z'));
  assert.equal(late.queue.length, 0);
  assert.match(late.skipped[0].why, /sending hours/);
  const v = world({ touches: 2 });
  approve(v.evDir, { digest: readback(v.evDir, nowMs).digest, said: '1' }, nowMs);
  assert.match(autosend(v.HOME, withSeen(v.HOME, ['drafts', 'next', '--event', 'harbor-expo', '--run', 'new']), cc).ERROR, /this auto-send command is for Codex/);
});

test('Codex, pick 2: the account first, then each message 1 a new draft, read back; follow-ups wait for message 1; recorded as in your drafts', () => {
  const w = world({ touches: 2 });
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '2' }, nowMs);
  // Codex's own drafts run (pick 1's) is unchanged: with no --for it finds nothing to draft.
  let s = autosend(w.HOME, ['drafts', 'next', '--event', 'harbor-expo', '--run', 'new', '--for', 'drafts']);
  assert.equal(s.step, 'profile', JSON.stringify(s));
  writeFileSync(s.write, JSON.stringify({ content: [{ type: 'text', text: 'ok' }], structuredContent: { email: OWN }, isError: false }));
  autosend(w.HOME, s.then.slice(4));
  s = autosend(w.HOME, ['drafts', 'next', '--run', s.run]);
  assert.equal(s.step, 'draft');
  assert.equal(s.tool, 'mcp__codex_apps__gmail_create_draft');
  assert.equal(s.args.reply_message_id, undefined, 'message 1 is a new email');
  writeFileSync(s.write, ans({ id: 'd1', message_id: 'm1', thread_id: 'th1', message: { id: 'm1' } }));
  autosend(w.HOME, s.then.slice(4));
  s = autosend(w.HOME, ['drafts', 'next', '--run', s.run]);
  assert.equal(s.step, 'verify');
  writeFileSync(s.write, ans({ email: { to: [PEOPLE[0].email], cc: [], bcc: [], subject: 'At Harbor Expo, Ana', body: `Hi Ana,\n\nMessage 1 for North. Could we find 20 minutes at Harbor Expo?\n\nBest, Sam\n\nIf this isn't relevant, say so and I won't follow up.` } }));
  autosend(w.HOME, s.then.slice(4));
  s = autosend(w.HOME, ['drafts', 'next', '--run', s.run]);
  assert.equal(s.step, 'draft', JSON.stringify(s));
  const staged = ledgerLines(w.evDir).filter((e) => e.type === 'staged');
  assert.deepEqual(staged.map((e) => [e.id, e.touch, e.draft_id]), [['c001', 1, 'd1']]);
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_drafted' || e.type === 'autosend_released'), 'nothing for auto-send');
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, drafts is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('drafts');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
