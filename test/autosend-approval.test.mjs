// U1 of auto-send (lib/autosend/approval.mjs): the readback of every person, message and day, the second yes bound to
// it (a stale digest or any words but the sentence write nothing: case 15), "stop auto-send", the ledger lines, the
// whole-sequence switch, the outbox card after the second yes, and Claude Code refusing every auto-send command
// (case 16).
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { world, addLines, ledgerLines, approvedLines, autosend, said, PEOPLE, NOW, OWN } from './fixtures/autosend-world.mjs';
import { readback, approve, revoke } from '../lib/autosend/approval.mjs';
import { validateEntry } from '../lib/ledger.mjs';
import { wholeSequence } from '../skills/event-outreach/scripts/commands/context.mjs';
import { offersCopy, mailOf, renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const nowMs = Date.parse(NOW);

test('the ledger takes the three auto-send lines, each with what it needs', () => {
  const ok = (e) => validateEntry({ at: NOW, ...e });
  assert.deepEqual(ok({ type: 'autosend_approved', who: 'user', id: 'c001', touch: 1, hash: 'a'.repeat(24), to: 'ana@north.example', planned_due: '2026-10-12', digest: 'b'.repeat(64), said: '1' }), []);
  assert.deepEqual(ok({ type: 'autosend_revoked', who: 'user', id: 'c001', said: 'stop auto-send' }), []);
  assert.deepEqual(ok({ type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: 'a'.repeat(24), to: 'ana@north.example', run: 'r1' }), []);
  assert.ok(ok({ type: 'autosend_approved', who: 'user', id: 'c001', touch: 1, to: 'x@y.example', said: 'x' }).length, 'no hash');
  assert.ok(ok({ type: 'autosend_released', who: 'floorboss', touch: 1, hash: 'a'.repeat(24) }).length, 'no id');
  assert.ok(ok({ type: 'autosend_revoked', who: 'user', id: 'c001' }).length, "the user's words");
});

test('readback: each person, address, message, planned day, subject and whole body; digest of that text', () => {
  const { evDir } = world({ touches: 2 });
  const r = readback(evDir, nowMs);
  assert.equal(r.items.length, 6);
  assert.deepEqual(r.refused, []);
  const ana = r.items.filter((x) => x.id === 'c001');
  assert.deepEqual(ana.map((x) => [x.touch, x.planned_day, x.to]), [[1, '2026-10-12', 'ana@north.example'], [2, '2026-10-19', 'ana@north.example']]);
  for (const x of r.items) {
    assert.ok(r.text.includes(x.subject), x.subject);
    for (const l of x.body.split('\n')) assert.ok(r.text.includes(l), l);
  }
  assert.match(r.text, /Ana Ito \(c001\) <ana@north\.example>/);
  assert.match(r.text, /Message 1, planned for Monday 12 October \(2026-10-12\)/);
  assert.match(r.text, /Message 2, planned for Monday 19 October \(2026-10-19\)/);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.equal(readback(evDir, nowMs).digest, r.digest, 'the same text, the same digest');
});

test('readback says when the event has room for fewer messages than requested', () => {
  const { evDir } = world({ touches: 1, people: PEOPLE.slice(0, 1) });
  const path = join(evDir, 'event.json');
  const event = JSON.parse(readFileSync(path, 'utf8'));
  event.start_date = event.end_date = '2026-10-12';
  event.settings.touches = 3;
  writeFileSync(path, JSON.stringify(event));

  const r = readback(evDir, nowMs);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.refused, []);
  assert.match(r.text, /Only 1 of the 3 requested messages fits before the event ends/);
});

test('readback requires approval for the whole default auto-send sequence', () => {
  const { evDir } = world({ touches: 2, people: PEOPLE.slice(0, 1) });
  const path = join(evDir, 'event.json');
  const event = JSON.parse(readFileSync(path, 'utf8'));
  delete event.settings.touches;
  writeFileSync(path, JSON.stringify(event));

  const held = readback(evDir, nowMs);
  assert.deepEqual(held.items, []);
  assert.match(held.refused[0].why, /message 3 .* isn't written and approved yet/);

  addLines(evDir, approvedLines(evDir, PEOPLE[0], 3).lines);
  const ready = readback(evDir, nowMs);
  assert.deepEqual(ready.refused, []);
  assert.deepEqual(ready.items.map((item) => item.touch), [1, 2, 3]);
});

test('readback on a Saturday plans the first message for the Monday', () => {
  const { evDir } = world({ touches: 1 });
  const r = readback(evDir, Date.parse('2026-10-17T10:00:00Z'));
  assert.equal(r.items[0].planned_day, '2026-10-19');
});

test('readback leaves people out, with why: a LinkedIn step, a text changed since approval, unreviewed, a stop, already written to', () => {
  const { evDir } = world({ touches: 1, people: PEOPLE.slice(0, 1) });
  const extra = [
    { id: 'c004', name: 'Di Park', email: 'di@south.example', company: 'South' },
    { id: 'c005', name: 'Ed Ruiz', email: 'ed@mid.example', company: 'Mid' },
    { id: 'c006', name: 'Fay Ng', email: 'fay@far.example', company: 'Far' },
    { id: 'c007', name: 'Gus Ole', email: 'gus@near.example', company: 'Near' },
    { id: 'c008', name: 'Hal Roe', email: 'hal@up.example', company: 'Up' }
  ];
  addLines(evDir, extra.map((p) => ({ at: NOW, type: 'person', who: 'floorboss', id: p.id, name: p.name, company: p.company, email: p.email })));
  // c004: touch 2 on LinkedIn.
  addLines(evDir, [...approvedLines(evDir, extra[0], 1).lines, ...approvedLines(evDir, extra[0], 2, { channel: 'paste', where: 'LinkedIn' }).lines]);
  // c005: approved, then a new text saved.
  addLines(evDir, [...approvedLines(evDir, extra[1], 1).lines, ...approvedLines(evDir, extra[1], 1, { extra: ' Edited.', approve: false }).lines]);
  // c006: no critic verdict and no skipped review.
  addLines(evDir, approvedLines(evDir, extra[2], 1, { critic: null }).lines);
  // c007: said stop.
  addLines(evDir, [...approvedLines(evDir, extra[3], 1).lines, { at: NOW, type: 'stop', who: 'user', id: 'c007', said: 'stop' }]);
  // c008: their first message already went by hand.
  addLines(evDir, [...approvedLines(evDir, extra[4], 1).lines, { at: NOW, type: 'sent', who: 'user', id: 'c008', touch: 1, date: '2026-10-12', said: 'sent' }]);
  const r = readback(evDir, nowMs);
  assert.deepEqual([...new Set(r.items.map((x) => x.id))], ['c001']);
  const why = Object.fromEntries(r.refused.map((x) => [x.id, x.why]));
  assert.match(why.c004, /LinkedIn/);
  assert.match(why.c005, /changed since it was approved|isn't approved/);
  assert.match(why.c006, /critic/);
  assert.match(why.c007, /stop/);
  assert.match(why.c008, /already went/);
});

test('case 15: a stale digest, or "yes" instead of a numbered pick, is refused and writes nothing', () => {
  const { evDir } = world({ touches: 2 });
  const before = readFileSync(join(evDir, 'ledger.jsonl'), 'utf8');
  const r = readback(evDir, nowMs);
  assert.throws(() => approve(evDir, { digest: r.digest, said: 'yes' }, nowMs), /numbered options/);
  assert.throws(() => approve(evDir, { digest: r.digest, said: 'auto-send' }, nowMs), /numbered options/);
  assert.throws(() => approve(evDir, { digest: r.digest, said: '5' }, nowMs), /numbered options/);
  assert.throws(() => approve(evDir, { digest: r.digest, said: '4' }, nowMs), /has changes/);
  assert.throws(() => approve(evDir, { digest: r.digest }, nowMs), /no pick/);
  // Something changed after the readback was shown: a new text for one message.
  addLines(evDir, approvedLines(evDir, PEOPLE[1], 2, { extra: ' Now edited.' }).lines);
  const mid = readFileSync(join(evDir, 'ledger.jsonl'), 'utf8');
  assert.throws(() => approve(evDir, { digest: r.digest, said: '1' }, nowMs), /changed since the readback/);
  assert.equal(readFileSync(join(evDir, 'ledger.jsonl'), 'utf8'), mid);
  assert.ok(mid.startsWith(before));
  assert.ok(!ledgerLines(evDir).some((e) => e.type === 'autosend_approved'));
});

test('the second yes: one line per message, the user\'s words, the digest, the planned day; then nothing waits', () => {
  const { evDir } = world({ touches: 2 });
  const r = readback(evDir, nowMs);
  const out = approve(evDir, { digest: r.digest, said: '  Option 1. ' }, nowMs);
  assert.deepEqual(out, { approved: 6, people: ['c001', 'c002', 'c003'], pick: 'auto' });
  const lines = ledgerLines(evDir).filter((e) => e.type === 'autosend_approved');
  assert.equal(lines.length, 6);
  for (const l of lines) {
    assert.equal(l.who, 'user');
    assert.equal(l.digest, r.digest);
    assert.equal(l.said, '  Option 1. ');
    assert.equal(l.pick, 'auto');
    assert.ok(r.items.some((x) => x.id === l.id && x.touch === l.touch && x.hash === l.hash && x.to === l.to && x.planned_day === l.planned_due));
  }
  const again = readback(evDir, nowMs);
  assert.equal(again.items.length, 0, 'already approved for these texts');
  assert.throws(() => approve(evDir, { digest: again.digest, said: '1' }, nowMs), /Nothing is waiting/);
});

test('stop auto-send: revoked for one person or all; a new text needs a new readback', () => {
  const { evDir } = world({ touches: 1 });
  const r = readback(evDir, nowMs);
  approve(evDir, { digest: r.digest, said: '1' }, nowMs);
  assert.deepEqual(revoke(evDir, { ids: 'c002', said: 'stop auto-send for Bo' }, nowMs), { revoked: ['c002'] });
  assert.deepEqual(readback(evDir, nowMs).items.map((x) => x.id), ['c002'], 'revoked: asked about again');
  assert.deepEqual(revoke(evDir, { ids: 'all', said: 'stop auto-send' }, nowMs).revoked, ['c001', 'c003']);
  assert.throws(() => revoke(evDir, { ids: 'c099', said: 'stop' }, nowMs), /Not on this event/);
  assert.equal(ledgerLines(evDir).filter((e) => e.type === 'autosend_revoked').length, 3);
});

test('whole sequence: with sending on, or in Codex for an auto-send event; never from that flag in Claude Code', () => {
  const save = { ...process.env };
  try {
    const c = (event, settings = {}) => wholeSequence({ event, settings });
    process.env.CODEX_SESSION_ID = 's';
    delete process.env.CLAUDECODE;
    assert.equal(c({ autosend: true }), true);
    assert.equal(c({}), false);
    assert.equal(c({ autosend: 'yes' }), false);
    delete process.env.CODEX_SESSION_ID;
    process.env.CLAUDECODE = '1';
    assert.equal(c({ autosend: true }), false, 'Claude Code reads its own sending setting only');
    assert.equal(c({}, { sending: { channels: ['email'] } }), true);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k];
    Object.assign(process.env, save);
  }
});

test('the outbox card after the second yes: no buttons, no copy, and says floorboss sends it; the same card without it is as before', () => {
  const base = { id: 'c001', touch: 1, kind: 'message', name: 'Ana Ito', title: 'COO', company: 'North', channel: 'email', address: 'ana@north.example', send_to: 'ana@north.example', you_send: true, subject: 'Hi', body: 'Hello\n\nBest, Sam', slots: [] };
  assert.ok(offersCopy(base) && mailOf(base));
  const auto = { ...base, autosend: true };
  assert.equal(offersCopy(auto), false);
  assert.equal(mailOf(auto), null);
  const page = (cards) => renderOutbox({ hand_send: true, event: { name: 'Harbor Expo', slug: 'harbor-expo', city: 'Lisbon', start_date: '2026-11-03', end_date: '2026-11-04', time_zone: 'Europe/Lisbon' }, cards, slots: [], counts: {}, generatedAt: 'now' });
  const plain = page([base]);
  const withAuto = page([auto]);
  assert.match(plain, /Open in your mail app/);
  assert.ok(!/floorboss sends this on its day/.test(plain));
  assert.match(withAuto, /floorboss sends this on its day/);
  assert.ok(!/Open in your mail app/.test(withAuto));
});

test('case 16: Claude Code refuses every auto-send command for a Codex event, and the Codex-only commands; Codex runs them', () => {
  const { HOME } = world({ touches: 1 });
  for (const args of [['on', '--event', 'harbor-expo', '--said', 'yes', '--mode', 'drafts'], ['readback', '--event', 'harbor-expo'], ['approve', '--event', 'harbor-expo', '--digest', 'x'], ['revoke', '--event', 'harbor-expo', '--ids', 'all', '--said', 'stop'], ['drafts', 'next', '--event', 'harbor-expo', '--run', 'new'], ['status'], ['next', '--run', 'new'], ['sync', 'start', '--who', 'laptop', '--run', 'r1'], ['setup'], ['settle', '--event', 'harbor-expo', '--id', 'c001', '--touch', '1', '--went', 'yes', '--said', 'x'], ['daily-task']]) {
    const r = autosend(HOME, withSeen(HOME, args), { claude: true });
    assert.match(r.ERROR || '', /this auto-send command is for Codex; in Claude Code, auto-send goes through a daily Claude routine|In Claude Code, --mode is routine/, args.join(' '));
  }
  const rb = autosend(HOME, ['readback', '--event', 'harbor-expo']);
  assert.ok(!rb.ERROR, rb.ERROR);
  assert.equal(rb.people, 3);
  assert.match(rb.choice.numbered, /^1\. Approve and send automatically/m);
  assert.ok(!rb.choice.ask_user_question, 'Codex shows numbered options');
  const ok = autosend(HOME, ['approve', '--event', 'harbor-expo', '--digest', rb.digest, '--said-file', said(HOME, '1')]);
  assert.equal(ok.approved, 3, JSON.stringify(ok));
});

test('the setup answer: on --event saves autosend in event.json with the user\'s words and own address, in Codex only', () => {
  const { HOME, evDir } = world({ touches: 1, event: { slug: 'quay-show', name: 'Quay Show', city: 'Lisbon', time_zone: 'Europe/Lisbon', start_date: '2026-11-03', end_date: '2026-11-04', settings: {} } });
  assert.match(autosend(HOME, ['readback', '--event', 'quay-show']).ERROR, /isn't set to auto-send/);
  const r = autosend(HOME, ['on', '--event', 'quay-show', '--said', 'yes, send them from the cloud', '--own', OWN]);
  assert.ok(!r.ERROR, r.ERROR);
  const ev = JSON.parse(readFileSync(join(evDir, 'event.json'), 'utf8'));
  assert.equal(ev.autosend, true);
  assert.equal(ev.autosend_own, OWN);
  assert.equal(ev.autosend_said, 'yes, send them from the cloud');
  assert.match(autosend(HOME, ['on', '--event', 'quay-show', '--said', 'yes', '--own', 'not an address']).ERROR, /own address/);
});

test('review M4: a readback after 17:00 plans the first message for the next weekday', () => {
  const { evDir } = world({ touches: 1 });
  assert.equal(readback(evDir, Date.parse('2026-10-16T16:30:00Z')).items[0].planned_day, '2026-10-19');
  assert.equal(readback(evDir, Date.parse('2026-10-12T15:30:00Z')).items[0].planned_day, '2026-10-12');
});

test('review M2: after "it didn\'t go" the card is no longer the cloud\'s', async () => {
  const { evDir } = world({ touches: 1 });
  const r = readback(evDir, nowMs);
  approve(evDir, { digest: r.digest, said: '1' }, nowMs);
  const { autosendLive, readEvent } = await import('../lib/autosend/common.mjs');
  const x = r.items[0];
  addLines(evDir, [{ at: NOW, type: 'autosend_released', who: 'floorboss', id: x.id, touch: 1, hash: x.hash, to: x.to, run: 'r1' }, { at: NOW, type: 'release_cleared', who: 'user', id: x.id, touch: 1, said: 'not in Sent' }]);
  const { entries, folded } = readEvent(evDir);
  assert.equal(autosendLive(entries, folded, x.id, 1), null);
});

test('review M1: on refuses an event where Claude Code sends email from this data folder', () => {
  const { HOME } = world({ touches: 1 });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'] } }));
  assert.match(autosend(HOME, ['on', '--event', 'harbor-expo', '--said', 'yes']).ERROR, /Claude Code sends/);
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, approve is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('approve');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
