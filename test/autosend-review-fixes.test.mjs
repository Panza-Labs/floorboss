// Fixes from the independent review of auto-send's send path (2026-11-20, after 71ac63c): a send is never shown
// before its release mark is confirmed in the remote (a killed push leaves the step due, nothing shown); Claude Code
// email sending switched on later holds every send; the laptop's state changes go through the sync (pull, lock,
// write, push), with a revoke that always wins and `sync repair` for a laptop that moved apart; a list change after
// the yes can be cleared by a fresh yes; the search's freshness measured from when it was given to the model, and the
// hours re-checked before a send is shown; the push goes to the branch's upstream; a bounce at another event holds the
// address. Fake remotes are bare repos in temp folders; nothing is sent and nothing leaves this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { world, addLines, ledgerLines, remoteFor, cloneOf, remoteFile, commitsOf, git, autosend, said, PEOPLE, NOW, EVENT, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { decide } from '../lib/autosend/replycheck.mjs';
import { start, end } from '../lib/autosend/sync.mjs';
import { next, checked } from '../skills/autosend/scripts/driver.mjs';

const at = (iso) => Date.parse(iso);
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const SENTENCE = 'auto-send these sequences';
const MARKERS = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, at(NOW));
  return w;
}
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';
const cloudEnv = (dir, now, extra = {}) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: dir, FLOORBOSS_NOW: now, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1', ...extra };
  delete env.CLAUDECODE;
  for (const k of MARKERS) delete env[k];
  return env;
};
const cli = (args, env, timeout) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = null;
  }
  return { status: r.status, signal: r.signal, out, err: String(r.stderr || '').slice(0, 600) };
};
// A world approved for auto-send and pushed to a fresh bare remote (the laptop's own folder is the first clone).
function pushedWorld(opts = {}) {
  const w = approved(opts);
  const { bare } = remoteFor(w.HOME);
  return { ...w, bare };
}
const remoteLedger = (bare, slug = 'harbor-expo') => (remoteFile(bare, `events/${slug}/ledger.jsonl`) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// One cloud run, in-process, through the driver, with the model answering each search with "no match", up to the
// first send step (returned, not answered) or the run's end.
function cloudUntilSend(bare, nowIso) {
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  let s = next(dir, { run: 'new', nowMs: at(nowIso) });
  const run = s.run;
  for (let i = 0; i < 20 && s.step === 'search'; i++) {
    writeFileSync(s.write, JSON.stringify({ messages: [] }));
    const c = checked(dir, { run, file: s.write, nowMs: at(nowIso) });
    if (c.step === 'stop') return { s: c, dir, run };
    s = next(dir, { run, nowMs: at(nowIso) });
  }
  return { s, dir, run };
}

// ---- Finding 1: never a send step before its release is confirmed in the remote.

test('finding 1: the checked step killed mid-push of its release: the next step is not a send; the step stays due and nothing was shown', { timeout: 120000 }, () => {
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  const dir = cloneOf(bare);
  // A git that hangs on push while the marker file is there (the process is killed meanwhile; the push never lands).
  const bin = mkdtempSync(join(tmpdir(), 'fb-as-bin-'));
  const marker = join(bin, 'hang');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "push" ] && [ -f "${marker}" ]; then sleep 8; exit 1; fi; done\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const when = '2026-10-12T09:00:00Z';
  const env = cloudEnv(dir, when, { PATH: `${bin}:${process.env.PATH}` });
  const s = cli(['next', '--run', 'new'], env).out;
  assert.equal(s.step, 'search');
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  writeFileSync(marker, '');
  const killed = cli(s.then.slice(s.then.indexOf('node') + 2), env, 2500);
  assert.ok(killed.signal || killed.status !== 0, 'the checked step was killed');
  execFileSync('rm', ['-f', marker]);
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_released'), 'the release never reached the remote');
  const n = cli(['next', '--run', s.run], env);
  assert.ok(n.out, n.err);
  assert.notEqual(n.out.step, 'send', JSON.stringify(n.out).slice(0, 300));
  assert.equal(n.out.step, 'stop');
  assert.match(n.out.why, /nothing was sent/);
  assert.ok(!('args' in n.out));
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null, 'the lock released');
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'send_unclear' || e.type === 'autosend_released'));
  // The step is still due: the next run asks for the search, then the send.
  const again = cloudUntilSend(bare, '2026-10-12T09:30:00Z');
  assert.equal(again.s.step, 'send', JSON.stringify(again.s).slice(0, 300));
  assert.deepEqual(again.s.args.to, [PEOPLE[0].email]);
});

// ---- Finding 2: Claude Code's email sending switched on after `autosend on`.

test('finding 2: Claude Code email sending turned on after the yes (in config or in the event) holds every send, with a plain reason', () => {
  const w = approved();
  writeFileSync(join(w.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'] } }));
  let r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(waitOf(r, 'c001'), /Claude Code sends email/);
  writeFileSync(join(w.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const ev = JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8'));
  writeFileSync(join(w.evDir, 'event.json'), JSON.stringify({ ...ev, settings: { sending: { channels: ['email'] } } }));
  r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(waitOf(r, 'c002'), /Claude Code sends email/);
});

test('finding 2 and 5: Claude Code email turned on between the release and the send step: the send is not shown, the release is withdrawn, and it stays due', { timeout: 120000 }, () => {
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  const now = at('2026-10-12T09:00:00Z');
  const s = next(dir, { run: 'new', nowMs: now });
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  assert.equal(checked(dir, { run: s.run, file: s.write, nowMs: now + 5000 }).checked, 'go');
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...cfg, sending: { channels: ['email'] } }));
  const n = next(dir, { run: s.run, nowMs: now + 10000 });
  assert.equal(n.step, 'stop', JSON.stringify(n).slice(0, 300));
  assert.match(n.why, /Claude Code sends email/);
  const led = remoteLedger(bare);
  assert.ok(led.some((e) => e.type === 'autosend_withdrawn' && e.id === 'c001'), 'withdrawn in the remote');
  assert.ok(!led.some((e) => e.type === 'send_unclear'));
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  // Config back as it was (in the remote: the test's own edit was pushed with the stop; put it back by hand).
  const fix = cloneOf(bare, 'fix');
  writeFileSync(join(fix, 'config.json'), JSON.stringify(cfg));
  git(fix, [...ID, 'commit', '-qam', 'config back']);
  git(fix, ['push', '-q']);
  const again = cloudUntilSend(bare, '2026-10-12T10:00:00Z');
  assert.equal(again.s.step, 'send', JSON.stringify(again.s).slice(0, 300));
});

// ---- Finding 5: freshness from the search's issue time; hours re-checked before showing a send.

test('finding 5: a search answered more than a few minutes after it was given is not released; a send shown after 17:00 or too late is withdrawn', { timeout: 120000 }, () => {
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  // Answered 10 minutes after the search was given: nothing released, the run stops.
  let dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  let t0 = at('2026-10-12T09:00:00Z');
  let s = next(dir, { run: 'new', nowMs: t0 });
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  let c = checked(dir, { run: s.run, file: s.write, nowMs: t0 + 10 * 60000 });
  assert.equal(c.step, 'stop', JSON.stringify(c).slice(0, 300));
  assert.match(c.why, /search again|minutes/);
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_released'));
  // Searched at 16:59 Lisbon, released at once, the send asked for at 17:00:10: withdrawn, not shown.
  dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  t0 = at('2026-10-12T15:59:00Z');
  s = next(dir, { run: 'new', nowMs: t0 });
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  assert.equal(checked(dir, { run: s.run, file: s.write, nowMs: t0 + 30000 }).checked, 'go');
  let n = next(dir, { run: s.run, nowMs: at('2026-10-12T16:00:10Z') });
  assert.equal(n.step, 'stop', JSON.stringify(n).slice(0, 300));
  assert.match(n.why, /17:00|hours/);
  assert.ok(remoteLedger(bare).some((e) => e.type === 'autosend_withdrawn'));
  // Released, then the send asked for 6 minutes after the search: withdrawn.
  dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  t0 = at('2026-10-13T09:00:00Z');
  s = next(dir, { run: 'new', nowMs: t0 });
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  assert.equal(checked(dir, { run: s.run, file: s.write, nowMs: t0 + 20000 }).checked, 'go');
  n = next(dir, { run: s.run, nowMs: t0 + 6 * 60000 });
  assert.equal(n.step, 'stop', JSON.stringify(n).slice(0, 300));
  assert.match(n.why, /search again|minutes/);
  // Still due: a prompt run sends it.
  const again = cloudUntilSend(bare, '2026-10-13T09:30:00Z');
  assert.equal(again.s.step, 'send', JSON.stringify(again.s).slice(0, 300));
});

// ---- Finding 3: the laptop's auto-send changes go through the sync.

// A cloud run that changes the remote (it takes the lock, writes its log, drops the lock).
function cloudTouches(bare, nowMs) {
  const c = cloneOf(bare);
  assert.deepEqual(start({ home: c, who: 'cloud', runId: `c${nowMs}`, nowMs }), { ok: true });
  mkdirSync(join(c, 'autosend'), { recursive: true });
  writeFileSync(join(c, 'autosend', `log-${nowMs}.md`), 'x\n');
  assert.deepEqual(end({ home: c, runId: `c${nowMs}` }), { ok: true });
}

test('finding 3: a revoke on the laptop pulls first, takes the lock, writes, pushes and drops the lock (the probe p5 case)', () => {
  const { HOME, bare } = pushedWorld();
  cloudTouches(bare, at(NOW));
  const r = autosend(HOME, ['revoke', '--event', 'harbor-expo', '--ids', 'all', '--said-file', said(HOME, 'stop auto-send')], { now: '2026-10-12T08:05:00Z' });
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.pushed, true, JSON.stringify(r));
  assert.ok(remoteLedger(bare).some((e) => e.type === 'autosend_revoked'), 'the revoke is in the remote');
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  assert.equal(git(HOME, ['status', '--porcelain', '--', 'config.json', 'events', 'autosend']).trim(), '');
  assert.equal(git(HOME, ['rev-list', '--count', '@{upstream}..HEAD']).trim(), '0');
});

test('finding 3: the pull fails (the laptop moved apart): approve and settle refuse and change nothing; a revoke is kept here and says to pause the scheduled task', () => {
  const { HOME, evDir, bare } = pushedWorld();
  // The laptop commits something it never pushes; the cloud moves the remote.
  writeFileSync(join(HOME, 'work', 'note.txt'), 'x');
  git(HOME, ['add', '-A']);
  git(HOME, [...ID, 'commit', '-qm', 'laptop only']);
  cloudTouches(bare, at(NOW));
  const before = readFileSync(join(evDir, 'ledger.jsonl'), 'utf8');
  const ap = autosend(HOME, ['approve', '--event', 'harbor-expo', '--digest', 'x', '--said-file', said(HOME, SENTENCE)], { now: '2026-10-12T08:05:00Z' });
  assert.match(ap.ERROR || '', /sync repair/);
  assert.equal(readFileSync(join(evDir, 'ledger.jsonl'), 'utf8'), before, 'nothing changed');
  const rv = autosend(HOME, ['revoke', '--event', 'harbor-expo', '--ids', 'c001', '--said-file', said(HOME, 'stop auto-send for Ana')], { now: '2026-10-12T08:06:00Z' });
  assert.ok(!rv.ERROR, rv.ERROR);
  assert.equal(rv.pushed, false);
  assert.match(rv.say, /pause/i);
  assert.match(rv.say, /Scheduled/);
  assert.match(rv.say, /sync repair/);
  assert.ok(ledgerLines(evDir).some((e) => e.type === 'autosend_revoked' && e.id === 'c001'), 'kept here');
});

test('finding 3: the cloud holds the lock: approve refuses with nothing changed; a revoke is kept here and the pause steps given', () => {
  const { HOME, evDir, bare } = pushedWorld();
  const c = cloneOf(bare);
  assert.deepEqual(start({ home: c, who: 'cloud', runId: 'c1', nowMs: at('2026-10-12T08:00:00Z') }), { ok: true });
  const before = readFileSync(join(evDir, 'ledger.jsonl'), 'utf8');
  const ap = autosend(HOME, ['approve', '--event', 'harbor-expo', '--digest', 'x', '--said-file', said(HOME, SENTENCE)], { now: '2026-10-12T08:05:00Z' });
  assert.match(ap.ERROR || '', /held by the cloud/);
  assert.equal(readFileSync(join(evDir, 'ledger.jsonl'), 'utf8'), before);
  const rv = autosend(HOME, ['revoke', '--event', 'harbor-expo', '--ids', 'all', '--said-file', said(HOME, 'stop auto-send')], { now: '2026-10-12T08:06:00Z' });
  assert.equal(rv.pushed, false, JSON.stringify(rv));
  assert.match(rv.say, /pause/i);
  assert.ok(ledgerLines(evDir).some((e) => e.type === 'autosend_revoked'));
});

test('finding 3: inside a laptop session (its own lock held), a revoke pushes at once and leaves the session lock in place', () => {
  const { HOME, bare } = pushedWorld();
  assert.equal(autosend(HOME, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-1']).started, true);
  const r = autosend(HOME, ['revoke', '--event', 'harbor-expo', '--ids', 'c002', '--said-file', said(HOME, 'stop Bo')], { now: '2026-10-12T08:05:00Z' });
  assert.equal(r.pushed, true, JSON.stringify(r));
  assert.ok(remoteLedger(bare).some((e) => e.type === 'autosend_revoked' && e.id === 'c002'));
  assert.equal(JSON.parse(remoteFile(bare, 'autosend/lock.json')).run, 'laptop-1');
  assert.deepEqual(autosend(HOME, ['sync', 'end', '--run', 'laptop-1']), { ok: true });
});

// (Recording a stop through the sync, on the full mock event: test/sims/codex-autosend.test.mjs.)

test('finding 3: sync repair replays the laptop\'s own lines onto a remote that moved; never drops a revoke; a second yes made apart is dropped and said', () => {
  const { HOME, evDir, bare } = pushedWorld();
  // The laptop, with no sync, revokes Ana and commits it locally (what an old session did); the cloud moves on.
  addLines(evDir, [{ at: '2026-10-12T08:01:00Z', type: 'autosend_revoked', who: 'user', id: 'c001', said: 'stop Ana' }]);
  addLines(evDir, [{ at: '2026-10-12T08:01:30Z', type: 'stop', who: 'user', id: 'c002', said: 'stop' }]);
  addLines(evDir, [{ at: '2026-10-12T08:01:40Z', type: 'autosend_approved', who: 'user', id: 'c003', touch: 1, hash: ledgerLines(evDir).find((e) => e.type === 'autosend_approved' && e.id === 'c003').hash, to: 'cy@west.example', planned_due: '2026-10-12', digest: 'd'.repeat(64), said: SENTENCE }]);
  git(HOME, ['add', '-A']);
  git(HOME, [...ID, 'commit', '-qm', 'laptop revoke']);
  const c = cloneOf(bare);
  addLines(join(c, 'events', 'harbor-expo'), [{ at: '2026-10-12T08:02:00Z', type: 'reply_checked', who: 'mailbox', id: 'c003', source: 'mailbox' }]);
  git(c, ['add', '-A']);
  git(c, [...ID, 'commit', '-qm', 'cloud line']);
  git(c, ['push', '-q']);
  // Plain sync start can't: not a fast-forward.
  assert.match(autosend(HOME, ['sync', 'start', '--who', 'laptop', '--run', 'l1']).stop || '', /sync repair/);
  const r = autosend(HOME, ['sync', 'repair'], { now: '2026-10-12T08:10:00Z' });
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.repaired, true, JSON.stringify(r));
  assert.equal(r.replayed, 2);
  assert.equal(r.dropped.length, 1);
  assert.match(r.say, /approve/);
  const led = remoteLedger(bare);
  const types = led.slice(-3).map((e) => e.type);
  assert.deepEqual(types, ['reply_checked', 'autosend_revoked', 'stop'], 'the cloud line kept, the laptop lines after it');
  assert.equal(git(HOME, ['rev-parse', 'HEAD']).trim(), git(bare, ['rev-parse', 'main']).trim());
  assert.equal(autosend(HOME, ['sync', 'start', '--who', 'laptop', '--run', 'l2']).started, true);
});

test('finding 3: sync repair refuses what it can\'t replay safely (a changed file other than a ledger), and changes nothing', () => {
  const { HOME, bare } = pushedWorld();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, tone: 'warm' }));
  git(HOME, ['add', '-A']);
  git(HOME, [...ID, 'commit', '-qm', 'laptop config']);
  cloudTouches(bare, at(NOW));
  const head = git(HOME, ['rev-parse', 'HEAD']).trim();
  const r = autosend(HOME, ['sync', 'repair'], { now: '2026-10-12T08:10:00Z' });
  assert.ok(r.ERROR || r.repaired === false, JSON.stringify(r));
  assert.match(r.ERROR || r.say || r.stop, /config\.json/);
  assert.equal(git(HOME, ['rev-parse', 'HEAD']).trim(), head, 'nothing changed');
  assert.ok(!remoteLedger(bare).some((e) => e.type === 'autosend_revoked'));
});

test('finding 3: the skill runs the sync commands, never git, and names sync repair and the pause steps', () => {
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  const part = skill.slice(skill.indexOf('## Auto-send from the cloud'));
  assert.match(part, /sync repair/);
  assert.match(part, /pause/i);
  assert.match(part, /never run git/);
});

// ---- Finding 4: a list change after the yes, cleared by a fresh second yes.

test('finding 4: after a list change post-yes, the readback offers the people it holds and a fresh yes clears them', () => {
  const w = approved();
  addLines(w.evDir, [{ at: '2026-10-12T08:10:00Z', type: 'keep', who: 'user', ids: ['c001', 'c002', 'c003'], said: 'keep these' }]);
  assert.deepEqual(dueNow(w.HOME, at('2026-10-12T09:00:00Z')).due, []);
  const rb = readback(w.evDir, at('2026-10-12T08:20:00Z'));
  assert.equal(new Set(rb.items.map((x) => x.id)).size, 3);
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at('2026-10-12T08:20:00Z'));
  assert.deepEqual(dueNow(w.HOME, at('2026-10-12T09:00:00Z')).due.map((x) => x.id), ['c001', 'c002', 'c003']);
});

// ---- Finding 6: test gaps.

test('finding 6: the user\'s own message in the thread before their reply: the reply still stops them', () => {
  const item = { to: 'ana@north.example', since_ms: at(NOW) };
  const ans = { threads: [{ id: 't1', messages: [{ from: 'Sam <sam@lanecraft.example>', subject: 'At Harbor Expo, Ana' }, { from: 'Ana Ito <ana@north.example>', subject: 'Re: At Harbor Expo, Ana' }] }] };
  const r = decide(item, JSON.stringify(ans), { own: 'sam@lanecraft.example' });
  assert.equal(r.stop, 'reply', JSON.stringify(r));
  assert.deepEqual(decide(item, JSON.stringify([{ from: 'sam@lanecraft.example' }]), { own: 'sam@lanecraft.example' }), { go: true });
});

test('finding 6: a later message already went (sent by hand) while an earlier one did not: the earlier one waits', () => {
  const w = approved();
  // (By auto-send's own record: a hand send ends auto-send for the person, a reason of its own: round 4, item 1.)
  addLines(w.evDir, [{ at: '2026-10-12T08:30:00Z', type: 'sent', who: 'floorboss', id: 'c001', touch: 2, via: 'email.send', channel: 'email', date: '2026-10-12', source: 'autosend' }]);
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), /a later message already went/);
  // Said before the hours (it never goes, whatever the time): at 17:30 in Lisbon too.
  assert.match(waitOf(dueNow(w.HOME, at('2026-10-12T16:30:00Z')), 'c001'), /a later message already went/);
});

// ---- Finding 7: small items.

test('finding 7: the push goes to the branch\'s upstream, not to a branch of the same name as the local one', () => {
  const { HOME, bare } = pushedWorld();
  git(HOME, ['checkout', '-q', '-b', 'laptop']);
  git(HOME, ['branch', '-q', '--set-upstream-to=origin/main']);
  assert.deepEqual(start({ home: HOME, who: 'laptop', runId: 'l1', nowMs: at(NOW) }), { ok: true });
  assert.equal(JSON.parse(remoteFile(bare, 'autosend/lock.json')).run, 'l1', 'the lock is on main');
  assert.equal(git(bare, ['branch', '--list', 'laptop']).trim(), '', 'no laptop branch on the remote');
  assert.deepEqual(end({ home: HOME, runId: 'l1' }), { ok: true });
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null);
  void commitsOf;
});

test('finding 7 and round 3 item 9: README setup step 1 is one floorboss command (a first commit, any branch name, no &&)', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const step = readme.slice(readme.indexOf('1. Make a new, empty private repo on GitHub'), readme.indexOf('2. Make a fine-grained GitHub token'));
  assert.match(step, /cli\.mjs" init --remote https:\/\/github\.com\/<you>\/<repo>/);
  assert.ok(!/&&/.test(step), 'no && (Windows PowerShell 5.1)');
  assert.ok(!/push -u origin main/.test(step), step);
  assert.match(step, /git push -u origin <your branch>/);
});

test('finding 7: an address that bounced at another event is held, as a stop there is', () => {
  const w = approved();
  const d = join(w.HOME, 'events', 'river-fair');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'event.json'), JSON.stringify({ slug: 'river-fair', name: 'River Fair', city: 'Porto', time_zone: 'Europe/Lisbon', start_date: '2026-11-20', end_date: '2026-11-21', settings: {} }));
  writeFileSync(join(d, 'ledger.jsonl'), [
    { at: NOW, type: 'person', who: 'floorboss', id: 'c010', name: 'Ana Ito', email: 'ana@north.example', company: 'North' },
    { at: NOW, type: 'bounced', who: 'user', id: 'c010', why: 'no such user' }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), /bounced at another of your events/);
});

test('finding 7: an auto-send release today to the same address at another event counts as a message today, whatever was recorded after it', () => {
  const w = approved();
  const other = { ...EVENT, slug: 'dock-days', name: 'Dock Days' };
  world({ touches: 1, home: w.HOME, event: other, people: [{ ...PEOPLE[1], id: 'c020' }] });
  const od = join(w.HOME, 'events', 'dock-days');
  const h = ledgerLines(od).find((e) => e.type === 'approved').hash;
  addLines(od, [
    { at: '2026-10-12T08:30:00Z', type: 'autosend_released', who: 'floorboss', id: 'c020', touch: 1, hash: h, to: PEOPLE[1].email, run: 'r0' },
    { at: '2026-10-12T08:40:00Z', type: 'release_cleared', who: 'user', id: 'c020', touch: 1, said: 'not in my Sent folder' }
  ]);
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c002'), JSON.stringify(r.due.map((x) => x.id)));
  assert.match(waitOf(r, 'c002'), /already went or is going today/);
  void existsSync;
  void dirname;
});
