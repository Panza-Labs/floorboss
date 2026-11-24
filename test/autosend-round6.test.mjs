// Round 6 (the review of 920f592):
// 1. a run belongs to the checkout that started it: another one resuming its id (a later cloud run) is refused, never
//    withdraws a send that may have gone, and never drops its lock; `sync end` can't drop a cloud run's lock;
// 2. the reply check's window starts from the day a hand send went, not the day it was recorded;
// 3. with auto-send on and the data folder a repo, flow next and the outbox rebuild on the laptop need the session's
//    lock (sync start); a revoke with no event named stops every auto-send event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { world, addLines, ledgerLines, remoteFor, cloneOf, remoteFile, autosend, said, PEOPLE, NOW, ROOT, SLUG, EVENT, approvedLines } from './fixtures/autosend-world.mjs';
import { pastProfile } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { query } from '../lib/autosend/replycheck.mjs';
import { stepMark, readEvent } from '../lib/autosend/common.mjs';

const at = (iso) => Date.parse(iso);
const AUTO_PICK = '1'; // the user's pick: 1, approve and send automatically
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');

// A cloud run's command, in its own process (each cloud run is its own container: nothing but the data repo is shared).
function cloud(HOME, now, args) {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  for (const k of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1200) };
  return JSON.parse(r.stdout);
}
const thenOf = (s, now) => {
  const [, h, , , , sub, , run, , file] = s.then;
  return cloud(h.slice('FLOORBOSS_HOME='.length), now, [sub, '--run', run, '--file', file]);
};
function pushed({ touches = 1, people = [PEOPLE[0]] } = {}) {
  const w = world({ touches, people });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: AUTO_PICK }, at(NOW));
  return { ...w, ...remoteFor(w.HOME) };
}
// Run X: search, release, the send shown; the model sends, then the run dies before `sent`.
function deadRun(bare, now = '2026-10-12T08:00:00Z') {
  const X = cloneOf(bare, 'x');
  let s = pastProfile(cloud(X, now, ['next', '--run', 'new']), (a) => cloud(X, now, a));
  assert.equal(s.step, 'search', JSON.stringify(s));
  writeFileSync(s.write, '[]');
  assert.equal(thenOf(s, now).checked, 'go');
  s = cloud(X, now, ['next', '--run', s.run]);
  assert.equal(s.step, 'send', JSON.stringify(s));
  return { X, run: s.run, send: s };
}
const remoteLedger = (bare) =>
  (remoteFile(bare, `events/${SLUG}/ledger.jsonl`) || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('finding 1: a later run resuming a dead run\'s id is refused: no withdraw, the lock kept, the send shown once, the step unsettled', () => {
  const { bare } = pushed();
  const { run } = deadRun(bare);
  const shown = [run];
  // An hour later, a fresh clone (a new container): the lock stops a new run, and resuming X's id is refused.
  const Y = cloneOf(bare, 'y');
  const T1 = '2026-10-12T09:00:00Z';
  assert.equal(cloud(Y, T1, ['next', '--run', 'new']).step, 'stop');
  for (const args of [['next', '--run', run], ['checked', '--run', run, '--file', join(Y, 'x.json')], ['sent', '--run', run, '--file', join(Y, 'x.json')]]) {
    const r = cloud(Y, T1, args);
    assert.match(r.ERROR || '', /started in another checkout/, `${args[0]}: ${JSON.stringify(r)}`);
  }
  // Nothing was withdrawn, and X's lock is still in the remote.
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_withdrawn'));
  assert.equal(JSON.parse(remoteFile(bare, 'autosend/lock.json')).run, run);
  // Later runs stop on the lock: the send is never shown again.
  const Z = cloneOf(bare, 'z');
  const z = cloud(Z, '2026-10-12T10:00:00Z', ['next', '--run', 'new']);
  assert.equal(z.step, 'stop', JSON.stringify(z));
  if (z.step === 'send') shown.push(z.run);
  assert.equal(shown.length, 1);
  // The step is unsettled (let go, nothing recorded since: it may have gone): it blocks every run until the user
  // checks Sent mail and settles it.
  const V = cloneOf(bare, 'v');
  assert.equal(stepMark(readEvent(join(V, 'events', SLUG)).entries, 'c001', 1), 'released');
  rmSync(join(V, 'autosend', 'lock.json'));
  process.env.FLOORBOSS_HOME = V;
  assert.match(dueNow(V, at('2026-10-12T10:00:00Z')).blocked || '', /c001 message 1: .*it may have gone/);
});

test('finding 1: the run in its own checkout, the send shown and not recorded: unclear, lock kept (never withdrawn)', () => {
  const { bare } = pushed();
  const { X, run } = deadRun(bare);
  const s = cloud(X, '2026-10-12T08:30:00Z', ['next', '--run', run]);
  assert.equal(s.step, 'stop');
  assert.equal(s.lock, 'kept');
  const led = remoteLedger(bare);
  assert.ok(led.some((e) => e.type === 'send_unclear' && e.id === 'c001'));
  assert.ok(!led.some((e) => e.type === 'autosend_withdrawn'));
});

test('finding 1: the run file alone (no local mark of the checkout that started it) is refused', () => {
  const { bare } = pushed();
  const { X, run } = deadRun(bare);
  rmSync(join(X, '.git', 'floorboss-autosend'), { recursive: true, force: true });
  assert.match(cloud(X, '2026-10-12T08:30:00Z', ['next', '--run', run]).ERROR || '', /started in another checkout/);
  assert.equal(JSON.parse(remoteFile(bare, 'autosend/lock.json')).run, run);
});

test("finding 1: sync end can't drop a cloud run's lock: refused in the cloud, and on the laptop for a lock the cloud holds", () => {
  const { bare } = pushed();
  const { run } = deadRun(bare);
  const Y = cloneOf(bare, 'y');
  assert.match(cloud(Y, '2026-10-12T09:00:00Z', ['sync', 'end', '--run', run]).ERROR || '', /laptop/);
  const L = cloneOf(bare, 'laptop');
  const r = autosend(L, ['sync', 'end', '--run', run], { now: '2026-10-12T09:00:00Z' });
  assert.match(r.ERROR || '', /held by the cloud.*sync unlock/s, JSON.stringify(r));
  assert.equal(JSON.parse(remoteFile(bare, 'autosend/lock.json')).run, run);
});

test('finding 2: after a hand send recorded days later, the reply check searches from the day it went', () => {
  const w = world({ touches: 2, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  // Message 1 sent by hand on Monday 12 October, recorded on Thursday 15.
  const THU = '2026-10-15T09:00:00Z';
  addLines(w.evDir, [{ at: THU, type: 'sent', who: 'user', id: 'c001', touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', source: 'user', said: 'I sent it Monday', message_id: 'h1', thread_id: 'ht1' }]);
  const rb = readback(w.evDir, at(THU));
  approve(w.evDir, { digest: rb.digest, said: AUTO_PICK }, at(THU));
  const due = ledgerLines(w.evDir).find((e) => e.type === 'autosend_approved' && e.touch === 2).planned_due;
  const it = dueNow(w.HOME, at(`${due}T09:00:00Z`)).due.find((x) => x.id === 'c001');
  assert.ok(it, 'message 2 is due');
  // 00:00 on 12 October in Lisbon (summer time) is 23:00 UTC on the 11th.
  assert.equal(it.since_ms, at('2026-10-11T23:00:00Z'));
  assert.match(query(it), new RegExp(`after:${at('2026-10-11T23:00:00Z') / 1000 - 86400} `));
});

test('item 3: with auto-send on and a repo, flow next and the outbox rebuild need the session lock (sync start)', () => {
  const { HOME } = pushed();
  const flow = spawnSync(process.execPath, [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', SLUG], {
    env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, CODEX_SESSION_ID: 's', CODEX_THREAD_ID: 't', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8'
  });
  assert.notEqual(flow.status, 0, flow.stdout);
  assert.match(String(flow.stderr), /sync start/);
  const out = spawnSync(process.execPath, [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'render', '--event', SLUG], {
    env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, CODEX_SESSION_ID: 's', CODEX_THREAD_ID: 't', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8'
  });
  assert.notEqual(out.status, 0, out.stdout);
  assert.match(String(out.stderr), /sync start/);
  // With the session's lock held, flow next runs.
  assert.equal(autosend(HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1'], { now: NOW }).started, true);
  const ok = spawnSync(process.execPath, [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', SLUG], {
    env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, CODEX_SESSION_ID: 's', CODEX_THREAD_ID: 't', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8'
  });
  assert.equal(ok.status, 0, ok.stderr);
});

test('item 3: revoke with no event named stops auto-send at every auto-send event', () => {
  const w = world({ touches: 1, people: [PEOPLE[0]] });
  const ev2 = { ...EVENT, slug: 'dock-fair', name: 'Dock Fair' };
  world({ touches: 1, people: [PEOPLE[1]], event: ev2, home: w.HOME });
  process.env.FLOORBOSS_HOME = w.HOME;
  for (const slug of [SLUG, 'dock-fair']) {
    const dir = join(w.HOME, 'events', slug);
    const rb = readback(dir, at(NOW));
    approve(dir, { digest: rb.digest, said: AUTO_PICK }, at(NOW));
  }
  const r = autosend(w.HOME, ['revoke', '--ids', 'all', '--said-file', said(w.HOME, 'stop auto-send')]);
  assert.ok(!r.ERROR, r.ERROR);
  for (const slug of [SLUG, 'dock-fair']) assert.ok(ledgerLines(join(w.HOME, 'events', slug)).some((e) => e.type === 'autosend_revoked'), slug);
  const skill = existsSync(join(ROOT, '.agents/skills/floorboss/SKILL.md')) ? String(spawnSync('cat', [join(ROOT, '.agents/skills/floorboss/SKILL.md')], { encoding: 'utf8' }).stdout) : '';
  assert.match(skill, /with no event named[^.]*every event/);
  void approvedLines;
});
