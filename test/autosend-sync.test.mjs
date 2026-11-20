// U5 of auto-send (lib/autosend/sync.mjs): the data folder as a git checkout of the user's private repo, one writer at
// a time by a lock pushed before anything else, every checkpoint pushed. A bare repo in a temp folder is the remote;
// nothing leaves this machine. Cases 11 and 12 of the design; 13 and 14 end to end in test/sims/codex-autosend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, chmodSync, mkdirSync, appendFileSync } from 'node:fs';
import { world, remoteFor, cloneOf, commitsOf, remoteFile, git } from './fixtures/autosend-world.mjs';
import { start, checkpoint, end, unlock, isRepo, remoteUrl } from '../lib/autosend/sync.mjs';

const NOWMS = Date.parse('2026-10-12T09:00:00Z');
function setup() {
  const w = world({ touches: 1 });
  const r = remoteFor(w.HOME);
  return { ...w, ...r };
}
// A server-side hook on the fake remote that refuses every push (read-only, or another clone won the race).
function remoteMode(bare) {
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  const hook = join(bare, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "read-only remote" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}
// Nothing of floorboss's data left uncommitted (anything else in the folder isn't the repo's).
const clean = (dir) => git(dir, ['status', '--porcelain', '--', 'config.json', 'events', 'autosend']).trim() === '';

test('start on a clean clone: pull, take the lock, push it; end drops it and pushes', () => {
  const { HOME, bare } = setup();
  assert.equal(isRepo(HOME), true);
  assert.equal(remoteUrl(HOME), bare);
  const s = start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS });
  assert.deepEqual(s, { ok: true });
  assert.deepEqual(JSON.parse(remoteFile(bare, 'autosend/lock.json')), { who: 'laptop', run: 'r1', at: '2026-10-12T09:00:00.000Z' });
  assert.equal(commitsOf(bare)[0], 'lock laptop r1');
  appendFileSync(join(HOME, 'events', 'harbor-expo', 'ledger.jsonl'), '{"at":"2026-10-12T08:30:00Z","type":"reply_checked","who":"mailbox","id":"c001","source":"mailbox"}\n');
  assert.deepEqual(checkpoint({ home: HOME, message: 'after c001' }), { ok: true });
  assert.equal(commitsOf(bare)[0], 'after c001');
  assert.deepEqual(checkpoint({ home: HOME, message: 'nothing new' }), { ok: true }, 'nothing to commit is fine');
  assert.equal(commitsOf(bare)[0], 'after c001');
  assert.deepEqual(end({ home: HOME, runId: 'r1' }), { ok: true });
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.equal(commitsOf(bare)[0], 'unlock laptop r1');
  assert.ok(clean(HOME));
});

test('case 11: the laptop holds the lock, the cloud stops before anything and names it; a killed cloud run\'s lock stops the laptop until unlock', () => {
  const { HOME, bare } = setup();
  assert.deepEqual(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }), { ok: true });
  const cloud = cloneOf(bare);
  const before = commitsOf(bare);
  const s = start({ home: cloud, who: 'cloud', runId: 'c1', nowMs: NOWMS + 60000 });
  assert.match(s.stop, /held by the laptop \(run r1\) since 2026-10-12 09:00 UTC/);
  assert.deepEqual(commitsOf(bare), before, 'nothing pushed');
  assert.ok(clean(cloud));
  assert.deepEqual(end({ home: HOME, runId: 'r1' }), { ok: true });
  // A cloud run that died with the lock.
  const cloud2 = cloneOf(bare);
  assert.deepEqual(start({ home: cloud2, who: 'cloud', runId: 'c2', nowMs: NOWMS + 120000 }), { ok: true });
  const s2 = start({ home: HOME, who: 'laptop', runId: 'r2', nowMs: NOWMS + 180000 });
  assert.match(s2.stop, /held by the cloud \(run c2\)/);
  // unlock: shown first, removed only with the user's words; never from the cloud.
  assert.throws(() => unlock({ home: HOME, who: 'cloud', said: 'yes' }), /laptop/);
  const shown = unlock({ home: HOME, who: 'laptop' });
  assert.deepEqual(shown.lock, { who: 'cloud', run: 'c2', at: '2026-10-12T09:02:00.000Z' });
  assert.equal(shown.unlocked, false);
  assert.ok(remoteFile(bare, 'autosend/lock.json'));
  const done = unlock({ home: HOME, who: 'laptop', said: "I checked Sent mail, unlock it" });
  assert.equal(done.unlocked, true);
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.deepEqual(start({ home: HOME, who: 'laptop', runId: 'r3', nowMs: NOWMS + 240000 }), { ok: true });
});

test('start stops on changes not pushed, and on a pull that is not a fast-forward', () => {
  const { HOME, bare } = setup();
  appendFileSync(join(HOME, 'events', 'harbor-expo', 'ledger.jsonl'), '{"at":"2026-10-12T08:30:00Z","type":"reply_checked","who":"mailbox","id":"c001","source":"mailbox"}\n');
  assert.match(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }).stop, /changes not pushed/);
  git(HOME, ['add', '-A']);
  git(HOME, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'local only']);
  const other = cloneOf(bare);
  appendFileSync(join(other, 'events', 'harbor-expo', 'ledger.jsonl'), '{"at":"2026-10-12T08:30:00Z","type":"reply_checked","who":"mailbox","id":"c001","source":"mailbox"}\n');
  git(other, ['add', '-A']);
  git(other, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'remote only']);
  git(other, ['push', '-q']);
  assert.match(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }).stop, /moved apart|fast-forward/);
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
});

test('case 12: the remote moved after the clone (the laptop took the lock), or the lock push is rejected: stop, nothing pushed, the local lock commit undone', () => {
  const { HOME, bare } = setup();
  const cloud = cloneOf(bare);
  assert.deepEqual(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }), { ok: true });
  assert.match(start({ home: cloud, who: 'cloud', runId: 'c1', nowMs: NOWMS }).stop, /held by the laptop/);
  assert.deepEqual(end({ home: HOME, runId: 'r1' }), { ok: true });
  // Another clone wins the race between this one's pull and its push: the remote refuses the push (a server-side
  // hook stands in for the moved branch; a pre-receive hook can't move it itself).
  const cloud2 = cloneOf(bare);
  const head = git(cloud2, ['rev-parse', 'HEAD']).trim();
  const before = commitsOf(bare);
  remoteMode(bare, 'reject');
  const s = start({ home: cloud2, who: 'cloud', runId: 'c2', nowMs: NOWMS });
  assert.match(s.stop, /lock push was rejected/);
  assert.deepEqual(commitsOf(bare), before);
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.equal(git(cloud2, ['rev-parse', 'HEAD']).trim(), head);
  assert.ok(clean(cloud2));
});

test('a checkpoint whose push fails stops the run (it never throws); the lock taken at start is still in the remote', () => {
  const { HOME, bare } = setup();
  assert.deepEqual(start({ home: HOME, who: 'cloud', runId: 'c1', nowMs: NOWMS }), { ok: true });
  remoteMode(bare, 'reject');
  appendFileSync(join(HOME, 'events', 'harbor-expo', 'ledger.jsonl'), '{"at":"2026-10-12T08:30:00Z","type":"reply_checked","who":"mailbox","id":"c001","source":"mailbox"}\n');
  const r = checkpoint({ home: HOME, message: 'release c001' });
  assert.match(r.stop, /push failed/);
  assert.ok(remoteFile(bare, 'autosend/lock.json'));
  assert.equal(commitsOf(bare)[0], 'lock cloud c1');
  const e = end({ home: HOME, runId: 'c1' });
  assert.match(e.stop, /push failed/);
});

test('end leaves a lock that is not this run\'s alone', () => {
  const { HOME, bare } = setup();
  assert.deepEqual(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }), { ok: true });
  assert.match(end({ home: HOME, runId: 'other' }).stop, /isn't this run's/);
  assert.ok(remoteFile(bare, 'autosend/lock.json'));
});

test('a data folder that is not a git checkout is not one floorboss syncs', () => {
  const { HOME } = world({ touches: 1 });
  assert.equal(isRepo(HOME), false);
  assert.match(start({ home: HOME, who: 'laptop', runId: 'r1', nowMs: NOWMS }).stop, /isn't a git checkout/);
});

test('review M3: a lock younger than 30 minutes is not unlocked (a run may still be going)', () => {
  const { HOME, bare } = setup();
  const cloud = cloneOf(bare);
  const now = Date.now();
  assert.deepEqual(start({ home: cloud, who: 'cloud', runId: 'c1', nowMs: now - 10 * 60000 }), { ok: true });
  assert.match(unlock({ home: HOME, who: 'laptop', said: 'unlock it', nowMs: now }).say, /may still be going/);
  assert.ok(remoteFile(bare, 'autosend/lock.json'));
  assert.equal(unlock({ home: HOME, who: 'laptop', said: 'unlock it', nowMs: now + 25 * 60000 }).unlocked, true);
});
