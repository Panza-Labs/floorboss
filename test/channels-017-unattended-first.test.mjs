// 0.1.7 review round 3 (N1b): after a skipped message 1, the unattended drafts leave message 2 out until it was written
// again as a first message and approved; then its replies are read from the day message 1 was skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { readLedger, append, fold } from '../lib/ledger.mjs';
import { authorisable, readSince } from '../lib/unattended-drafts.mjs';
import { draftFor } from './sims/lib/driver.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'c'.repeat(64), test_draft: { draft_id: 't2', user_confirmed: true } };
const READ = { server: 'gmail', tool: 'list_messages', args: {}, reading: 'x', tool_hash: 'd'.repeat(64) };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };

test('message 2 after a skipped message 1 is left out of the unattended drafts until approved as a first message, then read from the skip day', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, route: ['app', 'email'], ...NOTES } });
  const config = { connectors: { 'email.send': RECIPE, stage_draft: STAGE, 'email.messages': READ } };
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(config));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const log = join(H.dir, 'ledger.jsonl');
  append(log, { type: 'browser_send_opened', who: 'user', said: 'go ahead', items: [`${ana}:1`], until: '2026-10-12T09:00:00Z' }, new Date(NOW));
  cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '1', '--result', 'not_found', '--page-says', 'gone'], NOW);
  // The old follow-up text approved again by hand: still left out.
  const old = readLedger(log).entries.filter((e) => e.type === 'approved' && e.id === ana && e.touch === 2).pop();
  append(log, { ...old, at: undefined, who: 'user', said: 'approve all' }, new Date(NOW));
  process.env.FLOORBOSS_HOME = H.HOME;
  const settings = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')).settings;
  const a1 = authorisable(H.slug, { config, settings, nowMs: Date.parse(NOW) });
  assert.ok(!a1.items.some((x) => x.id === ana && x.touch === 2), JSON.stringify(a1).slice(0, 300));
  assert.match(a1.skipped.find((x) => x.id === ana && x.touch === 2)?.why || '', /written again as a first message/);
  // Written again as a first message and approved: offered, and read from the day message 1 was skipped.
  const r = todoJobs(H);
  const j = r.jobs.find((x) => x.id === ana && x.touch === 2);
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--json', JSON.stringify((({ body, structure, fact_source }) => ({ subject: 'Test Expo', body, brief: 'x, no research profile', structure, fact_source }))(draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] })))]);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS']);
  cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  const a2 = authorisable(H.slug, { config, settings, nowMs: Date.parse(NOW) });
  assert.ok(a2.items.some((x) => x.id === ana && x.touch === 2), JSON.stringify(a2).slice(0, 400));
  const since = readSince(fold(readLedger(log).entries).people[ana], 2, 'ana@acme.test');
  assert.equal(since?.day, '2026-10-11', JSON.stringify(since));
});
