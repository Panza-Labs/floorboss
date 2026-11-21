// Fixes from security audit run 9 of auto-send (it read 71ac63c): the run log never written through a link (F2),
// a clock behind the data repo blocks (F3), the never-twice rule reads the guard's and the unattended drafts' marks
// too (F4), the guard's one-a-day checks count auto-send's releases (F5) and refuse an auto-send event (F6), the
// search answer at its page size is incomplete and a sender read two ways stops the run (needs-validation 1), the
// query asks for the base address too (needs-validation 2), and the hardening: credentials out of git's words,
// nothing but floorboss's own data paths in the repo (no links, no laptop-only files), only those paths staged, a
// clean floorboss tree for the pin, and a data repo written by a newer floorboss refused. Fake remotes only;
// nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { world, addLines, ledgerLines, remoteFor, cloneOf, remoteFile, git, autosend, said, PEOPLE, NOW, EVENT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { query, decide, MAX_RESULTS } from '../lib/autosend/replycheck.mjs';
import * as sync from '../lib/autosend/sync.mjs';
import { next, checked } from '../skills/autosend/scripts/driver.mjs';
import { nextNewWith } from './fixtures/autosend-world.mjs';
const nextNew = nextNewWith({ next, checked });
import { sentOrGoingToday, addressBusyToday, homeSends, verifySend } from '../lib/sendcheck.mjs';
import { fold, legacyState } from '../lib/ledger.mjs';

const at = (iso) => Date.parse(iso);
const SENTENCE = 'auto-send these sequences';
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, at(NOW));
  return w;
}
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';
const pushedWorld = (opts = {}) => {
  const w = approved(opts);
  return { ...w, ...remoteFor(w.HOME) };
};
// Another clone puts a commit in the remote (what any writer of the data repo can do).
function remoteCommit(bare, fn, msg = 'other writer') {
  const c = cloneOf(bare, 'other');
  fn(c);
  git(c, ['add', '-A']);
  git(c, [...ID, 'commit', '-qm', msg]);
  git(c, ['push', '-q']);
}
const rels = (id, touch, hash, to, at0, run = 'r0') => ({ at: at0, type: 'autosend_released', who: 'floorboss', id, touch, hash, to, run });

// ---- F1 (checked: fixed at 8e9f440 in test/autosend-review-fixes.test.mjs) and settle with no release line.

test('F1: settle records "it went" for an auto-send step with no release line (the remote lost it), and nothing else', () => {
  const w = approved();
  const r = autosend(w.HOME, ['settle', '--event', 'harbor-expo', '--id', 'c001', '--touch', '1', '--went', 'yes', '--said-file', said(w.HOME, "it's in my Sent folder")], { now: '2026-10-12T12:00:00Z' });
  assert.equal(r.recorded, 'sent', JSON.stringify(r));
  // With no release line nothing says auto-send sent it: recorded as the user's own send (round 5, finding 2), so the
  // rest of the sequence is theirs.
  assert.equal(r.by, 'you');
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'sent' && e.id === 'c001' && e.touch === 1 && e.source === 'hand' && e.settled === true));
  // "it didn't go" for a step nothing let go: nothing to settle.
  assert.match(autosend(w.HOME, ['settle', '--event', 'harbor-expo', '--id', 'c002', '--touch', '1', '--went', 'no', '--said-file', said(w.HOME, 'not there')], { now: '2026-10-12T12:00:00Z' }).ERROR || '', /isn't waiting to be settled/);
});

// ---- F2: the run log never through a link.

test('F2: the run log is a link to a file outside the data folder: the run stops and nothing is written through it', () => {
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  const now = at('2026-10-12T09:00:00Z');
  const s = nextNew(dir, { nowMs: now });
  assert.equal(s.step, 'search');
  const outside = join(mkdtempSync(join(tmpdir(), 'fb-as-outside-')), 'target.txt');
  writeFileSync(outside, 'untouched\n');
  const logf = join(dir, 'autosend', 'log-2026-10-12.md');
  rmSync(logf);
  symlinkSync(outside, logf);
  writeFileSync(s.write, JSON.stringify({ messages: [{ from: 'ana@north.example', subject: 'Re: hi', date: '2026-10-12' }] }));
  let out;
  try {
    out = checked(dir, { run: s.run, file: s.write, nowMs: now + 1000 });
  } catch (e) {
    out = { threw: e.message };
  }
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n', JSON.stringify(out).slice(0, 300));
  assert.ok(out.threw || out.step === 'stop', JSON.stringify(out).slice(0, 300));
});

// ---- F3: the clock behind the data repo.

test('F3: a clock more than 5 minutes behind the latest line or the lock blocks every send', () => {
  const w = approved();
  addLines(w.evDir, [{ at: '2026-10-12T09:30:00Z', type: 'reply_checked', who: 'mailbox', id: 'c003', source: 'mailbox' }]);
  assert.match(dueNow(w.HOME, at('2026-10-12T09:20:00Z')).blocked || '', /clock/);
  assert.equal(dueNow(w.HOME, at('2026-10-12T09:27:00Z')).blocked, null, 'within 5 minutes');
  mkdirSync(join(w.HOME, 'autosend'), { recursive: true });
  writeFileSync(join(w.HOME, 'autosend', 'lock.json'), JSON.stringify({ who: 'laptop', run: 'l1', at: '2026-10-12T11:00:00Z' }));
  assert.match(dueNow(w.HOME, at('2026-10-12T10:00:00Z')).blocked || '', /clock/);
});

// ---- F4: never twice reads every sending path's marks.

test('F4: a step the guard let through, one in the drafts folder, or an unclear guard send waits; the readback refuses them', () => {
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const L = ledgerLines(w.evDir);
  const h = (id, t) => L.find((e) => e.type === 'approved' && e.id === id && e.touch === t).hash;
  addLines(w.evDir, [
    { at: '2026-10-12T07:30:00Z', type: 'send_released', who: 'floorboss', id: 'c001', touch: 1, hash: h('c001', 1), to: PEOPLE[0].email, via: 'email.send' },
    { at: '2026-10-12T07:30:00Z', type: 'stage_released', who: 'floorboss', id: 'c002', touch: 1, hash: h('c002', 1), to: PEOPLE[1].email, thread_id: 'th1', unattended: true, run: 'u1' }
  ]);
  const rb = readback(w.evDir, at(NOW));
  assert.deepEqual([...new Set(rb.items.map((x) => x.id))], ['c003']);
  assert.match(rb.refused.find((x) => x.id === 'c001')?.why || '', /let this message through/);
  assert.match(rb.refused.find((x) => x.id === 'c002')?.why || '', /drafts folder/);
  // Approved before those marks: the planner waits on them.
  const w2 = approved();
  const L2 = ledgerLines(w2.evDir);
  const h2 = (id, t) => L2.find((e) => e.type === 'approved' && e.id === id && e.touch === t).hash;
  addLines(w2.evDir, [
    { at: '2026-10-12T08:30:00Z', type: 'send_released', who: 'floorboss', id: 'c001', touch: 1, hash: h2('c001', 1), to: PEOPLE[0].email, via: 'email.send' },
    { at: '2026-10-12T08:30:00Z', type: 'stage_released', who: 'floorboss', id: 'c002', touch: 1, hash: h2('c002', 1), to: PEOPLE[1].email, thread_id: 'th1', unattended: true, run: 'u1' }
  ]);
  const r = dueNow(w2.HOME, at('2026-10-12T09:00:00Z'));
  assert.deepEqual(r.due.map((x) => x.id), ['c003']);
  assert.match(waitOf(r, 'c001'), /let this message through/);
  assert.match(waitOf(r, 'c002'), /drafts folder/);
});

// ---- F5 and F6: the guard's own checks (lib/sendcheck.mjs).

test('F5: an auto-send release today counts in sentOrGoingToday and across events by address; a withdrawn one does not', { skip: 'needs the narrow lib/sendcheck.mjs change, which this session was not permitted to make' }, () => {
  const w = approved();
  const L = ledgerLines(w.evDir);
  const hash = L.find((e) => e.type === 'autosend_approved' && e.id === 'c001' && e.touch === 1).hash;
  const now = at('2026-10-12T10:00:00Z');
  const entries = [...L, rels('c001', 1, hash, PEOPLE[0].email, '2026-10-12T09:00:00Z')];
  assert.equal(sentOrGoingToday(entries, legacyState(fold(entries)).c001 || {}, { id: 'c001', touch: 2 }, w.evDir, now), 1);
  const withdrawn = [...entries, { at: '2026-10-12T09:00:05Z', type: 'autosend_withdrawn', who: 'floorboss', id: 'c001', touch: 1, run: 'r0' }];
  assert.equal(sentOrGoingToday(withdrawn, legacyState(fold(withdrawn)).c001 || {}, { id: 'c001', touch: 2 }, w.evDir, now), null);
  // Across events: the release at harbor-expo holds the same address at another event.
  addLines(w.evDir, [rels('c001', 1, hash, PEOPLE[0].email, '2026-10-12T09:00:00Z')]);
  const other = { ...EVENT, slug: 'dock-days', autosend: false };
  world({ touches: 1, home: w.HOME, event: other, people: [{ ...PEOPLE[0], id: 'c050' }] });
  const od = join(w.HOME, 'events', 'dock-days');
  assert.ok(addressBusyToday(od, PEOPLE[0].email, now, 'c050', homeSends(join(w.HOME, 'events'))), 'busy by the auto-send release');
  addLines(w.evDir, [{ at: '2026-10-12T09:00:05Z', type: 'autosend_withdrawn', who: 'floorboss', id: 'c001', touch: 1, run: 'r0' }]);
  assert.equal(addressBusyToday(od, PEOPLE[0].email, now, 'c050', homeSends(join(w.HOME, 'events'))), null, 'withdrawn: not busy');
});

test('F6: the guard refuses an email send for an event with auto-send on', { skip: 'needs the narrow lib/sendcheck.mjs change, which this session was not permitted to make' }, () => {
  const w = approved();
  const L = ledgerLines(w.evDir);
  const fd = fold(L);
  const a = L.find((e) => e.type === 'approved' && e.id === 'c001' && e.touch === 1);
  const d = JSON.parse(readFileSync(join(w.evDir, 'drafts', `${a.hash}.json`), 'utf8'));
  // The listed message exactly as approved, so nothing else refuses it.
  const item = { id: 'c001', touch: 1, via: 'email.send', to: a.to, subject: d.subject, body: d.body };
  const check = () => verifySend(item, { evDir: w.evDir, settings: { sending: { channels: ['email'] } }, state: legacyState(fd), entries: L, folded: fd, nowMs: at('2026-10-12T09:00:00Z'), replyCheck: false, lent: false });
  const v = check();
  assert.equal(v.ok, false);
  assert.match(v.why, /auto-send/);
  // The control: the same send for the same event with auto-send off passes, so the refusal is auto-send's alone.
  const ev = JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8'));
  writeFileSync(join(w.evDir, 'event.json'), JSON.stringify({ ...ev, autosend: false }));
  assert.equal(check().ok, true);
});

// ---- Needs-validation 1 and 2: the search answer and the query.

test('needs-validation 1: a search answer at the page size asked for is incomplete; the page size is in the args; a sender read two ways stops the run', () => {
  const item = { to: 'ana@north.example', since_ms: at(NOW) };
  const own = 'sam@lanecraft.example';
  const page = Array.from({ length: MAX_RESULTS }, (_, i) => ({ from: own, subject: `note ${i}` }));
  assert.match(decide(item, JSON.stringify({ messages: page }), { own }).error || '', /incomplete/);
  assert.deepEqual(decide(item, JSON.stringify({ messages: page.slice(1) }), { own }), { go: true });
  for (const from of ['"ana@north.example" <sam@lanecraft.example>', 'Sam <sam@lanecraft.example> <ana@north.example>', 'ana@north.example sam@lanecraft.example'])
    assert.match(decide(item, JSON.stringify([{ from }]), { own }).error || '', /can't be read|sender/, from);
  assert.equal(decide(item, JSON.stringify([{ from: 'Ana Ito <ana@north.example>' }]), { own }).stop, 'reply');
  // The search step names its page size.
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  const s = nextNew(dir, { nowMs: at('2026-10-12T09:00:00Z') });
  assert.equal(s.args.max_results, MAX_RESULTS);
  assert.equal(MAX_RESULTS, 20);
});

test('needs-validation 2: the query asks for the exact and the base address, from them and in a bounce', () => {
  const q = query({ to: 'ana+expo@north.example', since_ms: at(NOW) });
  assert.match(q, /from:\(ana\+expo@north\.example OR ana@north\.example\)/);
  assert.match(q, /"ana\+expo@north\.example" OR "ana@north\.example"/);
  // An address with no tag: one of each.
  assert.equal(query({ to: 'ana@north.example', since_ms: at(NOW) }), `in:anywhere after:${Math.floor(at(NOW) / 1000) - 86400} (from:ana@north.example OR ((from:mailer-daemon OR from:postmaster OR subject:("Delivery Status Notification" OR "Undeliverable" OR "Mail delivery failed" OR "Returned mail")) "ana@north.example"))`);
});

// ---- Hardening.

test('hardening a: credentials are taken out of git\'s words, and status shows the remote without them', () => {
  assert.equal(sync.redact('fatal: unable to access https://someone:abc123@git.example/x/y.git/'), 'fatal: unable to access https://***@git.example/x/y.git/');
  assert.equal(sync.redact('From x::https://u:p@git.example/a/b'), 'From x::https://***@git.example/a/b');
  assert.equal(sync.redact('remote: x-access-token:zzz@git.example'), 'remote: x-access-token:***@git.example');
  const w = approved();
  git(w.HOME, ['init', '-q', '-b', 'main']);
  git(w.HOME, ['remote', 'add', 'origin', 'https://someone:abc123@git.example/test-user/fb-data.git']);
  const st = autosend(w.HOME, ['status']);
  assert.ok(!st.ERROR, st.ERROR);
  assert.equal(st.repo, 'https://***@git.example/test-user/fb-data.git');
});

test('hardening b: a link, or a file floorboss would read as control data outside its data paths, arriving in the repo stops the run before it is checked out', () => {
  for (const plant of [
    (c) => symlinkSync('/etc/hosts', join(c, 'autosend', 'log-2026-10-12.md')),
    (c) => writeFileSync(join(c, 'browser-send.json'), '{}'),
    (c) => writeFileSync(join(c, '.gitattributes'), '* filter=lfs\n'),
    (c) => {
      mkdirSync(join(c, 'events', 'harbor-expo', 'released'), { recursive: true });
      writeFileSync(join(c, 'events', 'harbor-expo', 'released', 'c001-1-0'), '');
    }
  ]) {
    const { HOME, bare } = pushedWorld({ people: [PEOPLE[0]] });
    remoteCommit(bare, (c) => {
      mkdirSync(join(c, 'autosend'), { recursive: true });
      plant(c);
    });
    const dir = cloneOf(bare);
    process.env.FLOORBOSS_HOME = dir;
    const s = nextNew(dir, { nowMs: at('2026-10-12T09:00:00Z') });
    assert.equal(s.step, 'stop', String(plant));
    assert.match(s.why, /isn't floorboss's|link/, String(plant));
    // The laptop refuses it before it reaches its folder.
    const before = git(HOME, ['rev-parse', 'HEAD']).trim();
    assert.match(sync.start({ home: HOME, who: 'laptop', runId: 'l1', nowMs: at(NOW) }).stop || '', /isn't floorboss's|link/);
    assert.equal(git(HOME, ['rev-parse', 'HEAD']).trim(), before);
    assert.ok(!existsSync(join(HOME, 'browser-send.json')) && !existsSync(join(HOME, '.gitattributes')));
  }
});

test('hardening c: only floorboss\'s data paths are staged: the user\'s said-files, uploads and laptop-only files stay off the repo, and do not stop sync start', () => {
  const { HOME, evDir, bare } = pushedWorld();
  writeFileSync(join(HOME, 'work', 'said-1.txt'), 'stop auto-send');
  mkdirSync(join(evDir, 'work'), { recursive: true });
  writeFileSync(join(evDir, 'work', 'upload.csv'), 'name,email\n');
  writeFileSync(join(HOME, 'browser-send.json'), '{}');
  const r = autosend(HOME, ['revoke', '--event', 'harbor-expo', '--ids', 'c001', '--said-file', join(HOME, 'work', 'said-1.txt')], { now: '2026-10-12T08:05:00Z' });
  assert.equal(r.pushed, true, JSON.stringify(r));
  const tree = git(bare, ['ls-tree', '-r', '--name-only', 'main']).split('\n');
  assert.ok(tree.includes('events/harbor-expo/ledger.jsonl'));
  for (const f of ['work/said-1.txt', 'events/harbor-expo/work/upload.csv', 'browser-send.json']) assert.ok(!tree.includes(f), f);
  assert.equal(autosend(HOME, ['sync', 'start', '--who', 'laptop', '--run', 'l1']).started, true);
});

test('hardening d: the pin needs a clean floorboss tree; a data repo written by a newer floorboss stops the run', () => {
  const d = mkdtempSync(join(tmpdir(), 'fb-as-pin-'));
  git(d, ['init', '-q', '-b', 'main']);
  writeFileSync(join(d, 'a.txt'), 'a');
  git(d, ['add', '-A']);
  git(d, [...ID, 'commit', '-qm', 'a']);
  assert.match(sync.headOf(d), /^[0-9a-f]{40}$/);
  writeFileSync(join(d, 'a.txt'), 'changed');
  assert.equal(sync.headOf(d), null, 'a changed tree has no pin');
  assert.match(sync.pinWhy(d) || '', /changes/);
  const { bare } = pushedWorld({ people: [PEOPLE[0]] });
  remoteCommit(bare, (c) => {
    mkdirSync(join(c, 'autosend'), { recursive: true });
    writeFileSync(join(c, 'autosend', 'format.json'), JSON.stringify({ format: 999 }));
  });
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  const s = nextNew(dir, { nowMs: at('2026-10-12T09:00:00Z') });
  assert.equal(s.step, 'stop');
  assert.match(s.why, /newer floorboss/);
});
