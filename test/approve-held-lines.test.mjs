// What the approval says about the people it holds, and what it does when it can't check. The approve step offers
// only what the gate's own rule (event-outreach approvable) would approve; when that check fails it offers nothing and
// says so, never everything. Each held line gives the advice that fits its reason: a damaged record line or a contact
// that can't be written to is said once with what fixes it (never "edit or drop"); a follow-up not written yet waits to
// be written; a copy edited by hand is saved again, as the gate says; without whole sequences, a later message held
// beside a first message on the same screen holds that message, not the person; a colleague note is a note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

// ---------- the lines themselves, from the gate's refusals ----------

const people = { c001: 'Ana Berg', c002: 'Bo Li', c003: 'Cy Ng', c004: 'Dee Ho' };
const nameOf = (id) => people[id] || id;
const heldLines = async (o) => (await import('../skills/flow/scripts/steps/approval.mjs')).heldLines(o);

test('a contact that cannot be written to is said once for everyone it holds, with what fixes it, and no edit or drop', async () => {
  const why = "can't be contacted now: line 336 of the ledger is damaged and doesn't say whose it is (it may hold a stop): look at it, fix or delete the line, then run again";
  const refused = ['c001', 'c002', 'c003'].map((id) => ({ id, touch: 1, kind: 'message', reason: why, cause: 'blocked', blocking: `${id}:1`, blocking_kind: 'message', why }));
  const h = (await heldLines({ refused, offered: [], candidates: refused.map((r) => `${r.id}:1`), nameOf, whole: true }));
  assert.equal(h.lines.length, 1, JSON.stringify(h.lines));
  assert.match(h.lines[0], /^floorboss can't write to 3 people now \(Ana Berg, Bo Li and Cy Ng\): line 336 of the ledger is damaged/);
  assert.match(h.lines[0], /fix or delete the line, then run again\.$/);
  assert.doesNotMatch(h.lines[0], /"edit |"drop |rewritten/);
  assert.equal(h.problem, true);
});

test('a follow-up not written yet is held until it is written; nothing says "rewritten"', async () => {
  const refused = [{ id: 'c004', touch: 1, kind: 'message', reason: "its sequence isn't ready: follow-up 2 not written yet", cause: 'unwritten', blocking: 'c004:3', blocking_kind: 'message', why: 'not written yet' }];
  const h = (await heldLines({ refused, offered: [], candidates: ['c004:1', 'c004:2'], nameOf, whole: true }));
  assert.deepEqual(h.lines, ['Dee Ho (c004) is held until follow-up 2 (c004:3) is written: it isn\'t written yet. Say "edit c004:3" to write it, or "drop c004:3".']);
});

test('a copy edited by hand: the line gives the user edit or drop, one bracket deep', async () => {
  const why = 'its text changed after the critic read it: save it again (save-draft) and send it to the critic again';
  const refused = [{ id: 'c004', touch: 2, kind: 'message', reason: why, cause: 'edited', blocking: 'c004:2', blocking_kind: 'message', why }];
  const [line] = (await heldLines({ refused, offered: [], candidates: ['c004:2'], nameOf, whole: true })).lines;
  assert.equal(line, 'Dee Ho (c004) is held until follow-up 1 (c004:2) is rewritten or dropped: its text changed after the critic read it. Say "edit c004:2" to fix it, or "drop c004:2".');
  assert.doesNotMatch(line, /\([^()]*\(/, 'no brackets inside brackets');
});

test('without whole sequences, a later message held beside the first on the same screen holds that message, not the person', async () => {
  const why = 'it is 145 characters, over the 144 LinkedIn allows in a connection note: it needs a shorter draft';
  const refused = [{ id: 'c001', touch: 2, kind: 'message', reason: why, cause: 'linkedin', blocking: 'c001:2', blocking_kind: 'message', why }];
  const [line] = (await heldLines({ refused, offered: ['c001:1'], candidates: ['c001:1', 'c001:2'], nameOf, whole: false })).lines;
  assert.equal(line, 'Follow-up 1 to Ana Berg (c001:2) is not offered until it is rewritten or dropped: it is 145 characters, over the 144 LinkedIn allows in a connection note: it needs a shorter draft. Say "edit c001:2" or "drop c001:2".');
  assert.doesNotMatch(line, /\(c001\) is held/);
});

test('without whole sequences, a follow-up that waits for the message before it says so, and that message says why', async () => {
  const edited = 'its text changed after it was saved: save it again (save-draft), then the critic reads it';
  const refused = [
    { id: 'c002', touch: 1, kind: 'message', reason: edited, cause: 'edited', blocking: 'c002:1', blocking_kind: 'message', why: edited },
    { id: 'c002', touch: 2, kind: 'message', reason: 'follow-up 1 waits for message 1 to be approved', cause: 'waits', blocking: 'c002:1', blocking_kind: 'message', why: "message 1 isn't approved" }
  ];
  const h = (await heldLines({ refused, offered: [], candidates: ['c002:1', 'c002:2'], nameOf, whole: false }));
  assert.deepEqual(h.lines, [
    'Bo Li (c002) is held until the first message (c002:1) is rewritten or dropped: its text changed after it was saved. Say "edit c002:1" to fix it, or "drop c002:1".',
    'Follow-up 1 to Bo Li (c002:2) waits for the first message (c002:1) to be approved.'
  ]);
});

test('a note to a colleague is called a note, never "the first message"', async () => {
  const why = 'script checks failing: names the person twice';
  const refused = [{ id: 'c003', touch: 1, kind: 'coordinate', reason: why, cause: 'checks', blocking: 'c003:1', blocking_kind: 'coordinate', why }];
  const [line] = (await heldLines({ refused, offered: [], candidates: ['c003:1'], nameOf, whole: true })).lines;
  assert.equal(line, 'Cy Ng (c003) is held until the note to your colleague about them (c003:1) is rewritten or dropped: script checks failing: names the person twice. Say "edit c003:1" or "drop c003:1".');
});

// ---------- in the flow ----------

const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };
// The mock event with whole sequences, driven to its first approval and left unanswered: copied for each case.
let STATE = null;
function state() {
  if (STATE) return STATE;
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } }));
  loadMock(HOME);
  // The mock's profile links, as LinkedIn ones: the people with no address get LinkedIn notes to paste.
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  writeFileSync(list, readFileSync(list, 'utf8').replaceAll('https://example.com/in/', 'https://www.linkedin.com/in/'));
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  try {
    drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 200, onStep: (s) => { if (s.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true }); } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  STATE = HOME;
  return HOME;
}
const copy = () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-held-'));
  cpSync(state(), H, { recursive: true });
  return H;
};
// As a session runs it: an answer is taken only for the question flow next asks (no out-of-turn switch).
const flow = (H, args, extra = {}) => {
  const env = envOf(H, extra);
  delete env.FLOORBOSS_OUT_OF_TURN;
  try {
    return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    return { ERROR: String(e.stderr || e.message).slice(0, 600) };
  }
};
const ledger = (H) => join(H, 'events', MOCK, 'ledger.jsonl');
const draftPath = (H, id, t) => join(H, 'events', MOCK, 'work', 'drafts', `${id}-t${t}.json`);

for (const fault of ['error', 'garbage'])
  test(`the gate's check fails (${fault}): nothing is offered, the user is told in plain words, and it stays that way`, { timeout: 600000 }, () => {
    const H = copy();
    try {
      for (let i = 0; i < 3; i++) {
        const s = flow(H, ['next', '--event', MOCK], { FLOORBOSS_FAIL_APPROVABLE: fault });
        assert.ok(!s.ERROR, s.ERROR);
        assert.equal(s.step, 'waiting', JSON.stringify(s).slice(0, 300));
        assert.equal(s.done, false);
        assert.equal(s.ask, undefined, 'no approval is asked');
        assert.match(s.tell_user, /^floorboss couldn't check which drafts can be approved, so it isn't asking you to approve anything now\. Nothing was approved or sent\./);
      }
      const f = join(H, 'work', 'a.txt');
      writeFileSync(f, 'approve all');
      const a = flow(H, ['answer', '--event', MOCK, '--ask', 'approve', '--value-file', f], { FLOORBOSS_FAIL_APPROVABLE: fault });
      assert.match(a.ERROR || '', /isn't asking "approve"/);
      assert.ok(!readFileSync(ledger(H), 'utf8').includes('"type":"approved"'), 'nothing approved');
    } finally {
      rmSync(H, { recursive: true, force: true });
    }
  });

test('a damaged record line: said once with what fixes it, no edit or drop for anyone, and the flow does not say it is done', { timeout: 600000 }, () => {
  const H = copy();
  try {
    appendFileSync(ledger(H), '{"type":"stop","at":"2026-10-12T08:00:00.000Z","who":"user","id":\n');
    const s = flow(H, ['next', '--event', MOCK]);
    assert.ok(!s.ERROR, s.ERROR);
    assert.notEqual(s.step, 'done', JSON.stringify(s).slice(0, 300));
    assert.notEqual(s.done, true);
    assert.doesNotMatch(s.why || '', /Nothing to do/);
    const t = String(s.tell_user || '');
    assert.equal((t.match(/ledger is damaged/g) || []).length, 1, t.slice(0, 600));
    assert.doesNotMatch(t, /"edit c\d+:\d+"|"drop c\d+:\d+"/);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('in the flow: a follow-up not written yet is held until it is written; a copy edited by hand gives edit or drop, one bracket deep', { timeout: 600000 }, () => {
  const H = copy();
  try {
    rmSync(draftPath(H, 'c018', 3));
    const f = draftPath(H, 'c004', 2);
    const d = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...d, body: `${d.body}\nP.S. by hand` }));
    const s = flow(H, ['next', '--event', MOCK]);
    assert.ok(!s.ERROR, s.ERROR);
    const t = String(s.tell_user || '');
    assert.match(t, /\(c018\) is held until follow-up 2 \(c018:3\) is written: it isn't written yet/);
    assert.doesNotMatch(t, /c018:3\) is rewritten/);
    // Lucas Moreau's line: from his name to the "drop" it ends with.
    const edited = (/[^.]*\(c004\) is held[\s\S]*?"drop c004:2"\./.exec(t) || [''])[0];
    assert.match(edited, /Say "edit c004:2" to fix it/);
    assert.doesNotMatch(edited, /\(save-draft\)/);
    assert.doesNotMatch(edited, /\([^()]*\(/, edited);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});
