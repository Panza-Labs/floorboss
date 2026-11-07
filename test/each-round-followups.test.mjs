// Founders with each-round follow-ups: receipts survive per-person lists;
// the prompt shows what the message says, not the greeting; free time typed as "mornings except wednesday";
// unreachable fitting people are named at the gate; the critic sees the earlier message and the mailbox note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { parseFreeTimes } from '../skills/slot-finder/scripts/freetimes.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const guard = (H, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };

test('receipts: sending one person at a time (send-list --ids) and recording all receipts afterwards works; the prompt shows the message, not "Hi X,"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const sends = [];
  for (const name of ['Ana Berg', 'Bo Li']) {
    const id = idOf(H, name);
    const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--ids', id]);
    const [it] = JSON.parse(readFileSync(l.file, 'utf8'));
    const g = guard(H, { to: it.to, subject: it.subject, body: it.body });
    assert.equal(g.status, 0, g.stderr);
    const reason = JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.doesNotMatch(reason, /: "Hi (Ana|Bo),"/, `the prompt must show what the message says: ${reason}`);
    sends.push({ id, touch: 1, message_id: `m-${id}` });
  }
  cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--ids', 'c999']); // the list now holds nobody
  const r = cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })]);
  assert.equal(r.recorded.length, 2, JSON.stringify(r));
  assert.deepEqual(r.refused || [], []);
});

test('free time typed the way a founder says it', () => {
  const days = ['2026-11-11', '2026-11-12', '2026-11-13'];
  const show = (t) => parseFreeTimes(t, { eventDays: days }).ranges.map((x) => `${x.date.slice(8)}:${x.start / 60}-${x.end / 60}`).sort().join(' ');
  assert.equal(parseFreeTimes('mornings except wednesday, and thursday after lunch', { eventDays: days }).unparsed.length, 0);
  assert.equal(show('mornings except wednesday, and thursday after lunch'), '12:13-18 12:8-12 13:8-12');
  assert.equal(show('thursday and friday mornings, thursday 14-17'), '12:14-17 12:8-12 13:8-12');
  assert.equal(show('Thu after lunch'), '12:13-18');
});

test('the gate names fitting people floorboss has no way to reach', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nNo Mail,COO,Globex,\n', event: { app_name: null, no_app: true }, settings: { linkedin_messages: false } });
  const { gate } = triage(H);
  const why = (gate.left_out || []).map((x) => x.why).join(' | ');
  assert.match(why, /fits, but no email address/, why);
});

test('the critic gets the earlier message of a sequence drafted up front, and the mailbox note', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { touches: 2, sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const { t, jobs } = todoJobs(H);
  assert.ok(jobs.some((j) => j.touch === 2), 'with sending on the whole sequence is drafted up front');
  const ana = idOf(H, 'Ana Berg');
  for (const j of jobs.filter((x) => x.id === ana && x.kind === 'message')) cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi Ana, message ${j.touch}. Could we find 30 minutes at Test Expo?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x' })]);
  const inp = cli(H, 'event-outreach', ['critic-input', '--event', H.slug, '--id', ana, '--touch', '2']);
  assert.ok(inp.previous_message, 'the first message is there although nothing was sent yet');
});
