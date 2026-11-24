// A drafter that returns the same failing text every round uses up its tries like any other: after three it stops,
// the draft is stuck and said, the person is held with one line saying what to do, and the flow goes on for everyone
// else. Before, a rewrite word for word the same counted no try, and the draft step came back for ever. The case: whole
// sequences on (sending through the stand-in Gmail), and the LinkedIn note limit lowered to 40 before the follow-ups
// are written, so the drafter's follow-up notes fail their checks the same way each time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };

test('the same failing text every round stops after three tries; the person is held and said, the rest go on', { timeout: 1200000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } }));
  loadMock(HOME);
  // The first ten people's profile links, as LinkedIn ones: their follow-ups on LinkedIn are notes to paste, held to
  // the note limit. Everyone else keeps email only.
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  const rows = readFileSync(list, 'utf8').split('\n');
  writeFileSync(list, rows.map((l, i) => (i >= 1 && i <= 10 ? l.replace('https://example.com/in/', 'https://www.linkedin.com/in/') : l)).join('\n'));
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  let lowered = false;
  const trail = [], told = [], draftIds = [];
  let r;
  try {
    r = drive(H, per, { maxSteps: 150, onStep: (s) => {
      trail.push(s.step);
      if (s.tell_user) told.push(s.tell_user);
      if (s.step === 'draft') draftIds.push(s.judge.ids);
      // After the first messages are written, before the follow-ups are.
      if (s.step === 'critic' && !lowered) {
        lowered = true;
        const f = join(HOME, 'config.json');
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), linkedin_note_limit: 40 }));
      }
      // The first send: the flow is past the approval (sending itself is other tests' business).
      if (s.call) throw Object.assign(new Error('past the approval'), { reached: true });
    } });
  } catch (e) {
    if (!e.reached) throw e;
    r = { trail, last: { step: 'waiting' } };
  }
  assert.ok(r.last.done || ['waiting', 'second_yes'].includes(r.last.step), trail.slice(-8).join(' → '));
  // Each follow-up is written at most three times, then left to the user.
  const tries = {};
  for (const ids of draftIds) for (const k of ids) tries[k] = (tries[k] || 0) + 1;
  assert.deepEqual(Object.entries(tries).filter(([, n]) => n > 3), [], JSON.stringify(tries));
  assert.ok(trail.includes('stuck_drafts'), trail.join(' '));
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stuck = Object.entries(tries).filter(([k, n]) => n === 3 && !led.some((x) => x.type === 'approved' && `${x.id}:${x.touch}` === k)).map(([k]) => k);
  assert.ok(stuck.length, JSON.stringify(tries));
  // The people held by a stuck follow-up are named, each with the message and what to say; none of theirs is approved.
  for (const k of stuck) {
    const id = k.split(':')[0];
    assert.ok(told.some((t) => t.includes(`(${id}) is held until`) && /rewritten or dropped/.test(t) && t.includes(`"drop `)), `${k}: ${JSON.stringify(told.slice(-2)).slice(0, 600)}`);
    assert.ok(!led.some((x) => x.type === 'approved' && x.id === id), `${id} was approved`);
  }
  // Everyone else went on: someone with no stuck message was approved.
  const stuckIds = new Set(stuck.map((k) => k.split(':')[0]));
  assert.ok(led.some((x) => x.type === 'approved' && !stuckIds.has(x.id)), `nobody else was approved: ${JSON.stringify(tries)} ${trail.slice(-12).join(' ')}`);
});
