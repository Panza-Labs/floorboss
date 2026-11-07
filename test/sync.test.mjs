// Sends and replies floorboss didn't make itself, read back from the user's mailbox (email.messages) and
// CRM (crm.activity) on every draft run, so nobody is written to twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, todoJobs } from './fixtures/harness.mjs';
import { screenTool, checkRecipe } from '../skills/connectors/scripts/tasks.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\n';
function ready() { const H = setup({ attendees: ATT }); triage(H); draftApprove(H); return H; }
const file = (H, name, data) => { const f = join(H.dir, name); writeFileSync(f, JSON.stringify(data)); return f; };
const log = (H) => readLedger(join(H.dir, 'ledger.jsonl')).entries;
const state = (H) => { const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl')); return fold(entries, damaged); };

test('sync tasks: only plainly named read tools are mapped; recipes must read one person', () => {
  for (const n of ['list_messages', 'search_messages', 'gmail_search_messages', 'list_threads']) assert.ok(screenTool('email.messages', n).ok, n);
  for (const n of ['send_message', 'reply_to_message', 'delete_message', 'forward_message', 'mark_as_sent', 'search_sent_messages']) assert.ok(!screenTool('email.messages', n).ok, n);
  for (const n of ['get_contact_activities', 'list_engagements', 'get_timeline', 'search_activities', 'hubspot_list_engagements']) assert.ok(screenTool('crm.activity', n).ok, n);
  for (const n of ['log_activity', 'create_activity', 'delete_engagement', 'update_activity', 'send_email']) assert.ok(!screenTool('crm.activity', n).ok, n);
  const done = { server: 's', tool: 'list_messages', reading: 'x', tool_hash: 'a'.repeat(64), probe: { ok: true } };
  assert.ok(checkRecipe('email.messages', { ...done, args: { folder: 'sent' } }).some((e) => /\{email\}/.test(e)));
  assert.deepEqual(checkRecipe('email.messages', { ...done, args: { query: 'from:{email} OR to:{email} after:{since}' } }), []);
  assert.ok(checkRecipe('crm.activity', { ...done, tool: 'get_contact_activities', args: { limit: 50 } }).some((e) => /crm_id/.test(e)));
  assert.deepEqual(checkRecipe('crm.activity', { ...done, tool: 'get_contact_activities', args: { contactId: '{crm_id}' } }), []);
});

test('sync: a message sent from the user\'s own mail and a reply reach the log; re-syncing adds nothing', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li');
  const sl = cli(H, 'event-outreach', ['sync-list', '--event', H.slug]);
  assert.equal(sl.people, 3);
  const since = JSON.parse(readFileSync(sl.file, 'utf8'))[0].since;
  assert.match(since, /^\d{4}-\d\d-\d\d$/);
  const answers = { people: [
    { id: ana, messages: [{ message_id: 'm1', direction: 'out', at: '2026-10-12T09:00:00Z', subject: 'Test Expo' }, { message_id: 'm0', direction: 'out', at: '2025-01-01T09:00:00Z' }] },
    { id: bo, messages: [{ message_id: 'm2', direction: 'in', at: '2026-10-12T10:00:00Z' }, { message_id: 'm3', direction: 'in', at: '2026-10-12T11:00:00Z', auto: true }] },
    { id: idOf(H, 'Cy Ng'), messages: [] },
  ] };
  const r = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', file(H, 'mail.json', answers)]);
  assert.equal(r.saved, true, JSON.stringify(r));
  assert.equal(r.recorded.length, 3);
  assert.match(r.recorded[0], /sent to Ana Berg .* found in your mailbox/);
  assert.match(r.recorded[1], /Bo Li .* wrote to you/);
  assert.match(r.recorded[2], /Bo Li .* automatic reply .* not a reply/, "the auto-reply isn't contact, and says so");
  assert.equal(r.ignored_older_or_notes, 1, 'the 2025 message is older than the plan');
  const again = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', file(H, 'mail.json', answers)]);
  assert.deepEqual(again.recorded, []);
  assert.equal(log(H).filter((e) => e.type === 'sent' && e.id === ana).length, 1);
  assert.equal(state(H).people[bo].replied, true);
  assert.ok(log(H).some((e) => e.type === 'reply_checked' && e.id === bo && e.who === 'mailbox'));
  const { jobs } = todoJobs(H);
  assert.ok(!jobs.some((j) => j.id === ana && j.touch === 1), 'Ana already got her first message');
  assert.ok(!jobs.some((j) => j.id === bo), 'Bo replied: nothing more');
});

test('sync: a send the user already reported isn\'t counted twice; a second message is the follow-up', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rep.json', { items: [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }] })]);
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug]);
  const r = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', file(H, 'mail.json', { people: [{ id: ana, messages: [
    { message_id: 'm1', direction: 'out', at: '2026-10-12T15:00:00Z' }, { message_id: 'm9', direction: 'out', at: '2026-10-20T09:00:00Z' }] }] })]);
  assert.equal(r.recorded.length, 1);
  assert.match(r.recorded[0], /counted as message 2/);
  const sent = log(H).filter((e) => e.type === 'sent' && e.id === ana).map((e) => e.touch);
  assert.deepEqual(sent, [1, 2]);
});

test('sync: a CRM call means in touch; a meeting it can\'t place holds the person and asks; record answers it', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg'), cy = idOf(H, 'Cy Ng');
  const LATER = '2026-10-14T08:00:00Z';
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug], LATER);
  const r = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'crm', '--file', file(H, 'crm.json', { people: [
    { id: ana, activities: [{ activity_id: 'a1', type: 'call', direction: 'out', at: '2026-10-13T15:00:00Z' }, { activity_id: 'a2', type: 'note', direction: null, at: '2026-10-13T15:30:00Z' }] },
    { id: cy, activities: [{ activity_id: 'a3', type: 'meeting', direction: null, at: '2026-11-10T09:00:00Z', subject: 'Test Expo coffee' }] },
  ] })], LATER);
  assert.match(r.recorded[0], /shows a call with Ana Berg/, JSON.stringify(r));
  assert.equal(r.ask_user.length, 1);
  assert.match(r.ask_user[0].why, /meeting with them at 2026-11-10T09:00:00.000Z \(subject "Test Expo coffee"\): is it booked/);
  const held = todoJobs(H, LATER);
  assert.ok(!held.jobs.some((j) => j.id === cy), 'Cy waits for the user\'s answer');
  assert.ok(!held.jobs.some((j) => j.id === ana), 'Ana is in touch');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rep.json', { items: [{ who: 'Cy Ng', what: 'booked', time: '2026-11-10 10:00' }] })], LATER);
  assert.ok(log(H).some((e) => e.type === 'unclear_resolved' && e.id === cy));
  assert.deepEqual(state(H).people[cy].unclear, []);
  assert.equal(state(H).people[cy].booked, 's20261110T1000');
});

test('sync: refuses people it wasn\'t asked about and answers that don\'t say who sent a message', () => {
  const H = ready();
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug]);
  const bad = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', file(H, 'mail.json', { people: [
    { id: 'c999', messages: [] }, { id: idOf(H, 'Ana Berg'), messages: [{ message_id: 'm1', at: '2026-10-12T09:00:00Z' }] }] })]);
  assert.equal(bad.saved, false);
  assert.ok(bad.errors.some((e) => /c999 wasn't on the list/.test(e)));
  assert.ok(bad.errors.some((e) => /direction must be "out" or "in"/.test(e)));
});
