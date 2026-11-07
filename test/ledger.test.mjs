// The ledger is the one record: these pin how lines fold into state and what the writer refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fold, contactable, append, readLedger, validateEntry, lastSent } from '../lib/ledger.mjs';

const H = 'a'.repeat(24), H2 = 'b'.repeat(24);
const at = (n) => `2026-10-${String(10 + n).padStart(2, '0')}T08:00:00Z`;
const L = (type, extra, n = 0) => ({ at: at(n), type, who: 'floorboss', ...extra });

test('fold: a person, a fit, a draft, its verdict, approval, release and send', () => {
  const st = fold([
    L('person', { id: 'c001', name: 'Ana Berg', company: 'Acme', email: 'ana@acme.test', keys: ['e:ana@acme.test'], lines: [2] }),
    L('fit', { id: 'c001', segment: 'ops', reason: 'COO', score: 80 }),
    L('drafted', { id: 'c001', touch: 1, hash: H, structure: 'question-first', fact_source: 'crm', slot_ids: ['s1', 's2'], checks: [] }),
    L('critic', { id: 'c001', touch: 1, hash: H, verdict: 'PASS', reasons: [] }),
    L('approved', { id: 'c001', touch: 1, hash: H, to: 'ana@acme.test', via: 'email.send', who: 'user', said: 'approve all' }),
    L('send_released', { id: 'c001', touch: 1, hash: H, to: 'ana@acme.test', via: 'email.send', who: 'guard' }),
    L('sent', { id: 'c001', touch: 1, hash: H, via: 'email.send', date: '2026-10-10', message_id: 'm1', thread_id: 't1' }),
  ]);
  const p = st.people.c001, x = p.touches[1];
  assert.equal(p.email, 'ana@acme.test');
  assert.deepEqual(st.fits.c001, { segment: 'ops', reason: 'COO', score: 80, unsure: false });
  assert.equal(x.critic.hash, H);
  assert.deepEqual([x.approved.hash, x.approved.to, x.released], [H, 'ana@acme.test', true]);
  assert.deepEqual([x.sent.thread_id, x.sent.message_id], ['t1', 'm1']);
  assert.equal(lastSent(p), 1);
  assert.equal(contactable(st, 'c001'), null);
});

test('fold: a new text is a new hash; the old verdict and approval no longer apply', () => {
  const st = fold([
    L('person', { id: 'c001', name: 'Ana' }),
    L('drafted', { id: 'c001', touch: 1, hash: H }),
    L('critic', { id: 'c001', touch: 1, hash: H, verdict: 'PASS' }),
    L('approved', { id: 'c001', touch: 1, hash: H, to: 'a@b.test', via: 'email.send' }, 1),
    L('drafted', { id: 'c001', touch: 1, hash: H2 }, 2),
  ]);
  const x = st.people.c001.touches[1];
  assert.equal(x.hash, H2);
  assert.notEqual(x.critic.hash, x.hash, 'the critic read the old text');
  assert.notEqual(x.approved.hash, x.hash, 'the approval was for the old text');
});

test('fold: the later decision wins; skip, colleague, stop, reply and booking block messages; a confirmation still goes to someone who booked', () => {
  const base = [L('person', { id: 'c001', name: 'Ana' })];
  const dec = (g, n) => L('decide', { id: 'c001', group: g, because: 'x', who: 'user' }, n);
  assert.match(contactable(fold([...base, dec('reach', 0), dec('skip', 1)]), 'c001'), /leave them alone/);
  assert.equal(contactable(fold([...base, dec('skip', 0), dec('reach', 1)]), 'c001'), null);
  assert.match(contactable(fold([...base, dec('colleague', 0)]), 'c001'), /colleague/);
  assert.match(contactable(fold([...base, L('stop', { id: 'c001', who: 'user', said: 'stop' })]), 'c001'), /stop/);
  const booked = fold([...base, L('booked', { id: 'c001', slot: 's1', who: 'user', said: 'booked' })]);
  assert.match(contactable(booked, 'c001'), /booked/);
  assert.equal(contactable(booked, 'c001', 'confirmation'), null);
  assert.match(contactable(fold([...base, L('replied', { id: 'c001', source: 'mailbox', who: 'mailbox' })]), 'c001'), /replied/);
});

test('fold: a bounce undoes the send; with no new address nothing more goes; with one the address changes', () => {
  const sent = [L('person', { id: 'c001', email: 'old@x.test' }), L('drafted', { id: 'c001', touch: 1, hash: H }), L('sent', { id: 'c001', touch: 1, date: '2026-10-10' })];
  const a = fold([...sent, L('bounced', { id: 'c001', touch: 1, who: 'user', said: 'bounced' }, 1)]);
  assert.equal(a.people.c001.touches[1].sent, null);
  assert.match(contactable(a, 'c001'), /bounced/);
  const b = fold([...sent, L('bounced', { id: 'c001', touch: 1, new_email: 'New@y.test', who: 'user', said: 'bounced' }, 1)]);
  assert.equal(b.people.c001.email, 'new@y.test');
  assert.equal(contactable(b, 'c001'), null);
});

test('fold: a damaged line holds the person it names, or everyone when the id is unreadable', () => {
  const one = fold([L('person', { id: 'c001' }), L('person', { id: 'c002' })], [{ line: 3, text: '{"at":"x","type":"stop","id":"c002"' }]);
  assert.equal(contactable(one, 'c001'), null);
  assert.match(contactable(one, 'c002'), /damaged line/);
  const all = fold([L('person', { id: 'c001' })], [{ line: 2, text: '{"at":"x","ty' }]);
  assert.match(contactable(all, 'c001'), /damaged line/);
});

test('fold: reply checks, no-reply words, rounds, keep, caps, answered, mappings, ratings', () => {
  const st = fold([
    L('reply_checked', { id: 'c001', source: 'mailbox' }), L('no_reply_said', { ids: ['c002'], who: 'user', said: 'nobody replied' }),
    L('round_approved', { touch: 2, who: 'user', said: 'go' }), L('keep', { top: 20, who: 'user', said: 'keep 20' }), L('cap', { company: 'acme', value: 2, who: 'user', said: 'cap acme 2' }),
    L('answered', { ask: 'gate', value: 'ok', who: 'user' }), L('mapping_confirmed', { source: 'crm', fingerprint: 'f1', who: 'user' }),
    L('copy_rating', { id: 'c001', touch: 1, hash: H, rating: 7, note: 'fine', who: 'user' }),
  ]);
  assert.equal(st.reply_checks.c001.source, 'mailbox');
  assert.deepEqual(st.no_reply_said[0].ids, ['c002']);
  assert.equal(st.rounds[0].touch, 2);
  assert.deepEqual(st.keep, { top: 20, segments: null });
  assert.equal(st.caps.acme, 2);
  assert.equal(st.answered.gate.value, 'ok');
  assert.equal(st.mappings.crm, 'f1');
  assert.equal(st.people.c001.ratings[0].rating, 7);
});

test('append: refuses wrong shapes before writing; readLedger reports damaged lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-ledger-'));
  const path = join(dir, 'ledger.jsonl');
  append(path, { type: 'person', who: 'floorboss', id: 'c001', name: 'Ana' });
  assert.throws(() => append(path, { type: 'nonsense', who: 'floorboss' }), /unknown entry type/);
  assert.throws(() => append(path, { type: 'decide', who: 'user', id: 'c001', group: 'maybe', because: 'x' }), /decide group/);
  assert.throws(() => append(path, { type: 'decide', who: 'user', id: 'c001', group: 'skip' }), /their words/);
  assert.throws(() => append(path, { type: 'approved', who: 'user', id: 'c001', touch: 1, hash: 'short', to: 'a', via: 'email.send', said: 'ok' }), /draft hash/);
  assert.throws(() => append(path, { type: 'stop', who: 'nobody', id: 'c001' }), /who must be/);
  writeFileSync(path, readFileSync(path, 'utf8') + '{"at":"x","type":"stop","id":"c001"\n');
  const r = readLedger(path);
  assert.equal(r.entries.length, 1);
  assert.equal(r.damaged.length, 1);
  assert.deepEqual(validateEntry({ type: 'sent', who: 'floorboss', id: 'c001', touch: 1, date: '2026-10-10' }), []);
});
