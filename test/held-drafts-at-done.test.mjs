// A draft held after two critic fails isn't in the outbox: the end of the run says so in one line, naming it,
// and an approval after the first one gives a short count instead of the whole paragraph again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home, run } from './fixtures/r2.mjs';

test('held drafts: named at done; a later approval says only how many are held', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  appendFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-12T07:00:00.000Z', type: 'answered', who: 'user', ask: 'rate', value: 'skipped', said: 'skip' })}\n`);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  let target = null;
  const steps = [];
  const per = simplePersona({
    slug: MOCK,
    asks: { check_these: (s) => s.ask.people.map((x) => `${x.id} different-person`).join('\n'), voice_samples: 'skip' },
    judge: { critic: (batch) => (batch.drafts || batch).map((d) => { target ||= d.id; return `${d.id}:${d.touch} ${d.id === target ? 'FAIL: says the sender met them, which nothing backs' : 'PASS'}`; }).join('\n') },
  });
  const r = drive(H, per, { maxSteps: 220, onStep: (s) => steps.push({ step: s.step, tell: s.tell_user || null }) });
  const name = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'contacts.json'), 'utf8')).find((x) => x.id === target).name;
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-5).join(' '));
  assert.match(r.last.tell_user || '', new RegExp(`One draft held after two critic fails and not in the outbox: ${name} \\(${target}\\) \\(edit, drop, or approve by id\\)\\.`));
  // A rewritten draft brings the approval back: the held paragraph isn't repeated, a count is given.
  const approvals = steps.filter((x) => x.step === 'approve');
  assert.match(approvals[0].tell || '', /held for you/);
  const other = (r.last.summary?.in_outbox_to_send || []).find((x) => x.id !== target && x.touch === 1);
  assert.ok(other, JSON.stringify(r.last.summary).slice(0, 300));
  const f = join(HOME, 'work', 'rev.txt');
  writeFileSync(f, 'shorter');
  const rev = run(HOME, 'event-outreach', ['revise', '--event', MOCK, '--ids', other.id, '--feedback-file', f]);
  assert.ok(!rev.ERROR, rev.ERROR);
  const again = [];
  drive(H, per, { maxSteps: 60, onStep: (s) => { if (s.step === 'approve') again.push(s.tell_user || ''); } });
  assert.ok(again.length, 'approved again');
  assert.doesNotMatch(again[0], /held for you/);
  assert.match(again[0], new RegExp(`One draft is still held after two critic fails \\(${target}\\)\\.`));
});
