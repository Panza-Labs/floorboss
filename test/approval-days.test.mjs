// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Approval, sim run 1 (2026-11-21): the review lists every person's days in both hosts, so its text promises nothing it
// doesn't show; with auto-send on in Codex the approve text doesn't say "you send each one" and `next` waits at a
// second_yes step, never done with "Tick Sent".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, cli, ROOT } from './sims/lib/driver.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
function home(codex) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  H.env = codex ? { ...H.env, ...CODEX } : { ...H.env, CLAUDECODE: '1' };
  if (codex) delete H.env.CLAUDECODE;
  return H;
}
function toApprove(H, asks = {}) {
  const per = simplePersona({ asks: { setup_level: 'standard', list_source: join(H.HOME, 'inputs', 'attendees.csv'), touches: '3', check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip', daily_task: "yes, it's created", ...asks } });
  const STOP = new Error('stop');
  let at = null;
  try {
    drive(H, per, { maxSteps: 260, onStep: (s) => { if (s.step === 'approve') { at = s; throw STOP; } } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return at;
}

test('Claude Code: the approval review lists every person\'s days, and the step text promises only that', { timeout: 600000 }, () => {
  const H = home(false);
  const at = toApprove(H);
  assert.ok(at, 'reached approve');
  const r = cli(H, at.run_first[1].split('/skills/')[1].split('/')[0], at.run_first.slice(2));
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(Array.isArray(r.dates) && r.dates.length === r.people, JSON.stringify(r.dates));
  for (const d of r.dates) assert.ok(d.days.length >= 1 && d.days.every((x) => /\(message \d+\)/.test(x)), JSON.stringify(d));
  assert.ok(r.sample.every((m) => m.planned_day), 'each message shown carries its day');
  assert.match(r.show, /dates/);
});

test('Codex with auto-send on: the approve text says one more yes, and next waits at second_yes', { timeout: 600000 }, () => {
  const H = home(true);
  const at = toApprove(H, { sending: 'yes, send them from my Gmail', send_setup: 'sam@lanecraft.example' });
  assert.ok(at, 'reached approve');
  assert.doesNotMatch(at.why, /sends each one/);
  assert.match(at.why, /one more yes/i);
  const f = join(H.HOME, 'work', 'ap.json');
  writeFileSync(f, JSON.stringify('approve all'));
  const r = cli(H, 'flow', ['answer', '--ask', 'approve', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  const n = cli(H, 'flow', ['next']);
  assert.equal(n.step, 'second_yes', JSON.stringify(n).slice(0, 300));
  assert.notEqual(n.done, true);
  assert.doesNotMatch(JSON.stringify(n), /Tick Sent/);
  assert.equal(n.run_first[2], 'review');
  assert.ok(n.run_first.includes('--readback'));
});
