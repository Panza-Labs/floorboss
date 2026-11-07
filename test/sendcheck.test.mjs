// The guard's last check holds everything the ledger holds: a colleague or skip decision, a reply or booking,
// a damaged line anywhere, a duplicate, a bounce to a new address, and a confirmation whose booking was taken back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDraft } from '../lib/drafts.mjs';
import { verifySend, eventRecord } from '../lib/sendcheck.mjs';

const settings = { sending: { channels: ['email'] }, connectors: {} };
function check(extra, touch = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'fb-send-'));
  const hash = saveDraft(dir, { channel: 'email', to: 'ann@acme.test', subject: 'Hi', body: 'Hello Ann' });
  const L = (e) => appendFileSync(join(dir, 'ledger.jsonl'), (typeof e === 'string' ? e : JSON.stringify({ at: '2026-10-27T10:00:00Z', ...e })) + '\n');
  L({ type: 'person', who: 'floorboss', id: 'c001', name: 'Ann', email: 'ann@acme.test' });
  L({ type: 'drafted', who: 'floorboss', id: 'c001', touch, hash });
  L({ type: 'critic', who: 'floorboss', id: 'c001', touch, hash, verdict: 'PASS' });
  L({ type: 'approved', who: 'user', id: 'c001', touch, hash, to: 'ann@acme.test', via: 'email.send', said: 'ok' });
  extra.forEach(L);
  const item = { id: 'c001', touch, via: 'email.send', to: 'ann@acme.test', subject: 'Hi', body: 'Hello Ann' };
  return verifySend(item, { evDir: dir, settings, ...eventRecord(dir), nowMs: Date.parse('2026-10-27T10:01:00Z') });
}

test('the guard holds what the ledger holds', () => {
  assert.equal(check([]).ok, true);
  const cases = {
    'a colleague holds them': [{ type: 'decide', who: 'user', id: 'c001', group: 'colleague', because: 'Dan has her' }],
    'damaged line': ['{"at":"2026-10-27T10:00:30Z","type":"stop","who":"user","id":"c0'],
    'approve it again': [{ type: 'bounced', who: 'mailbox', id: 'c001', new_email: 'ann@new.test' }],
    'they replied': [{ type: 'replied', who: 'user', id: 'c001', said: 'x' }],
    'a duplicate of c002': [{ type: 'person_merged', who: 'floorboss', id: 'c001', into: 'c002' }],
  };
  for (const [why, extra] of Object.entries(cases)) {
    const r = check(extra);
    assert.equal(r.ok, false, why);
    assert.ok(r.why.includes(why), `${why}: ${r.why}`);
  }
  const conf = check([{ type: 'booked', who: 'user', id: 'c001', slot: 's1', said: 'x' }, { type: 'unbooked', who: 'user', id: 'c001', slot: 's1', said: 'x' }], 0);
  assert.match(conf.why, /booking was taken back/);
  assert.equal(check([{ type: 'booked', who: 'user', id: 'c001', slot: 's1', said: 'x' }], 0).ok, true, 'a standing booking gets its confirmation');
});

test('a bounce with a new address sends the message back to be approved for that address', async () => {
  const { setup, triage, draftApprove, idOf, todoJobs } = await import('./fixtures/harness.mjs');
  const { fold, readLedger } = await import('../lib/ledger.mjs');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Moss,Head of Ops,Initech,cy@initech.test\n' });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  appendFileSync(join(H.dir, 'ledger.jsonl'), JSON.stringify({ at: '2026-10-12T09:00:00Z', type: 'bounced', who: 'mailbox', id: ana, touch: 1, new_email: 'ana@new.test' }) + '\n');
  assert.equal(fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[ana].touches[1].approved, null, 'the old approval no longer counts');
  assert.ok(todoJobs(H, '2026-10-12T09:00:00Z').jobs.some((j) => j.id === ana && j.touch === 1), 'she is drafted again');
  draftApprove(H, '2026-10-12T09:05:00Z');
  assert.equal(fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[ana].touches[1].approved.to, 'ana@new.test');
});

test('an unclear send blocks a resend until someone looked; a failed reply reader lets the user\'s word count', () => {
  const unclear = check([{ type: 'send_released', who: 'guard', id: 'c001', touch: 1, hash: 'x', via: 'email.send', to: 'ann@acme.test' }, { type: 'send_unclear', who: 'floorboss', id: 'c001', touch: 1, error: 'connection lost' }]);
  assert.equal(unclear.ok, false);
  assert.match(unclear.why, /already let through once/);
  const cleared = check([{ type: 'send_released', who: 'guard', id: 'c001', touch: 1, hash: 'x', via: 'email.send', to: 'ann@acme.test' }, { type: 'send_unclear', who: 'floorboss', id: 'c001', touch: 1, error: 'connection lost' }, { type: 'release_cleared', who: 'user', id: 'c001', touch: 1, said: 'not in my Sent folder' }]);
  assert.equal(cleared.ok, true, 'after the user looked and it had not gone, it may go (with the prompt again)');
});

test('the reply reader failed: a follow-up may go on the user\'s word, not before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-send-'));
  const hash1 = saveDraft(dir, { channel: 'email', to: 'ann@acme.test', subject: 'Hi', body: 'Hello Ann' });
  const hash2 = saveDraft(dir, { channel: 'email', to: 'ann@acme.test', subject: 'Re: Hi', body: 'One more' });
  const L = (e) => appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify({ at: '2026-10-27T10:00:00Z', ...e }) + '\n');
  L({ type: 'person', who: 'floorboss', id: 'c001', name: 'Ann', email: 'ann@acme.test' });
  L({ type: 'drafted', who: 'floorboss', id: 'c001', touch: 1, hash: hash1 });
  L({ type: 'critic', who: 'floorboss', id: 'c001', touch: 1, hash: hash1, verdict: 'PASS' });
  L({ type: 'approved', who: 'user', id: 'c001', touch: 1, hash: hash1, to: 'ann@acme.test', via: 'email.send', said: 'ok' });
  L({ type: 'drafted', who: 'floorboss', id: 'c001', touch: 2, hash: hash2 });
  L({ type: 'critic', who: 'floorboss', id: 'c001', touch: 2, hash: hash2, verdict: 'PASS' });
  L({ type: 'approved', who: 'user', id: 'c001', touch: 2, hash: hash2, to: 'ann@acme.test', via: 'email.send', said: 'ok' });
  L({ type: 'send_released', who: 'guard', id: 'c001', touch: 1, hash: hash1, via: 'email.send', to: 'ann@acme.test' });
  L({ type: 'sent', who: 'floorboss', id: 'c001', touch: 1, date: '2026-10-23', via: 'floorboss', message_id: 'm1', thread_id: 't1' });
  const reader = { sending: { channels: ['email'] }, connectors: { 'email.messages': { server: 'gmail' } } };
  const item = { id: 'c001', touch: 2, via: 'email.send', to: 'ann@acme.test', subject: 'Re: Hi', body: 'One more', thread_id: 't1' };
  const at = (extra) => { extra.forEach(L); return verifySend(item, { evDir: dir, settings: reader, ...eventRecord(dir), nowMs: Date.parse('2026-10-27T10:00:30Z') }); };
  assert.equal(at([{ type: 'no_reply_said', who: 'user', ids: ['c001'], said: 'nothing from her' }]).ok, false, 'the mailbox can be read: the user\'s word is not enough');
  assert.equal(at([{ type: 'tool_failed', who: 'floorboss', task: 'email.messages', error: 'connection lost' }]).ok, false, 'the reader failed, but the user hasn\'t chosen to answer instead');
  assert.equal(at([{ type: 'answered', who: 'user', ask: 'reader_fallback', value: 'user', said: 'ask me instead' }]).ok, true, 'they chose to answer: their word counts');
});

test('the event app said they can\'t be written to there: the browser note is held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-send-'));
  const to = 'Ana Berg (Acme)';
  const hash = saveDraft(dir, { channel: 'paste', to, subject: '', body: 'Hi Ana, coffee at the show?' });
  const L = (e) => appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify({ at: '2026-10-27T10:00:00Z', ...e }) + '\n');
  L({ type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Berg', company: 'Acme' });
  L({ type: 'drafted', who: 'floorboss', id: 'c001', touch: 1, hash });
  L({ type: 'critic', who: 'floorboss', id: 'c001', touch: 1, hash, verdict: 'PASS' });
  L({ type: 'approved', who: 'user', id: 'c001', touch: 1, hash, to, via: 'browser', said: 'ok' });
  const item = { id: 'c001', touch: 1, via: 'browser', to, subject: '', body: 'Hi Ana, coffee at the show?' };
  const settings = { sending: { channels: ['app'] }, connectors: {} };
  const v = () => verifySend(item, { evDir: dir, settings, ...eventRecord(dir), nowMs: Date.parse('2026-10-27T10:01:00Z') });
  assert.equal(v().ok, true);
  L({ type: 'app_result', who: 'floorboss', id: 'c001', touch: 1, result: 'messages_off', page_says: 'Ana has turned off messages from other attendees.' });
  assert.match(v().why, /turned off messages/);
});
