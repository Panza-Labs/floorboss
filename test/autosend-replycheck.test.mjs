// U3 and U4 of auto-send: the Gmail search query and the reply decision read from the tool's answer (each accepted
// shape, each sender field, auto-replies, bounces, the user's own mail, anything unknown stops the run), and the
// send record from the send tool's answer (ids, or unclear). The answers are the likely shapes until M1 records the
// real ones (test/fixtures/gmail-real/ then).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ledgerLines, NOW, OWN } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { query, decide, apply, readAnswer } from '../lib/autosend/replycheck.mjs';
import { release, sendArgs, record } from '../lib/autosend/sendrecord.mjs';

const at = (iso) => Date.parse(iso);
const ITEM = { slug: 'harbor-expo', id: 'c001', name: 'Ana Ito', touch: 2, to: 'ana@north.example', subject: 'One more thought', body: 'Hi Ana', hash: 'a'.repeat(24), since_ms: at('2026-10-12T09:01:00Z'), thread_id: null, reply_to_message_id: null };
const J = JSON.stringify;

test('query: everything from them, and any bounce naming them, since a day before the first send', () => {
  assert.equal(query(ITEM), `in:anywhere after:${Math.floor(at('2026-10-12T09:01:00Z') / 1000) - 86400} (from:ana@north.example OR ((from:mailer-daemon OR from:postmaster) "ana@north.example"))`);
  // A crafted address never reaches the query: plainAddress first.
  for (const to of ['ana@north.example OR from:*', 'ana@north.example"', 'Ana <ana@north.example>', 'a b@north.example', 'ana@north.example\n'])
    assert.throws(() => query({ ...ITEM, to }), /plain address/);
});

test('decide: no match in each empty shape is go', () => {
  for (const a of ['[]', '{}', J({ messages: [] }), J({ emails: [] }), J({ results: [] }), J({ threads: [] }), J({ messages: [], next_page_token: null }), J({ content: [{ type: 'text', text: '{"messages":[]}' }] })])
    assert.deepEqual(decide(ITEM, a, { own: OWN }), { go: true }, a);
});

test('decide: a reply from them, by every sender field the parser reads', () => {
  const senders = [
    { from: 'ana@north.example' },
    { from: 'Ana Ito <ANA@north.example>' },
    { sender: 'ana@north.example' },
    { from_email: 'ana@north.example' },
    { from: { email: 'ana@north.example', name: 'Ana' } },
    { headers: { From: 'Ana Ito <ana@north.example>' } },
    { headers: [{ name: 'From', value: 'Ana Ito <ana@north.example>' }, { name: 'Subject', value: 'Re: hi' }] }
  ];
  for (const s of senders) {
    const r = decide(ITEM, J({ messages: [{ id: 'x1', subject: 'Re: One more thought', date: '2026-10-13', ...s }] }), { own: OWN });
    assert.equal(r.stop, 'reply', J(s));
    assert.match(r.evidence, /ana@north\.example/i);
    assert.ok(r.evidence.length <= 200);
  }
  // Threads with messages inside, and a bare list.
  assert.equal(decide(ITEM, J({ threads: [{ id: 't1', messages: [{ from: 'ana@north.example', subject: 'Re' }] }] }), { own: OWN }).stop, 'reply');
  assert.equal(decide(ITEM, J([{ from: 'ana@north.example', subject: 'Re' }]), { own: OWN }).stop, 'reply');
  // Their address with a +tag or other case is them too.
  assert.equal(decide(ITEM, J([{ from: 'Ana+x@North.example', subject: 'Re' }]), { own: OWN }).stop, 'reply');
});

test('decide: an out-of-office or auto-submitted mail is an auto-reply; mailer-daemon or postmaster is a bounce', () => {
  for (const subject of ['Automatic reply: One more thought', 'Out of Office: back Monday', 'Auto: away', 'out of office'])
    assert.equal(decide(ITEM, J([{ from: 'ana@north.example', subject }]), { own: OWN }).stop, 'auto_reply', subject);
  assert.equal(decide(ITEM, J([{ from: 'ana@north.example', subject: 'Re', headers: { 'Auto-Submitted': 'auto-replied' } }]), { own: OWN }).stop, 'auto_reply');
  assert.equal(decide(ITEM, J([{ from: 'ana@north.example', subject: 'Re', headers: [{ name: 'Auto-Submitted', value: 'auto-generated' }] }]), { own: OWN }).stop, 'auto_reply');
  assert.equal(decide(ITEM, J([{ from: 'ana@north.example', subject: 'Re', headers: { 'Auto-Submitted': 'no' } }]), { own: OWN }).stop, 'reply');
  assert.equal(decide(ITEM, J([{ from: 'Mail Delivery Subsystem <mailer-daemon@mail.example>', subject: 'Delivery Status Notification (Failure)' }]), { own: OWN }).stop, 'bounce');
  assert.equal(decide(ITEM, J([{ from: 'postmaster@north.example', subject: 'Undeliverable' }]), { own: OWN }).stop, 'bounce');
  // A bounce and a reply in one answer: the first hit is what the evidence names, and either stops them.
  assert.ok(decide(ITEM, J([{ from: 'postmaster@north.example', subject: 'Undeliverable' }, { from: 'ana@north.example', subject: 'Re' }]), { own: OWN }).stop);
});

test("decide: the user's own mail is ignored; another sender, an incomplete or unreadable answer stops the run", () => {
  assert.deepEqual(decide(ITEM, J([{ from: OWN, subject: 'One more thought' }]), { own: OWN }), { go: true });
  assert.ok(decide(ITEM, J([{ from: 'news@other.example', subject: 'x' }]), { own: OWN }).error, 'another sender: the check is not trusted');
  const errors = [
    'Error: the Gmail tool is not available',
    '',
    'null',
    '42',
    '"no messages"',
    J({ error: 'rate limited' }),
    J({ messages: 'none' }),
    J({ items: [] }),
    J({ messages: [{ subject: 'no sender at all' }] }),
    J({ messages: [{ from: 'ana@north.example' }], next_page_token: 'abc' }),
    J({ messages: Array.from({ length: 21 }, () => ({ from: 'ana@north.example' })) }),
    J({ content: [{ type: 'text', text: 'Something went wrong' }], isError: true }),
    J({ messages: [], resultSizeEstimate: 3 })
  ];
  for (const a of errors) {
    const r = decide(ITEM, a, { own: OWN });
    assert.ok(r.error, a);
    assert.equal(r.go, undefined, a);
  }
});

test('readAnswer unwraps one tool-content wrapper and nothing else', () => {
  assert.deepEqual(readAnswer(J({ content: [{ type: 'text', text: '{"a":1}' }] })), { ok: true, value: { a: 1 } });
  assert.equal(readAnswer('not json').ok, false);
  assert.equal(readAnswer(J({ content: [{ type: 'text', text: '{"content":[{"type":"text","text":"{}"}]}' }] })).value.content.length, 1, 'one level only');
});

function ready() {
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: 'auto-send these sequences' }, at(NOW));
  const now = at('2026-10-12T09:00:00Z');
  return { ...w, now, item: dueNow(w.HOME, now).due[0] };
}

test('apply: always reply_checked from the mailbox; a reply or auto-reply recorded as replied, a bounce as bounced', () => {
  const { evDir, now, item } = ready();
  apply(evDir, item, { go: true }, now);
  apply(evDir, { ...item, id: 'c002' }, { stop: 'reply', evidence: 'x' }, now);
  apply(evDir, { ...item, id: 'c003' }, { stop: 'bounce', evidence: 'y' }, now);
  const ls = ledgerLines(evDir);
  assert.equal(ls.filter((e) => e.type === 'reply_checked' && e.source === 'mailbox' && e.who === 'mailbox').length, 3);
  assert.ok(ls.some((e) => e.type === 'replied' && e.id === 'c002' && e.source === 'autosend' && e.outcome === 'replied'));
  assert.ok(ls.some((e) => e.type === 'bounced' && e.id === 'c003'));
  assert.throws(() => apply(evDir, item, { error: 'x' }, now), /stops the run/);
});

test('release: only a due step, only after a fresh reply check, then never again', () => {
  const { evDir, now, item } = ready();
  // The search's issue time is what the check is as fresh as: required, not stale, not ahead of the clock.
  assert.throws(() => release(evDir, item, 'r1', now), /no time for the search/);
  assert.throws(() => release(evDir, item, 'r1', now, { issuedMs: now - 4 * 60000 }), /more than 3 minutes ago/);
  assert.throws(() => release(evDir, item, 'r1', now, { issuedMs: now + 120000 }), /ahead of the clock/);
  assert.throws(() => release(evDir, item, 'r1', now, { issuedMs: now }), /reply check/);
  apply(evDir, item, { go: true }, now - 91000);
  assert.throws(() => release(evDir, item, 'r1', now, { issuedMs: now }), /90 seconds/);
  apply(evDir, item, { go: true }, now);
  assert.throws(() => release(evDir, { ...item, body: 'other text' }, 'r1', now + 1000, { issuedMs: now }), /isn't due now/);
  assert.throws(() => release(evDir, { ...item, to: 'eve@evil.example' }, 'r1', now + 1000, { issuedMs: now }), /isn't due now/);
  const e = release(evDir, item, 'r1', now + 1000, { issuedMs: now });
  assert.equal(e.type, 'autosend_released');
  assert.deepEqual([e.id, e.touch, e.hash, e.to, e.run, e.who], [item.id, item.touch, item.hash, item.to, 'r1', 'floorboss']);
  assert.throws(() => release(evDir, item, 'r1', now + 2000, { issuedMs: now }), /isn't due now|may have gone/);
});

test('sendArgs: the approved subject and body, the one address, no cc, bcc or thread', () => {
  assert.deepEqual(sendArgs(ITEM), { to: ['ana@north.example'], subject: 'One more thought', body: 'Hi Ana' });
  assert.deepEqual(Object.keys(sendArgs({ ...ITEM, thread_id: 't-1' })).sort(), ['body', 'subject', 'to']);
});

test('record: ids in each accepted shape go on the sent line (no call_result: only the guard writes one); anything else is unclear', () => {
  const shapes = [
    [{ id: 'm1', threadId: 't1' }, 'm1', 't1'],
    [{ message_id: 'm-2', thread_id: 't_2' }, 'm-2', 't_2'],
    [{ messageId: 'm3', threadId: 't3', labelIds: ['SENT'] }, 'm3', 't3'],
    [{ content: [{ type: 'text', text: J({ id: 'm4', threadId: 't4' }) }] }, 'm4', 't4'],
    [{ message: { id: 'm5', threadId: 't5' } }, 'm5', 't5']
  ];
  for (const [answer, mid, tid] of shapes) {
    const { evDir, now, item } = ready();
    apply(evDir, item, { go: true }, now);
    release(evDir, item, 'r1', now + 1000, { issuedMs: now });
    const r = record(evDir, item, J(answer), 'r1', now + 2000);
    assert.deepEqual(r, { sent: true, message_id: mid, thread_id: tid }, J(answer));
    const ls = ledgerLines(evDir);
    const sent = ls.find((e) => e.type === 'sent' && e.id === item.id);
    assert.deepEqual([sent.touch, sent.via, sent.date, sent.hash, sent.source, sent.message_id, sent.thread_id, sent.who], [1, 'email.send', '2026-10-12', item.hash, 'autosend', mid, tid, 'floorboss']);
    assert.ok(!ls.some((e) => e.type === 'call_result'));
    assert.equal(dueNow(process.env.FLOORBOSS_HOME, now + 3000).blocked, null);
  }
  const unclear = ['Error: send failed', '', J({ id: 'm1' }), J({ threadId: 't1' }), J({ id: 'm 1', threadId: 't1' }), J({ id: 'x'.repeat(300), threadId: 't' }), J({ error: 'blocked by a safety check' }), J({ id: 'm1', threadId: 't1', error: 'partial' }), J({ content: [{ type: 'text', text: 'Sent!' }] }), J({ content: [{ type: 'text', text: '{"id":"m","threadId":"t"}' }], isError: true }), 'I sent it.'];
  for (const a of unclear) {
    const { evDir, now, item } = ready();
    apply(evDir, item, { go: true }, now);
    release(evDir, item, 'r1', now + 1000, { issuedMs: now });
    const r = record(evDir, item, a, 'r1', now + 2000);
    assert.ok(r.unclear, a);
    const ls = ledgerLines(evDir);
    assert.ok(ls.some((e) => e.type === 'send_unclear' && e.id === item.id && e.touch === 1), a);
    assert.ok(!ls.some((e) => e.type === 'sent'), a);
    assert.match(dueNow(process.env.FLOORBOSS_HOME, now + 3000).blocked, /unclear/, a);
  }
});

test('record refuses a step this run did not release, or one recorded already', () => {
  const { evDir, now, item } = ready();
  assert.throws(() => record(evDir, item, J({ id: 'm', threadId: 't' }), 'r1', now), /wasn't let go/);
  apply(evDir, item, { go: true }, now);
  release(evDir, item, 'r1', now + 1000, { issuedMs: now });
  assert.throws(() => record(evDir, item, J({ id: 'm', threadId: 't' }), 'r2', now + 2000), /wasn't let go/);
  record(evDir, item, J({ id: 'm', threadId: 't' }), 'r1', now + 2000);
  assert.throws(() => record(evDir, item, J({ id: 'm', threadId: 't' }), 'r1', now + 3000), /wasn't let go|already/);
});

test('review H1: other error keys, paging flags, threads with a sender, and unknown senders all stop the run', () => {
  const bad = [
    J({ messages: [], status: 'error', message: 'Gmail API quota exceeded' }),
    J({ success: false, emails: [] }),
    J({ emails: [], warning: 'search timed out; partial results' }),
    J({ content: [{ type: 'text', text: '{"status":"failed","results":[]}' }] }),
    J({ messages: [], has_more: true }),
    J({ messages: [], truncated: true }),
    J({ messages: [], total: 3 }),
    J({ messages: [{ from: 'news@other.example', subject: 'x' }] })
  ];
  for (const a of bad) assert.ok(decide(ITEM, a, { own: OWN }).error, a);
  // A thread is read by its messages, whatever its own sender says.
  assert.equal(decide(ITEM, J({ threads: [{ from: OWN, messages: [{ from: 'Ana <ana@north.example>', subject: 'Re' }] }] }), { own: OWN }).stop, 'reply');
  assert.deepEqual(decide(ITEM, J({ threads: [{ from: OWN, subject: 'At Harbor Expo' }] }), { own: OWN }), { go: true });
});
