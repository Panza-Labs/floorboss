// The mock event as a first-time user sees it: loaded, then driven through `flow next` with a persona that
// accepts the defaults. Onboarding is skipped for the mock (it comes with its settings); the run ends with
// approved messages in three or more structures and the blind ratings recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { drive, simplePersona, ROOT } from './lib/driver.mjs';
import { readLedger, fold } from '../../lib/ledger.mjs';

test('mock event: loaded, then hands-free to approved messages with few questions', { timeout: 600000 }, () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-mock-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  const now = '2026-10-12T08:00:00Z';
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  const H = { HOME, now, env: { ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home') } };
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', now], { env: H.env });
  const asked = [];
  const per = simplePersona({ slug: 'mock-harbour-haul', asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n') } });
  const run = drive(H, per, { maxSteps: 200, onStep: (s) => { if (s.ask) asked.push(s.ask.id); } });
  assert.ok(run.last.done);
  assert.ok(asked.length <= 12, `questions: ${asked.join(', ')}`);
  assert.ok(!asked.some((a) => /^(goal|company|team|crm_where)$/.test(a)), 'no onboarding questions for the mock');
  // The mock's research is canned: no research question, and its company briefs say they're canned.
  assert.ok(!asked.includes('research_scale'), `questions: ${asked.join(', ')}`);
  const briefs = readdirSync(join(HOME, 'events', 'mock-harbour-haul', 'companies')).filter((f) => f.endsWith('.md'));
  assert.ok(briefs.length > 0);
  for (const f of briefs) assert.match(readFileSync(join(HOME, 'events', 'mock-harbour-haul', 'companies', f), 'utf8'), /Mock event:.*canned/, f);
  const st = fold(readLedger(join(HOME, 'events', 'mock-harbour-haul', 'ledger.jsonl')).entries);
  const approved = Object.values(st.people).flatMap((p) => Object.values(p.touches).filter((t) => t.approved && t.kind === 'message'));
  assert.ok(approved.length >= 20, `approved: ${approved.length}`);
  assert.ok(new Set(approved.map((t) => t.structure)).size >= 3, 'three or more structures');
  assert.ok(Object.values(st.people).reduce((n, p) => n + p.ratings.length, 0) >= 10, 'the blind ratings were recorded');
  // After the mock, /floorboss:start is for a real event: it never reopens the finished mock.
  const after = JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--new-run'], { env: H.env, encoding: 'utf8' }));
  assert.notEqual(after.step, 'done', JSON.stringify(after).slice(0, 300));
  assert.notEqual(after.event, 'mock-harbour-haul');
});
