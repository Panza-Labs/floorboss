// A follow-up falls due by time passing alone: on its day the flow works out the drafting list again and
// drafts it, instead of saying "run again on or after <that day>" on that very day. A new run does the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona, drive } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, json } from './fixtures/r2.mjs';
import { execFileSync } from 'node:child_process';
import { ROOT } from './fixtures/harness.mjs';

const at = (HOME, now, skill, args) => { try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: envOf(HOME, { FLOORBOSS_NOW: now }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; } };

test('sent first messages, then the follow-up day comes with nothing new in the ledger: the next step drafts the follow-ups', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  const r = drive(H, per, { maxSteps: 220 });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  const ev = json(join(HOME, 'events', MOCK, 'event.json'));
  assert.ok(!(ev.settings?.sending?.channels || []).length, 'the mock sends nothing itself: follow-ups are worked out after each send');
  // Every approved first message is sent today, as the user would report it.
  const sent = (r.last.summary?.in_outbox_to_send || []).filter((x) => x.touch === 1).map((x) => x.id);
  assert.ok(sent.length, JSON.stringify(r.last.summary).slice(0, 300));
  const today = NOW.slice(0, 10);
  const f = join(HOME, 'work', 'sent.json');
  writeFileSync(f, JSON.stringify({ items: sent.map((who) => ({ who, what: 'sent', date: today })) }));
  const rec = run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
  assert.ok(!rec.ERROR, rec.ERROR);
  // Nothing connected can see replies: what came in is asked first in every later run (and after an hour), never
  // in the run that recorded the sends.
  assert.notEqual(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since');
  run(HOME, 'flow', ['next', '--new-run']);
  assert.equal(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since');
  const none = (now) => { const a = join(HOME, 'work', 'none.txt'); writeFileSync(a, 'none'); return at(HOME, now, 'flow', ['answer', '--event', MOCK, '--ask', 'replies_since', '--value-file', a]); };
  assert.ok(!none(NOW).ERROR);
  const after = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.ok(after.done || after.step === 'waiting', `${after.step}: nothing is due yet`);
  const due = (after.summary?.follow_ups_due || []).map((d) => d.due).sort()[0];
  assert.ok(due, JSON.stringify(after.summary).slice(0, 400));
  const lines = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  // The due day, mid-morning in the event's time: nothing new in the ledger.
  const asked = at(HOME, `${due}T09:00:00Z`, 'flow', ['next', '--event', MOCK]);
  assert.equal(readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').length, lines, 'the ledger did not grow');
  assert.equal(asked.step, 'replies_since', 'days later, what came in is asked before the follow-ups are drafted');
  assert.ok(!none(`${due}T09:00:00Z`).ERROR);
  const s = at(HOME, `${due}T09:01:00Z`, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'draft', `${s.step}: ${JSON.stringify(s.summary?.note || s.why)}`);
  const todo = json(s.judge.read);
  assert.equal(todo.built_for_day, due);
  assert.ok(s.judge.ids.every((k) => Number(k.split(':')[1]) === 2), s.judge.ids.join());
});

test('a new run works the drafting list out again, even on the same day with nothing new in the ledger', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  const r = drive(H, per, { maxSteps: 220 });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  const todoFile = join(HOME, 'events', MOCK, 'derived', 'todo.json');
  const before = json(todoFile);
  // An old drafting list (from before this change: no day or run on it) is worked out again too.
  writeFileSync(todoFile, JSON.stringify({ ...before, run: 'an-earlier-run' }));
  run(HOME, 'flow', ['next', '--new-run']);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.ok(!s.ERROR, s.ERROR);
  const now = json(todoFile);
  assert.notEqual(now.run, 'an-earlier-run', 'the new run worked the list out again');
  assert.ok(now.run, 'the list names the run it was worked out in');
});
