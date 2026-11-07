// Skipping the critic is for one text: a draft edited after its review was skipped goes to the critic like any
// other, and approves once it passes (it used to wait for a verdict the flow never asked for).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';

test('skip review, edit, save: the edited draft goes to the critic, and approves after a PASS', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const first = untilStep(H, per, 'critic');
  assert.equal(first.step, 'critic', first.trail.join(' '));
  const skipped = run(HOME, 'event-outreach', ['skip-review', '--event', MOCK, '--all', '--said', 'skip the review, I will read them myself']);
  assert.ok(skipped.skipped_review?.length, JSON.stringify(skipped));
  const target = skipped.skipped_review[0].split(':')[0];
  // Nothing goes to the critic now: the drafts wait for the user's yes.
  const n1 = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.notEqual(n1.step, 'critic', JSON.stringify(n1).slice(0, 300));
  // The user edits one of them.
  const ed = run(HOME, 'event-outreach', ['gate', '--event', MOCK, '--answers', `edit ${target}`]);
  const md = ed.to_edit[0].file;
  writeFileSync(md, readFileSync(md, 'utf8').replace(/\n\n/, '\n\nOne line I added myself.\n\n'));
  const saved = run(HOME, 'event-outreach', ['save-draft', '--event', MOCK, '--id', target, '--touch', '1', '--md-file', md]);
  assert.equal(saved.checks, 'pass', JSON.stringify(saved));
  // The edited text is new: the flow sends it to the critic.
  let s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'critic', JSON.stringify(s).slice(0, 300));
  const ag = s.agents.find((a) => a.then.join(' ').includes(target));
  assert.ok(ag, 'the edited draft is in a critic batch');
  const ids = ag.then[ag.then.indexOf('--ids') + 1].split(',');
  writeFileSync(ag.write, ids.map((k) => `${k} PASS`).join('\n'));
  const v = run(HOME, 'event-outreach', ag.then.slice(2));
  assert.ok(!v.ERROR, v.ERROR);
  const g = run(HOME, 'event-outreach', ['gate', '--event', MOCK, '--answers', `approve ${target}`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.approved, 1, JSON.stringify(g));
  const led = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led.filter((e) => e.type === 'review_skipped').every((e) => /^[0-9a-f]{24}$/.test(e.hash)), 'each skip names the text it was for');
});
