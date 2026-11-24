// 0.1.7 review round 2: after message 1 was skipped (an app note the app said can't go), every caller treats the next
// step as a first message, as lib/sendcheck.mjs does: the guard's staging check, the unattended drafts, approval,
// drafting and the channel note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';
import { eventRecord } from '../lib/sendcheck.mjs';
import { earlierStepWhy } from '../lib/unattended-drafts.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { staleFor, savedBeforeIt } from '../skills/event-outreach/scripts/commands/saved-drafts.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'c'.repeat(64), test_draft: { draft_id: 't2', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const log = (H) => join(H.dir, 'ledger.jsonl');
const state = (H) => legacyState(fold(readLedger(log(H)).entries));
const read = (f) => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const HASNT = "the message before it hasn't gone";

function skippedFirst(channels = ['email', 'app']) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { app_name: 'Grip' }, settings: { sending: { channels, followups: 'scheduled' }, route: ['app', 'email'], ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, stage_draft: STAGE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  append(log(H), { type: 'browser_send_opened', who: 'user', said: 'go ahead', items: [`${ana}:1`], until: later(1, 20) }, new Date(later(1)));
  cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '1', '--result', 'messages_off', '--page-says', 'Messages are turned off'], later(1));
  assert.equal(state(H)[ana].touches[1].skipped, true);
  return { H, ana };
}

test('the guard does not refuse the draft of the step after a skipped message 1 as "the message before it hasn\'t gone"', () => {
  const { H, ana } = skippedFirst(['app']);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], later(1, 5));
  const item = read(sl.file).find((x) => x.id === ana && x.touch === 2) || { id: ana, touch: 2, to: 'ana@acme.test', kind: 'message' };
  process.env.FLOORBOSS_HOME = H.HOME;
  assert.notEqual(stageRefusal(H.dir, item, Date.parse(later(1, 6))), HASNT);
});

test('the unattended drafts use the same rule: no "hasn\'t gone" for the step after a skipped message 1', () => {
  const { H, ana } = skippedFirst(['app']);
  const rr = eventRecord(H.dir);
  assert.notEqual(earlierStepWhy(H.dir, rr.entries, rr.folded, { id: ana, touch: 2, to: 'ana@acme.test', thread: null }), HASNT);
});

test('with no earlier message, nothing is stale against one and approval does not wait for one', () => {
  assert.equal(savedBeforeIt({ before_hashes: { 0: null } }, 0, 2), false);
  const { H, ana } = skippedFirst();
  append(log(H), { type: 'revise', id: ana, touch: 2, feedback: 'shorter please', who: 'user', said: 'shorter' }, new Date(later(1, 10)));
  const t = todoJobs(H, later(1, 11));
  const j = t.jobs.find((x) => x.id === ana && x.touch === 2);
  assert.ok(j, `message 2 comes back to be written: ${JSON.stringify(t.jobs.map((x) => x.touch))}`);
  // No note about a message before it that never went.
  assert.ok(!j.channel_changed, 'no channel change');
  assert.doesNotMatch(readFileSync(t.t.todo_file, 'utf8'), /the message before it went on/);
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--json', JSON.stringify((({ body, structure, fact_source }) => ({ subject: 'Test Expo', body, brief: 'x, no research profile', structure, fact_source }))(draftFor({ ...t.t, insights: t.insights }, { ...j, slot_labels: j.slot_labels || [] })))], later(1, 12));
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS'], later(1, 12));
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${ana}`], later(1, 13));
  assert.ok(state(H)[ana].touches[2]?.approved, JSON.stringify(g).slice(0, 400));
  assert.equal(staleFor({ state: state(H), entries: readLedger(log(H)).entries, paths: { dir: H.dir } }, ana, 2, null), false);
});
