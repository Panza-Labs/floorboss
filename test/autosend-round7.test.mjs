// Round 7 (the final review of cfc3edc):
// 1. a revoke of every event writes each event's stop on its own: one that fails loses none of the others, and every
//    revoke error says how to pause the cloud task and names the events not stopped;
// 2. the run's mark is checked and written before the lock is taken: a checkout it can't be written in never leaves
//    the lock in the remote;
// 3. sync start on the laptop takes over the laptop's own earlier lock (as the flow's lock check accepts it);
// 4. offline on the laptop: the refusals say plainly that auto-send events need the connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, renameSync } from 'node:fs';
import { world, ledgerLines, remoteFor, cloneOf, remoteFile, autosend, said, PEOPLE, NOW, ROOT, SLUG, EVENT } from './fixtures/autosend-world.mjs';
import { pastProfile } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';

const at = (iso) => Date.parse(iso);
const AUTO_PICK = '1'; // the user's pick: 1, approve and send automatically
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const PAUSE = /Pause the cloud task now/;

function cloud(HOME, now, args) {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  for (const k of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  return JSON.parse(r.stdout);
}
const flowNext = (HOME) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, CODEX_SESSION_ID: 's', CODEX_THREAD_ID: 't', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  return spawnSync(process.execPath, [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--event', SLUG], { env, encoding: 'utf8' });
};
function approvedWorld({ events = [EVENT], repo = true } = {}) {
  const w = world({ touches: 1, people: [PEOPLE[0]], event: events[0] });
  events.slice(1).forEach((ev, i) => world({ touches: 1, people: [PEOPLE[i + 1]], event: ev, home: w.HOME }));
  process.env.FLOORBOSS_HOME = w.HOME;
  for (const ev of events) {
    const dir = join(w.HOME, 'events', ev.slug);
    const rb = readback(dir, at(NOW));
    approve(dir, { digest: rb.digest, said: AUTO_PICK }, at(NOW));
  }
  return repo ? { ...w, ...remoteFor(w.HOME) } : w;
}
const DOCK = { ...EVENT, slug: 'dock-fair', name: 'Dock Fair' };

test('finding 1: revoke of every event, one event failing: the others stay stopped and pushed; the error pauses and names it', () => {
  const w = approvedWorld({ events: [EVENT, DOCK] });
  const led = join(w.HOME, 'events', SLUG, 'ledger.jsonl');
  chmodSync(led, 0o444);
  let r;
  try {
    r = autosend(w.HOME, ['revoke', '--ids', 'all', '--said-file', said(w.HOME, 'stop auto-send')]);
  } finally {
    chmodSync(led, 0o644);
  }
  assert.match(r.ERROR || '', PAUSE, JSON.stringify(r));
  assert.match(r.ERROR, /not stopped: harbor-expo/i);
  assert.ok(ledgerLines(join(w.HOME, 'events', 'dock-fair')).some((e) => e.type === 'autosend_revoked'), 'dock-fair stopped here');
  assert.match(remoteFile(w.bare, 'events/dock-fair/ledger.jsonl') || '', /autosend_revoked/, 'and in the repo');
});

test('finding 1: a revoke of one event that fails says how to pause and names the event', () => {
  const w = approvedWorld();
  const led = join(w.HOME, 'events', SLUG, 'ledger.jsonl');
  chmodSync(led, 0o444);
  let r;
  try {
    r = autosend(w.HOME, ['revoke', '--event', SLUG, '--ids', 'all', '--said-file', said(w.HOME, 'stop auto-send')]);
  } finally {
    chmodSync(led, 0o644);
  }
  assert.match(r.ERROR || '', PAUSE, JSON.stringify(r));
  assert.match(r.ERROR, /not stopped: harbor-expo/i);
});

test('finding 2: a checkout whose .git is not a plain folder: the run stops before the lock is taken', () => {
  const w = approvedWorld();
  const X = cloneOf(w.bare, 'x');
  const real = `${X}-gitdir`;
  renameSync(join(X, '.git'), real);
  writeFileSync(join(X, '.git'), `gitdir: ${real}\n`);
  const s = cloud(X, NOW, ['next', '--run', 'new']);
  assert.equal(s.step, 'stop', JSON.stringify(s));
  assert.equal(s.lock, 'not taken');
  assert.equal(remoteFile(w.bare, 'autosend/lock.json'), null, 'no lock in the remote');
  // A later run, in a plain checkout, goes on.
  const Y = cloneOf(w.bare, 'y');
  assert.equal(pastProfile(cloud(Y, '2026-10-12T09:00:00Z', ['next', '--run', 'new']), (a) => cloud(Y, '2026-10-12T09:00:00Z', a)).step, 'search');
});

test("finding 3: sync start on the laptop takes over the laptop's own earlier lock, and flow next agrees", () => {
  const w = approvedWorld();
  assert.equal(autosend(w.HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1'], { now: NOW }).started, true);
  // That session ended without sync end. The next one:
  const r = autosend(w.HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-2'], { now: '2026-10-12T10:00:00Z' });
  assert.equal(r.started, true, JSON.stringify(r));
  assert.equal(r.took_over, 'laptop-1');
  assert.match(r.say, /earlier laptop session.*nothing was sent/i);
  assert.equal(JSON.parse(remoteFile(w.bare, 'autosend/lock.json')).run, 'laptop-2');
  assert.equal(flowNext(w.HOME).status, 0);
  assert.deepEqual(autosend(w.HOME, ['sync', 'end', '--run', 'laptop-2']), { ok: true });
});

test("finding 4: offline on the laptop: sync start and flow next say plainly that auto-send events need the connection", () => {
  const w = approvedWorld();
  renameSync(w.bare, `${w.bare}-gone`);
  const r = autosend(w.HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1'], { now: NOW });
  assert.equal(r.started, false, JSON.stringify(r));
  assert.match(r.stop, /offline: auto-send events need the connection; connect and try again/);
  const f = flowNext(w.HOME);
  assert.notEqual(f.status, 0);
  assert.match(String(f.stderr), /offline: auto-send events need the connection; connect and try again/);
});
