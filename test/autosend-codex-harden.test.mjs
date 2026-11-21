// The Codex auto-send send path, hardened after an independent review (2026-11-20), against the real Gmail tools:
// 1. the connected account is checked first (gmail_get_profile) against the sender recorded at the approval;
// 2. a follow-up reads its thread first (gmail_read_email_thread): any inbound message there stops that person; the
//    bounce search is wider; a follow-up with no recorded thread is held;
// 3. a send step is claimed with an exclusive file create: two overlapping next calls never both get it;
// 4. the Codex search answer must hold an emails list;
// 5. the send receipt: the envelope by its fields (extra keys like _meta allowed), errors at every level;
// 6. settle records the ids it is given; a receipt in another thread is sent, with a threading problem logged;
// 7. the send step carries an expiry, and an answer written after it is unclear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { world, ledgerLines, addLines, remoteFor, cloneOf, autosend, said, PEOPLE, NOW, OWN, ROOT, SLUG, EVENT } from './fixtures/autosend-world.mjs';
import { email, searchResult, sendResult, profileResult, threadResult, written } from './fixtures/gmail-real.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import * as rc from '../lib/autosend/replycheck.mjs';
const { query, decide, apply } = rc;
const decideThread = (...a) => rc.decideThread(...a);
import { release, record } from '../lib/autosend/sendrecord.mjs';
import * as drv from '../skills/autosend/scripts/driver.mjs';
const { PROFILE_TOOLS, THREAD_TOOLS } = drv;
import { taskPrompt } from '../skills/autosend/scripts/cli.mjs';

const at = (iso) => Date.parse(iso);
const SENTENCE = 'auto-send these sequences';
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const P = PEOPLE[0];
const ITEM = { slug: SLUG, id: P.id, name: P.name, touch: 2, to: P.email, from: OWN, subject: 'One more thought', body: 'Hi', hash: 'a'.repeat(24), since_ms: at('2026-10-12T09:01:00Z'), thread_id: 'th1', reply_to_message_id: 'm1' };

const cloudEnv = (HOME, now) => {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, FLOORBOSS_AUTOSEND: 'cloud', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  for (const k of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[k];
  return env;
};
function cloud(HOME, now, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: cloudEnv(HOME, now), encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  return JSON.parse(r.stdout);
}
// A step's then command, run as given.
const thenOf = (HOME, now, s) => cloud(HOME, now, s.then.slice(s.then.indexOf(CLI) + 1));
function approvedWorld({ touches = 1, people = [P] } = {}) {
  const w = world({ touches, people });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  return { ...w, ...remoteFor(w.HOME) };
}
const T1 = '2026-10-12T09:00:00Z';

// 1. The connected account.
test('item 1: the approval records the sending address, and needs one', () => {
  const w = world({ touches: 1, people: [P], event: { ...EVENT, autosend_own: undefined } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  assert.throws(() => approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW)), /address it sends from|--own/);
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_approved'));
  const v = world({ touches: 1, people: [P] });
  process.env.FLOORBOSS_HOME = v.HOME;
  const rb2 = readback(v.evDir, at(NOW));
  approve(v.evDir, { digest: rb2.digest, said: SENTENCE }, at(NOW));
  assert.ok(ledgerLines(v.evDir).filter((e) => e.type === 'autosend_approved').every((e) => e.from === OWN));
  assert.equal(dueNow(v.HOME, at(T1)).due[0].from, OWN);
});

test('item 1: an approval with no recorded sender waits, and the readback offers it again', () => {
  const w = world({ touches: 1, people: [P] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  const { from: _f, ...noFrom } = { from: 1, type: 'autosend_approved', who: 'user', id: P.id, touch: 1, hash: rb.items[0].hash, to: P.email, planned_due: rb.items[0].planned_day, digest: rb.digest, said: SENTENCE };
  addLines(w.evDir, [{ at: '2026-10-12T08:00:00Z', ...noFrom }]);
  const plan = dueNow(w.HOME, at(T1));
  assert.equal(plan.due.length, 0);
  assert.match(plan.waits[0].why, /sending address/);
  assert.equal(readback(w.evDir, at(NOW)).items.length, 1, 'offered again');
});

test('item 1: on needs --own', () => {
  const w = world({ touches: 1, people: [P], event: { ...EVENT, autosend: false, autosend_own: undefined } });
  assert.match(autosend(w.HOME, ['on', '--event', SLUG, '--said', 'yes']).ERROR || '', /--own/);
});

test('item 1: the first step of a cloud run is the profile; another account, or none, stops before any search', () => {
  assert.deepEqual(PROFILE_TOOLS, ['mcp__codex_apps__gmail_get_profile', 'gmail_get_profile']);
  const w = approvedWorld();
  for (const [ans, ok] of [
    [profileResult({ email: 'other@elsewhere.example' }), false],
    [profileResult({ email: undefined }), false],
    [{ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: {}, isError: false }, false],
    [profileResult({ email: OWN }, { isError: true }), false],
    ['not json', false],
    [null, false],
    [profileResult({ email: ` ${OWN.toUpperCase()} ` }), true]
  ]) {
    const X = cloneOf(w.bare, 'p');
    const s = cloud(X, T1, ['next', '--run', 'new']);
    assert.equal(s.step, 'profile', JSON.stringify(s).slice(0, 300));
    assert.equal(s.tool, PROFILE_TOOLS[0]);
    assert.deepEqual(s.args, {});
    if (ans !== null) writeFileSync(s.write, typeof ans === 'string' ? ans : written(ans));
    const c = thenOf(X, T1, s);
    if (!ok) {
      assert.equal(c.step, 'stop', JSON.stringify(c).slice(0, 300));
      assert.match(c.why, /Gmail account|account/);
      assert.equal(c.lock, 'released');
      continue;
    }
    assert.equal(c.checked, 'profile', JSON.stringify(c));
    assert.equal(cloud(X, T1, ['next', '--run', s.run]).step, 'search');
  }
});

// 2. The thread.
test('item 2: the bounce search is wider, within Gmail syntax', () => {
  const q = query({ to: 'ana@north.example', since_ms: at('2026-10-12T09:00:00Z') });
  assert.match(q, /subject:\("Delivery Status Notification" OR "Undeliverable" OR "Mail delivery failed" OR "Returned mail"\)/);
  assert.match(q, /from:mailer-daemon OR from:postmaster/);
  assert.equal(q.split('(').length, q.split(')').length, 'brackets balance');
  // A notice by subject from a server address that isn't mailer-daemon is a bounce, not someone else.
  const r = decide({ ...ITEM, to: 'ana@north.example' }, written(searchResult([email({ from_: 'Microsoft Outlook <MicrosoftExchange329e@north.example>', subject: 'Undeliverable: One more thought', snippet: 'ana@north.example' })])), { own: OWN });
  assert.equal(r.stop, 'bounce', JSON.stringify(r));
});

test('item 2: the thread check: any inbound message stops them; only your own messages go; anything odd stops the run', () => {
  const T = (msgs, opts) => decideThread(ITEM, written(threadResult(msgs, opts)), { own: OWN });
  const mine = email({ id: 'm1', thread_id: 'th1', from_: `Sam Lane <${OWN}>`, subject: 'At Harbor Expo', labels: ['SENT'] });
  assert.deepEqual(T([mine]), { go: true });
  const colleague = email({ id: 'm2', thread_id: 'th1', from_: 'Bo Chen <bo@north.example>', subject: 'Re: At Harbor Expo' });
  assert.equal(T([mine, colleague]).stop, 'reply');
  assert.match(T([mine, colleague]).evidence, /bo@north\.example/);
  assert.equal(T([mine, email({ id: 'm3', thread_id: 'th1', from_: 'bo@north.example', subject: 'Automatic reply: away' })]).stop, 'auto_reply');
  assert.equal(T([mine, email({ id: 'm4', thread_id: 'th1', from_: 'mailer-daemon@mail.example', subject: 'Delivery Status Notification (Failure)' })]).stop, 'bounce');
  // The emails key is read too.
  assert.deepEqual(decideThread(ITEM, written({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { emails: [mine] }, isError: false }), { own: OWN }), { go: true });
  for (const bad of [
    threadResult([]),
    threadResult([email({ id: 'x', thread_id: 'other', from_: OWN })]),
    threadResult([mine], { isError: true }),
    { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: {}, isError: false },
    { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { messages: 'none' }, isError: false },
    { content: [{ type: 'text', text: 'Action completed.' }], structuredContent: { messages: [mine], partial: true }, isError: false },
    threadResult([colleague]),
    threadResult([{ ...mine, from_: undefined }])
  ]) {
    const r = decideThread(ITEM, written(bad), { own: OWN });
    assert.ok(r.error, JSON.stringify(bad).slice(0, 200));
  }
  assert.ok(decideThread(ITEM, 'not json', { own: OWN }).error);
});

test('item 2: a follow-up with no recorded thread or message id is held with a plain reason', () => {
  const w = world({ touches: 2, people: [P] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  const now = at(T1);
  const it = dueNow(w.HOME, now).due[0];
  apply(w.evDir, it, { go: true }, now);
  release(w.evDir, it, 'r1', now + 1000, { issuedMs: now });
  // Sent, as a hand-settled send records it: no ids.
  addLines(w.evDir, [{ at: '2026-10-12T09:00:05Z', type: 'sent', who: 'user', id: P.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', hash: it.hash, source: 'autosend', settled: true, said: 'in Sent' }]);
  const later = dueNow(w.HOME, at('2026-10-19T09:00:00Z'));
  assert.equal(later.due.length, 0, JSON.stringify(later.due));
  assert.match(later.waits[0].why, /thread/);
});

// 3. The claim.
function atSend(touches = 1) {
  const w = approvedWorld({ touches });
  const X = cloneOf(w.bare, 'c');
  let s = cloud(X, T1, ['next', '--run', 'new']);
  writeFileSync(s.write, written(profileResult({ email: OWN })));
  thenOf(X, T1, s);
  s = cloud(X, T1, ['next', '--run', s.run]);
  assert.equal(s.step, 'search', JSON.stringify(s).slice(0, 300));
  writeFileSync(s.write, written(searchResult()));
  const c = thenOf(X, T1, s);
  assert.equal(c.checked, 'go', JSON.stringify(c));
  return { ...w, X, run: s.run };
}

test('item 3: two next calls at once: only one gets the send step', async () => {
  const { X, run } = atSend();
  const one = () =>
    new Promise((res) => {
      const p = spawn(process.execPath, [CLI, 'next', '--run', run], { env: cloudEnv(X, T1) });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(JSON.parse(out || '{}')));
    });
  const got = await Promise.all([one(), one(), one()]);
  assert.equal(got.filter((s) => s.step === 'send').length, 1, JSON.stringify(got).slice(0, 600));
});

test('item 3: a send step already claimed: the loser stops and the run is unchanged', () => {
  const { X, run } = atSend();
  const dir = join(X, '.git', 'floorboss-autosend');
  const runFile = join(X, 'autosend', 'runs', `${run}.json`);
  const before = readFileSync(runFile, 'utf8');
  const r = JSON.parse(before);
  writeFileSync(join(dir, `${run}-${r.n}.send`), '', { flag: 'wx' });
  const s = cloud(X, T1, ['next', '--run', run]);
  assert.equal(s.step, 'stop', JSON.stringify(s));
  assert.match(s.why, /another/);
  assert.equal(readFileSync(runFile, 'utf8'), before, 'the run file is as it was');
});

// 4. The emails list.
test('item 4: a Codex answer without an emails list is never a clean inbox', () => {
  for (const sc of [{}, { next_page_token: null }, { emails: null }, { emails: 'none' }, { messages: [] }, { results: [] }]) {
    const r = decide(ITEM, written({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: sc, isError: false }), { own: OWN });
    assert.ok(r.error, JSON.stringify(sc));
    assert.equal(r.go, undefined);
  }
  assert.deepEqual(decide(ITEM, written(searchResult()), { own: OWN }), { go: true });
});

// 5. The receipt.
function released() {
  const w = world({ touches: 1, people: [P] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  const now = at(T1);
  const it = dueNow(w.HOME, now).due[0];
  apply(w.evDir, it, { go: true }, now);
  release(w.evDir, it, 'r1', now + 1000, { issuedMs: now });
  return { ...w, it, now };
}
test('item 5: the envelope with extra keys like _meta is read; an error at any level is never sent', () => {
  const ok = { ...sendResult({ id: 'm9', thread_id: 't9' }), _meta: { 'openai/x': 1 } };
  const a = released();
  assert.deepEqual(record(a.evDir, a.it, written(ok), 'r1', a.now + 2000), { sent: true, message_id: 'm9', thread_id: 't9' });
  for (const bad of [
    { ...sendResult({ id: 'm9', thread_id: 't9' }), error: 'quota' },
    { ...sendResult({ id: 'm9', thread_id: 't9' }), status: 'failed' },
    sendResult({ id: 'm9', thread_id: 't9', message: { error: 'rejected' } }),
    sendResult({ id: 'm9', thread_id: 't9', message: { status: 'failed' } }),
    sendResult({ id: 'm9', thread_id: 't9', message: { isError: true } }),
    sendResult({ message: { id: 'm9', thread_id: 't9', error: { code: 500 } } }),
    sendResult({ id: 'm9', thread_id: 't9', isError: true })
  ]) {
    const b = released();
    const r = record(b.evDir, b.it, written(bad), 'r1', b.now + 2000);
    assert.ok(r.unclear, JSON.stringify(bad));
    assert.ok(!ledgerLines(b.evDir).some((e) => e.type === 'sent'));
  }
});

// 6. Threading.
test('item 6: a receipt in another thread than expected is sent, with the threading problem recorded', () => {
  const a = released();
  const r = record(a.evDir, { ...a.it, thread_id: 'th-expected' }, written(sendResult({ id: 'm9', thread_id: 't-other' })), 'r1', a.now + 2000);
  assert.equal(r.sent, true);
  assert.match(r.thread_problem, /th-expected/);
  const s = ledgerLines(a.evDir).find((e) => e.type === 'sent');
  assert.equal(s.thread_expected, 'th-expected');
});

test('item 6: settle --went yes records --message-id and --thread-id when given', () => {
  const w = world({ touches: 2, people: [P] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  const now = at(T1);
  const it = dueNow(w.HOME, now).due[0];
  apply(w.evDir, it, { go: true }, now);
  release(w.evDir, it, 'r1', now + 1000, { issuedMs: now });
  addLines(w.evDir, [{ at: '2026-10-12T09:00:02Z', type: 'send_unclear', who: 'floorboss', id: P.id, touch: 1, error: 'no answer' }]);
  const bad = autosend(w.HOME, ['settle', '--event', SLUG, '--id', P.id, '--touch', '1', '--went', 'yes', '--said', 'in my Sent folder', '--message-id', 'has space'], { now: '2026-10-12T10:00:00Z' });
  assert.match(bad.ERROR || '', /message-id/);
  const r = autosend(w.HOME, ['settle', '--event', SLUG, '--id', P.id, '--touch', '1', '--went', 'yes', '--said', 'in my Sent folder', '--message-id', '19a2b3c4d5e6f708', '--thread-id', '19a2b3c4d5e6f700'], { now: '2026-10-12T10:00:00Z' });
  assert.equal(r.recorded, 'sent', JSON.stringify(r));
  const s = ledgerLines(w.evDir).find((e) => e.type === 'sent');
  assert.deepEqual([s.message_id, s.thread_id], ['19a2b3c4d5e6f708', '19a2b3c4d5e6f700']);
  const f = dueNow(w.HOME, at('2026-10-19T09:00:00Z')).due[0];
  assert.deepEqual([f.touch, f.reply_to_message_id, f.thread_id], [2, '19a2b3c4d5e6f708', '19a2b3c4d5e6f700']);
});

test('item 2 and 6: in a cloud run a follow-up reads its thread first; a colleague in the thread stops them', () => {
  const w = approvedWorld({ touches: 2 });
  const add = (HOME) => {
    const evDir = join(HOME, 'events', SLUG);
    const t1 = ledgerLines(evDir).find((e) => e.type === 'autosend_approved' && e.touch === 1);
    addLines(evDir, [
      { at: '2026-10-12T09:00:01Z', type: 'autosend_released', who: 'floorboss', id: P.id, touch: 1, hash: t1.hash, to: P.email, run: 'old' },
      { at: '2026-10-12T09:00:02Z', type: 'sent', who: 'floorboss', id: P.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', message_id: 'm1', thread_id: 'th1', hash: t1.hash, source: 'autosend' }
    ]);
  };
  add(w.HOME);
  spawnSync('git', ['-C', w.HOME, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'sent 1'], { encoding: 'utf8' });
  spawnSync('git', ['-C', w.HOME, 'push', '-q'], { encoding: 'utf8' });
  const day = '2026-10-19T09:00:00Z';
  const X = cloneOf(w.bare, 't');
  let s = cloud(X, day, ['next', '--run', 'new']);
  writeFileSync(s.write, written(profileResult({ email: OWN })));
  thenOf(X, day, s);
  s = cloud(X, day, ['next', '--run', s.run]);
  assert.equal(s.step, 'thread', JSON.stringify(s).slice(0, 300));
  assert.deepEqual(THREAD_TOOLS, ['mcp__codex_apps__gmail_read_email_thread', 'gmail_read_email_thread']);
  assert.equal(s.tool, THREAD_TOOLS[0]);
  assert.equal(s.args.thread_id, 'th1');
  writeFileSync(s.write, written(threadResult([email({ id: 'm1', thread_id: 'th1', from_: OWN }), email({ id: 'm2', thread_id: 'th1', from_: 'Bo Chen <bo@north.example>', subject: 'Re: hello' })])));
  const c = thenOf(X, day, s);
  assert.equal(c.checked, 'reply', JSON.stringify(c));
  const d = cloud(X, day, ['next', '--run', s.run]);
  assert.equal(d.step, 'done', JSON.stringify(d).slice(0, 300));
  assert.ok(ledgerLines(join(X, 'events', SLUG)).some((e) => e.type === 'replied' && e.id === P.id));
});

// 7. Freshness.
test('item 7: the send step carries an expiry; an answer written after it is unclear', () => {
  const { X, run } = atSend();
  const s = cloud(X, T1, ['next', '--run', run]);
  assert.equal(s.step, 'send', JSON.stringify(s).slice(0, 300));
  const exp = Date.parse(s.expires_at);
  assert.ok(Number.isFinite(exp) && exp > at(T1) && exp <= at(T1) + 5 * 60000, s.expires_at);
  assert.match(s.say, /expires_at/);
  // Written now, and read at a time after the expiry: the file's time, on floorboss's clock, is past it.
  writeFileSync(s.write, written(sendResult({ id: 'm9', thread_id: 't9' })));
  const r = thenOf(X, new Date(exp + 61000).toISOString(), s);
  assert.equal(r.recorded, 'unclear', JSON.stringify(r));
  assert.ok(ledgerLines(join(X, 'events', SLUG)).some((e) => e.type === 'send_unclear'));
});

test('the task text: profile first, the thread step, and the expiry', () => {
  const t = taskPrompt({ sha: 'abc', dataRepo: 'u/r' });
  assert.match(t, /profile: call/);
  assert.match(t, /gmail_get_profile/);
  assert.match(t, /thread: call/);
  assert.match(t, /gmail_read_email_thread/);
  assert.match(t, /expires_at has passed.*don't call\s+it: run next again/s);
});
