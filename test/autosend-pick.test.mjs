// The final approval as a choice (owner decision 2026-11-22): the options word for word, the Codex reply read as a
// pick, the Claude Code pick read only from what the AskUserQuestion tool answered (recorded by the guard), and the
// approval each pick writes. Every other approval check (list changed, text hash, days, account) still holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { world, addLines, approvedLines, ledgerLines, PEOPLE, NOW, EVENT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { PICKS, choiceFor, pickFromSaid, pickFromTool, recordPick, latestPick } from '../lib/autosend/pick.mjs';

const nowMs = Date.parse(NOW);
const toolInput = (choice, answer, extra = {}) => ({ session_id: 's1', tool_use_id: 'tu-1', tool_name: 'AskUserQuestion', tool_input: choice.ask_user_question, tool_response: { questions: choice.ask_user_question.questions, answers: { [choice.ask_user_question.questions[0].question]: answer } }, ...extra });
const choiceOf = (evDir, ready = true) => {
  const r = readback(evDir, nowMs);
  return { r, c: choiceFor({ slug: 'harbor-expo', digest: r.digest, messages: r.items.length, people: 3, autosendReady: ready }) };
};

test('the choice: four options word for word, pick 1 only when auto-send is set up, a marker for this readback', () => {
  const c4 = choiceFor({ slug: 'harbor-expo', digest: 'ab'.repeat(32), messages: 6, people: 3, autosendReady: true });
  const q = c4.ask_user_question.questions[0];
  assert.deepEqual(q.options.map((o) => o.label), ['Approve and send automatically (recommended)', 'Approve, and put them all in my Gmail drafts', "Approve; I'll send them myself", 'Not yet, I have changes']);
  assert.match(q.question, /6 messages to 3 people\? \(harbor-expo, approval abababababab\)$/);
  assert.equal(q.multiSelect, false);
  assert.ok(q.header.length <= 12);
  assert.match(c4.numbered, /^1\. Approve and send automatically/m);
  const c3 = choiceFor({ slug: 'harbor-expo', digest: 'ab'.repeat(32), messages: 6, people: 3, autosendReady: false });
  assert.deepEqual(c3.offered, [2, 3, 4]);
  assert.ok(!/send automatically/.test(c3.numbered));
  for (const t of [...JSON.stringify(c4), ...c4.numbered]) assert.notEqual(t, '—', 'no em dashes');
});

test('Codex: the reply is a number or an option\'s words; pick 1 never when auto-send is not set up', () => {
  assert.equal(pickFromSaid('1', true), 'auto');
  assert.equal(pickFromSaid(' Option 2. ', true), 'drafts');
  assert.equal(pickFromSaid("approve; i'll send them myself", true), 'self');
  assert.equal(pickFromSaid('4', true), 'changes');
  for (const s of ['yes', 'auto-send these sequences', 'approve', '12', '1 and 2', '']) assert.equal(pickFromSaid(s, true), null, s);
  assert.equal(pickFromSaid('1', false), null);
  assert.equal(pickFromSaid('Approve and send automatically (recommended)', false), null);
});

test('Claude Code: a pick is read only from floorboss\'s own question, shown word for word, as the tool answered it', () => {
  const { evDir } = world({ touches: 2 });
  const { c } = choiceOf(evDir);
  assert.equal(pickFromTool(toolInput(c, PICKS[0].label)).pick, 'auto');
  assert.equal(pickFromTool(toolInput(c, PICKS[1].label)).pick, 'drafts');
  const other = pickFromTool(toolInput(c, 'approve all except Bo'));
  assert.deepEqual([other.pick, other.text], ['other', 'approve all except Bo']);
  // Reworded options, an option added or taken away, multi-select, no marker: not floorboss's question.
  const bad = (f) => {
    const x = JSON.parse(JSON.stringify(c));
    f(x.ask_user_question.questions[0]);
    return pickFromTool(toolInput(x, PICKS[0].label));
  };
  assert.equal(bad((q) => (q.options[0].description = 'Nothing is sent.')), null);
  assert.equal(bad((q) => q.options.splice(1, 1)), null);
  assert.equal(bad((q) => q.options.push({ label: 'Send now', description: 'x' })), null);
  assert.equal(bad((q) => (q.multiSelect = true)), null);
  assert.equal(bad((q) => (q.question = q.question.replace(/\(harbor-expo.*$/, ''))), null);
  // No answer (the tool gave none), or an answer to another question: nothing.
  assert.equal(pickFromTool({ ...toolInput(c, PICKS[0].label), tool_response: { answers: {} } }), null);
  assert.equal(pickFromTool({ ...toolInput(c, PICKS[0].label), tool_response: 'not json' }), null);
});

test('Claude Code: approve takes the recorded pick for this readback, fresh and once; a stale, foreign or used pick approves nothing', () => {
  const { HOME, evDir } = world({ touches: 2 });
  const { r, c } = choiceOf(evDir);
  assert.equal(recordPick(HOME, toolInput(c, PICKS[0].label), nowMs), true);
  const rec = latestPick(HOME, 'harbor-expo');
  assert.equal(rec.pick, 'auto');
  // Too old.
  assert.throws(() => approve(evDir, { digest: r.digest, recorded: rec }, nowMs + 31 * 60000), /more than 30 minutes/);
  // For another readback.
  assert.throws(() => approve(evDir, { digest: r.digest, recorded: { ...rec, digest12: '0'.repeat(12) } }, nowMs), /another readback/);
  // No call id.
  assert.throws(() => approve(evDir, { digest: r.digest, recorded: { ...rec, call: '' } }, nowMs), /already used/);
  const out = approve(evDir, { digest: r.digest, recorded: rec }, nowMs);
  assert.equal(out.pick, 'auto');
  const lines = ledgerLines(evDir).filter((e) => e.type === 'autosend_approved');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((l) => l.pick_call === 'tu-1' && l.said === `picked: ${PICKS[0].label}`));
  // A replay of the same pick after the list changed: a new readback, and the old pick is for another one.
  addLines(evDir, [{ at: NOW, type: 'keep', who: 'user', ids: ['c001', 'c002', 'c003'], said: 'keep these' }]);
  const r2 = readback(evDir, nowMs + 1000);
  assert.ok(r2.items.length);
  assert.throws(() => approve(evDir, { digest: r2.digest, recorded: rec }, nowMs + 1000), /another readback|already used/);
  assert.throws(() => approve(evDir, { digest: r2.digest, recorded: { ...rec, digest12: r2.digest.slice(0, 12) } }, nowMs + 1000), /already used/);
});

test('a pick of the user\'s own words, or "Not yet", approves nothing and says what to do', () => {
  const { HOME, evDir } = world({ touches: 1 });
  const { r, c } = choiceOf(evDir);
  recordPick(HOME, toolInput(c, 'approve all except Bo', { tool_use_id: 'tu-2' }), nowMs);
  assert.throws(() => approve(evDir, { digest: r.digest, recorded: latestPick(HOME, 'harbor-expo') }, nowMs), /the user wrote "approve all except Bo"\. Read it back/);
  recordPick(HOME, toolInput(c, PICKS[3].label, { tool_use_id: 'tu-3' }), nowMs);
  assert.throws(() => approve(evDir, { digest: r.digest, recorded: latestPick(HOME, 'harbor-expo') }, nowMs), /has changes/);
  assert.ok(!ledgerLines(evDir).some((e) => ['autosend_approved', 'drafts_approved', 'send_choice'].includes(e.type)));
});

test('pick 2 and pick 3 write their own lines, never an auto-send yes; the readback then has nothing waiting', () => {
  for (const [said, type] of [['2', 'drafts_approved'], ['3', 'send_choice']]) {
    const { evDir } = world({ touches: 2 });
    const r = readback(evDir, nowMs);
    const out = approve(evDir, { digest: r.digest, said }, nowMs);
    assert.equal(out.approved, 6);
    const ls = ledgerLines(evDir);
    assert.equal(ls.filter((e) => e.type === type).length, 6, type);
    assert.ok(!ls.some((e) => e.type === 'autosend_approved'), 'no auto-send yes');
    assert.equal(readback(evDir, nowMs).items.length, 0, `${type}: nothing waits`);
    // A new text for one message: that person is asked about again.
    addLines(evDir, approvedLines(evDir, PEOPLE[1], 2, { extra: ' Edited.' }).lines);
    assert.deepEqual([...new Set(readback(evDir, nowMs).items.map((x) => x.id))], ['c002']);
  }
});

test('pick 1 is not offered for an event with auto-send off, in either host', () => {
  const { evDir } = world({ touches: 1, event: { ...EVENT, autosend: false } });
  const r = readback(evDir, nowMs);
  assert.throws(() => approve(evDir, { digest: r.digest, said: '1' }, nowMs), /numbered options \(2, 3, 4\)/);
  assert.equal(approve(evDir, { digest: r.digest, said: '3' }, nowMs).pick, 'self');
  assert.ok(readFileSync(join(evDir, 'ledger.jsonl'), 'utf8').includes('"send_choice"'));
});
