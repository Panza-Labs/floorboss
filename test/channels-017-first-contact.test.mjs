// 0.1.7, owner answer A1: when every step before a person's next step was skipped (their first message couldn't be
// delivered), that step becomes their first contact: written again as a first message, approved again in the next
// batch, and sent on its own planned day. The old follow-up text never goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { spawnSync } from 'node:child_process';
import { ROOT } from './fixtures/harness.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const log = (H) => join(H.dir, 'ledger.jsonl');
const entries = (H) => readLedger(log(H)).entries;
const state = (H) => legacyState(fold(entries(H)));
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const listed = (H, id, at) => {
  cli(H, 'event-outreach', ['send-list', '--event', H.slug], at);
  return read(join(H.dir, 'derived', 'send-list.json')).some((x) => x.id === id && x.touch === 2);
};

function skipped() {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, route: ['app', 'email'], ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const old = state(H)[ana].touches[2];
  assert.ok(old?.approved, 'message 2 approved before the skip');
  const planned = entries(H).filter((e) => e.type === 'drafted' && e.id === ana && e.touch === 2).pop()?.planned_due;
  assert.ok(planned && planned > NOW.slice(0, 10), `message 2 has a planned day after today: ${planned}`);
  append(log(H), { type: 'browser_send_opened', who: 'user', said: 'go ahead', items: [`${ana}:1`], until: '2026-10-12T09:00:00Z' }, new Date(NOW));
  cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '1', '--result', 'not_found', '--page-says', 'This attendee is no longer available'], NOW);
  return { H, ana, old, planned };
}

test('message 2 after a skipped message 1: the standing approval no longer counts, it is written again as a first email, approved in the next batch, and goes on its planned day', () => {
  const { H, ana, planned } = skipped();
  assert.ok(!state(H)[ana].touches[2]?.approved, 'the approval given for it as a follow-up no longer counts');
  assert.equal(listed(H, ana, `${planned}T08:00:00Z`), false, 'the old follow-up text does not go');
  const r = todoJobs(H);
  const job = r.jobs.find((j) => j.id === ana && j.touch === 2);
  assert.ok(job, 'it comes back to be written');
  assert.equal(job.followup, false, 'as a first message');
  assert.ok(!job.last_touch, 'no final ask');
  assert.ok(!job.previous_message, 'no earlier message to refer to');
  assert.equal(job.channel, 'email');
  cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ana, '--touch', '2', '--json', JSON.stringify((({ body, structure, fact_source, insight }) => ({ subject: 'Test Expo', body, brief: 'x, no research profile', structure, fact_source, ...(insight ? { insight } : {}) }))(draftFor({ ...r.t, insights: r.insights }, { ...job, slot_labels: job.slot_labels || [] })))]);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ana, '--touch', '2', '--text', 'PASS']);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(state(H)[ana].touches[2]?.approved, JSON.stringify(g).slice(0, 400));
  assert.equal(listed(H, ana, NOW), false, 'not today');
  assert.equal(listed(H, ana, `${planned}T08:00:00Z`), true, 'on its planned day');
  // The guard's prompt calls it the first message, not follow-up 1.
  const item = read(join(H.dir, 'derived', 'send-list.json')).find((x) => x.id === ana && x.touch === 2);
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: `${planned}T08:00:00Z` }));
  const gp = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: { to: item.to, subject: item.subject, body: item.body } }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: `${planned}T08:00:00Z` }, encoding: 'utf8' });
  assert.match(gp.stdout, /floorboss: send the first message to/, (gp.stdout || gp.stderr).slice(0, 400));
  assert.doesNotMatch(gp.stdout, /follow-up 1/);
});

test('an approval of the old follow-up text given again after the skip still does not let it go', () => {
  const { H, ana, old, planned } = skipped();
  append(log(H), { type: 'approved', who: 'user', said: 'approve all', id: ana, touch: 2, hash: old.approved.hash, to: old.approved.to, via: old.approved.via }, new Date(NOW));
  assert.equal(listed(H, ana, `${planned}T08:00:00Z`), false);
});

test('after a skipped message 1, the gate and the send list give the true reason for holding the old follow-up text', () => {
  const WHY = 'message 1 could not be delivered: this is now the first message, written again for your approval';
  const { H, ana, old, planned } = skipped();
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${ana}`]);
  const nr = (g.not_ready || []).find((x) => x.id === ana && x.touch === 2);
  if (nr) assert.equal(nr.reason, WHY, JSON.stringify(g).slice(0, 400));
  append(log(H), { type: 'approved', who: 'user', said: 'approve all', id: ana, touch: 2, hash: old.approved.hash, to: old.approved.to, via: old.approved.via }, new Date(NOW));
  const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug], `${planned}T08:00:00Z`);
  const w = (sl.waiting || []).find((x) => x.id === ana && x.touch === 2);
  assert.equal(w?.why, WHY, JSON.stringify(sl).slice(0, 400));
});
