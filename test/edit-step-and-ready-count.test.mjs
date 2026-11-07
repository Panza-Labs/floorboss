// "edit <id>" is followed by the edit (the file, then save-draft), never by the approval without it; "edit
// <id>: <text>" saves the text as the user's own edit; and an answer that only edits or drops leaves every other
// draft ready (it marked them all "left out", and the approval said "1 message is ready" of ten).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

function atApprove() {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const at = untilStep(H, per, 'approve');
  assert.equal(at.step, 'approve', at.trail.join(' '));
  return { HOME, H, per, at: at.last, ready: Number(/^(\d+) messages? (?:is|are) ready/.exec(at.last.why)[1]) };
}
const passCritic = (HOME, s) => { for (const ag of s.agents) { const ids = ag.then[ag.then.indexOf('--ids') + 1].split(','); writeFileSync(ag.write, ids.map((k) => `${k} PASS`).join('\n')); run(HOME, 'event-outreach', ag.then.slice(2)); } };
const messageIds = (HOME) => JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8')).jobs.filter((j) => j.kind === 'message' && j.touch === 1).map((j) => j.id);

test('approve: "edit <id>" makes the edit the next step; "done" saves the file as the user\'s edit, and every other draft stays ready', { timeout: 300000 }, () => {
  const { HOME, ready } = atApprove();
  assert.ok(ready >= 3, `ready: ${ready}`);
  const target = messageIds(HOME)[0];
  const r = answer(HOME, 'approve', `edit ${target}`);
  assert.ok(!r.ERROR, r.ERROR);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'edit_draft', JSON.stringify(s).slice(0, 400));
  assert.equal(s.ask.person.id, target);
  assert.match(s.ask.file, new RegExp(`${target}-t1\\.md$`));
  writeFileSync(s.ask.file, readFileSync(s.ask.file, 'utf8').replace(/\n\n/, '\n\nOne line I added myself.\n\n'));
  const saved = answer(HOME, 'edit_draft', 'done');
  assert.ok(!saved.ERROR, saved.ERROR);
  const crit = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(crit.step, 'critic', JSON.stringify(crit).slice(0, 300));
  passCritic(HOME, crit);
  const again = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(again.step, 'approve', JSON.stringify(again).slice(0, 300));
  assert.match(again.why, new RegExp(`^${ready} messages are ready`), 'the others were not left out by the edit');
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'drafted' && e.id === target && e.user_edited), 'saved as the user\'s edit');
});

test('approve: "edit <id>: <text>" saves that text as the user\'s edit, keeping the subject; "never mind" settles the edit step', { timeout: 300000 }, () => {
  const { HOME } = atApprove();
  const [a, b] = messageIds(HOME);
  const body = 'Hi there,\n\nA plain line of my own about Harbour & Haul Expo.\n\nSam';
  const r = answer(HOME, 'approve', `edit ${a}: ${body}`);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.edited, a);
  const md = readFileSync(r.result.file, 'utf8');
  assert.match(md, /^Subject: \S/, 'the draft\'s subject is kept');
  assert.match(md, /A plain line of my own/);
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.some((e) => e.type === 'drafted' && e.id === a && e.user_edited));
  answer(HOME, 'approve', `edit ${b}`);
  assert.equal(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'edit_draft');
  answer(HOME, 'edit_draft', 'never mind');
  assert.notEqual(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'edit_draft');
});
