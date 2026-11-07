// Before anything automated happens in a run (a draft, the agenda, a send), floorboss reads what came in: the
// mailbox, or the CRM, which logs the user's mailbox, or, with nothing connected that can see replies, the user is
// asked. A yes, a moved time, a no or a stop the user never mentioned is recorded before a follow-up is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { fold } from '../lib/ledger.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDraft } from '../lib/drafts.mjs';
import { verifySend, eventRecord } from '../lib/sendcheck.mjs';
import { NOW } from './fixtures/harness.mjs';
import { simplePersona, drive } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, json, answer } from './fixtures/r2.mjs';
import { execFileSync } from 'node:child_process';
import { ROOT } from './fixtures/harness.mjs';

const at = (HOME, now, args) => { try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), ...args], { env: envOf(HOME, { FLOORBOSS_NOW: now }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; } };
const DONE = (s) => s.done || s.step === 'waiting';

// A follow-up to Ann, approved, her first message sent; the guard's verdict with these ledger lines added.
function annFollowUp() {
  const dir = mkdtempSync(join(tmpdir(), 'fb-send-'));
  const h1 = saveDraft(dir, { channel: 'email', to: 'ann@acme.test', subject: 'Hi', body: 'Hello Ann' });
  const h2 = saveDraft(dir, { channel: 'email', to: 'ann@acme.test', subject: 'Re: Hi', body: 'One more' });
  const L = (e) => appendFileSync(join(dir, 'ledger.jsonl'), JSON.stringify({ at: '2026-10-27T10:00:00Z', ...e }) + '\n');
  L({ type: 'person', who: 'floorboss', id: 'c001', name: 'Ann', email: 'ann@acme.test' });
  for (const [touch, hash] of [[1, h1], [2, h2]]) {
    L({ type: 'drafted', who: 'floorboss', id: 'c001', touch, hash });
    L({ type: 'critic', who: 'floorboss', id: 'c001', touch, hash, verdict: 'PASS' });
    L({ type: 'approved', who: 'user', id: 'c001', touch, hash, to: 'ann@acme.test', via: 'email.send', said: 'ok' });
  }
  L({ type: 'send_released', who: 'guard', id: 'c001', touch: 1, hash: h1, via: 'email.send', to: 'ann@acme.test' });
  L({ at: '2026-10-23T09:00:00Z', type: 'sent', who: 'floorboss', id: 'c001', touch: 1, date: '2026-10-23', via: 'floorboss', message_id: 'm1', thread_id: 't1' });
  const item = { id: 'c001', touch: 2, via: 'email.send', to: 'ann@acme.test', subject: 'Re: Hi', body: 'One more', thread_id: 't1' };
  return (settings, extra = []) => { extra.forEach(L); return verifySend(item, { evDir: dir, settings, ...eventRecord(dir), nowMs: Date.parse('2026-10-27T10:00:30Z') }); };
}
const CRM = { sending: { channels: ['email'] }, connectors: { 'crm.activity': { server: 'hubspot' } } };
const word = { type: 'no_reply_said', who: 'user', ids: ['c001'], said: 'nothing from her' };

test('a CRM read clears an email follow-up only when it showed the CRM sees her email; otherwise only the user\'s word does', () => {
  assert.equal(annFollowUp()(CRM, [word]).ok, false, 'the CRM can be read: the user\'s word alone is not enough');
  assert.equal(annFollowUp()(CRM, [{ type: 'checked', who: 'floorboss', id: 'c001', source: 'crm', sees_email: true }]).ok, true, 'a CRM read that saw her email just now clears it');
  assert.equal(annFollowUp()(CRM, [{ type: 'checked', who: 'floorboss', id: 'c001', source: 'crm', sees_email: false }]).ok, false, 'a CRM with no email of hers can\'t vouch that she didn\'t reply');
  assert.equal(annFollowUp()(CRM, [{ type: 'checked', who: 'floorboss', id: 'c001', source: 'crm' }]).ok, false, 'a CRM read that doesn\'t say what it saw counts for nothing');
  assert.equal(annFollowUp()(CRM, [{ type: 'checked', who: 'floorboss', id: 'c001', source: 'crm', sees_email: false }, word]).ok, true, 'after a CRM read that couldn\'t see her email, the user\'s word counts');
  assert.equal(annFollowUp()({ sending: { channels: ['email'] }, connectors: {} }, [word]).ok, true, 'with nothing that can read replies, the user\'s word counts');
});

test('"ask me" for a failed reader counts for that reader only', () => {
  const failed = { type: 'tool_failed', who: 'floorboss', task: 'crm.activity', error: 'timeout' };
  assert.equal(annFollowUp()(CRM, [failed, word]).ok, false, 'the CRM failed, and the user hasn\'t said they\'ll answer instead');
  assert.equal(annFollowUp()(CRM, [failed, { type: 'answered', who: 'user', ask: 'reader_fallback', value: 'user', task: 'email.messages', said: 'ask me' }, word]).ok, false, 'an answer about the mailbox doesn\'t cover the CRM');
  assert.equal(annFollowUp()(CRM, [failed, { type: 'answered', who: 'user', ask: 'reader_fallback', value: 'user', task: 'crm.activity', said: 'ask me' }, word]).ok, true, 'they chose to answer for the CRM: their word counts');
});

// The mock event driven to its outbox, every first message reported sent: a fresh home for each test.
function sentHome() {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  const r = drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 220 });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  const sent = (r.last.summary?.in_outbox_to_send || []).filter((x) => x.touch === 1).map((x) => x.id);
  assert.ok(sent.length > 1, JSON.stringify(r.last.summary).slice(0, 300));
  writeFileSync(join(HOME, 'work', 'sent.json'), JSON.stringify({ items: sent.map((who) => ({ who, what: 'sent', date: NOW.slice(0, 10) })) }));
  const rec = run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', join(HOME, 'work', 'sent.json')]);
  assert.ok(!rec.ERROR, rec.ERROR);
  return HOME;
}
const setConfig = (HOME, extra) => writeFileSync(join(HOME, 'config.json'), JSON.stringify({ ...json(join(HOME, 'config.json')), ...extra }));

test('with the CRM connected, every run starts by reading it for everyone written to; what it logged stops follow-ups', { timeout: 300000 }, () => {
  const HOME = sentHome();
  setConfig(HOME, { connectors: { 'crm.activity': { server: 'hubspot', tool: 'get_contact_activity', args: { email: '{email}' } } } });
  run(HOME, 'flow', ['next', '--new-run']);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'check_replies_crm', `${s.step}: ${JSON.stringify(s).slice(0, 300)}`);
  run(HOME, 'event-outreach', ['sync-list', '--event', MOCK]);
  const listed = json(s.judge.read);
  assert.ok(listed.length > 1);
  // The CRM logged (from the user's mailbox) one yes with a time and one no, and nothing for the rest.
  const [yes, no, ...rest] = listed;
  const on = `${NOW.slice(0, 10)}T10:00:00Z`;
  writeFileSync(s.judge.write, JSON.stringify({ people: [
    { id: yes.id, activities: [{ activity_id: 'a1', type: 'email', direction: 'in', at: on, subject: 'Re: Harbour', intent: 'booked', time: '2026-11-03 10:00' }] },
    { id: no.id, activities: [{ activity_id: 'a2', type: 'email', direction: 'in', at: on, subject: 'Re: Harbour', intent: 'decline' }] },
    ...rest.map((p) => ({ id: p.id, activities: [] }))] }));
  const synced = run(HOME, 'event-outreach', ['sync', '--event', MOCK, '--source', 'crm', '--file', s.judge.write]);
  assert.equal(synced.saved, true, JSON.stringify(synced));
  assert.ok(synced.recorded.some((l) => /no more follow-ups/.test(l)) && synced.recorded.some((l) => /said no/.test(l)), synced.recorded.join(' | '));
  // The yes and its time go to the user before anything else; the CRM isn't read again in this run.
  const after = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(after.step, 'reply_action', `${after.step}: the time the CRM logged is put to the user`);
  assert.equal(JSON.stringify(after).includes(yes.id), true);
  const booked = answer(HOME, 'reply_action', { ...after.ask.person, answer: 'yes' });
  assert.ok(!booked.ERROR, booked.ERROR);
  // The CRM had no email with the rest since the first messages: it can't vouch for them, so the user is asked,
  // naming them; the CRM isn't read again in this run.
  const asked = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(asked.step, 'replies_since', `${asked.step}: ${JSON.stringify(asked).slice(0, 300)}`);
  assert.match(asked.ask.question, /Your CRM shows no email with .* since your last message/);
  assert.ok(!answer(HOME, 'replies_since', 'none').ERROR);
  // Then the confirmation for the meeting the CRM showed, and nothing else.
  const then = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(then.step, 'draft', JSON.stringify(then).slice(0, 300));
  assert.deepEqual(then.judge.ids, [`${yes.id}:0`]);
  // A new run (the next session) reads it again.
  run(HOME, 'flow', ['next', '--new-run']);
  assert.equal(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'check_replies_crm', 'a new run reads the CRM again');
});

test('with nothing connected that can see replies, every run asks what came in before anything else, and a report must be recorded first', { timeout: 300000 }, () => {
  const HOME = sentHome();
  run(HOME, 'flow', ['next', '--new-run']);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'replies_since', `${s.step}: ${JSON.stringify(s).slice(0, 300)}`);
  assert.match(s.ask.question, /replied, booked or moved a time, cancelled, said no/);
  const report = answer(HOME, 'replies_since', 'no, Lucy said yes to Thursday');
  assert.ok(report.ERROR && /Record what they told you first/.test(report.ERROR), 'a report that starts with "no" isn\'t taken as "none"');
  assert.ok(!answer(HOME, 'replies_since', 'none').ERROR);
  assert.ok(DONE(run(HOME, 'flow', ['next', '--event', MOCK])), 'asked once in this run, then nothing more to do today');
  // An hour later in the same run, it's asked again.
  const later = new Date(Date.parse(NOW) + 61 * 60e3).toISOString();
  assert.equal(at(HOME, later, ['next', '--event', MOCK]).step, 'replies_since', 'an hour on, asked again');
  run(HOME, 'flow', ['next', '--new-run']);
  const again = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(again.step, 'replies_since', 'a new run asks again');
  // "recorded" stands only on a record made after the question.
  const said = (v) => answer(HOME, 'replies_since', v);
  assert.match(said({ answer: 'recorded', ledger_lines: again.ask.ledger_lines }).ERROR || '', /Nothing was recorded since the question/);
  const someone = json(join(HOME, 'work', 'sent.json')).items[0].who;
  writeFileSync(join(HOME, 'work', 'reply.json'), JSON.stringify({ items: [{ who: someone, what: 'replied', said: 'she wrote back yes' }] }));
  assert.ok(!run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', join(HOME, 'work', 'reply.json')]).ERROR);
  assert.ok(!said({ answer: 'recorded', ledger_lines: again.ask.ledger_lines }).ERROR, '"recorded" once outreach record wrote it');
  assert.ok(DONE(run(HOME, 'flow', ['next', '--event', MOCK])));
});

test('a CRM that has logged only your own emails can\'t vouch for anyone: the user is asked', { timeout: 300000 }, () => {
  const HOME = sentHome();
  setConfig(HOME, { connectors: { 'crm.activity': { server: 'hubspot', tool: 'get_contact_activity', args: { email: '{email}' } } } });
  run(HOME, 'flow', ['next', '--new-run']);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(s.step, 'check_replies_crm');
  run(HOME, 'event-outreach', ['sync-list', '--event', MOCK]);
  // Every first message is logged (BCC logging), and nothing incoming from anyone.
  const on = `${NOW.slice(0, 10)}T10:00:00Z`;
  writeFileSync(s.judge.write, JSON.stringify({ people: json(s.judge.read).map((p, i) => ({ id: p.id, activities: [{ activity_id: `o${i}`, type: 'email', direction: 'out', at: on, subject: 'Harbour' }] })) }));
  const synced = run(HOME, 'event-outreach', ['sync', '--event', MOCK, '--source', 'crm', '--file', s.judge.write]);
  assert.equal(synced.saved, true, JSON.stringify(synced));
  assert.match(synced.crm_cant_see_note || '', /hasn't logged an incoming email from anyone/);
  const asked = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.equal(asked.step, 'replies_since', `${asked.step}: ${JSON.stringify(asked).slice(0, 300)}`);
  const L = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(L.filter((e) => e.type === 'checked' && e.source === 'crm').every((e) => e.sees_email === false), 'no one counts as checked by the CRM');
});

test('a read of one person right before a send changes only that person\'s CRM state, not the run\'s', () => {
  const st = fold([
    { at: '2026-11-03T09:00:00Z', type: 'sync_ran', source: 'crm', people: 3, run: 'r1', blind: ['c002', 'c003'], seen: ['c001', 'c002', 'c003'], logs_inbound: true },
    { at: '2026-11-03T09:40:00Z', type: 'sync_ran', source: 'crm', people: 1, run: 'r1', blind: [], seen: ['c002'], logs_inbound: true, partial: true },
  ]);
  assert.equal(st.last.sync_crm, '2026-11-03T09:00:00Z', 'the full read\'s time stands');
  assert.deepEqual(st.last.sync_crm_blind, ['c003']);
  assert.equal(st.last.crm_logs_inbound, true);
});

test('the mailbox reader is down and the CRM can see her email: its read clears the follow-up at the guard too', () => {
  const both = { sending: { channels: ['email'] }, connectors: { 'email.messages': { server: 'gmail' }, 'crm.activity': { server: 'hubspot' } } };
  const failed = { type: 'tool_failed', who: 'floorboss', task: 'email.messages', error: 'connection lost' };
  assert.equal(annFollowUp()(both, [failed, { type: 'checked', who: 'floorboss', id: 'c001', source: 'crm', sees_email: true }]).ok, true, 'a CRM read that sees her email counts with the mailbox down');
  assert.equal(annFollowUp()(both, [failed, { type: 'checked', who: 'floorboss', id: 'c001', source: 'crm', sees_email: false }, word]).ok, false, 'a CRM that can\'t see her, and a mailbox the user hasn\'t answered for: their word isn\'t enough (the flow asks about the mailbox)');
});
