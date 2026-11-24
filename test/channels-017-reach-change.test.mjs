// 0.1.7 review: changing where to reach people after the drafts were approved takes the steps on a channel no longer
// chosen off (out of the outbox and every list), and says so in one line. A step that went is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, cli, triage, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';

const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const answer = (H, ask, text) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', `${ask}.txt`);
  writeFileSync(f, text);
  return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' }));
};

test('email only after approving app and LinkedIn steps: those are taken off, the user is told in one line, the sent step stays', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ reach: ['app', 'linkedin'] }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const log = join(H.dir, 'ledger.jsonl');
  const st = () => legacyState(fold(readLedger(log).entries))[ana];
  assert.deepEqual(Object.keys(st().touches).filter((t) => st().touches[t].approved), ['1', '2', '3', '4']);
  append(log, { type: 'sent', who: 'floorboss', id: ana, touch: 1, date: '2026-10-12', via: 'floorboss', channel: 'email' }, new Date(NOW));
  writeFileSync(join(H.HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: H.slug, answers: { setup_level: 'quick' } }));
  const r = answer(H, 'reach_channels', 'email only');
  const said = r.result?.say_to_user || '';
  assert.match(said, /1 Grip note and 1 LinkedIn message are taken off/, said);
  assert.match(said, /nothing else changes\./);
  const after = st();
  assert.ok(after.sent[1], 'the sent step is untouched');
  assert.ok(after.touches[1].approved, 'its approval too');
  for (const t of [2, 3]) assert.ok(!after.touches[t].approved, `step ${t} no longer approved`);
  cli(H, 'event-outreach', ['send-list', '--event', H.slug], '2026-10-30T08:00:00Z');
  const lists = ['send-list.json', 'browser-send-list.json'].map((f) => join(H.dir, 'derived', f)).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  assert.ok(!lists.flat().some((x) => x.id === ana && [2, 3].includes(x.touch)), JSON.stringify(lists));
  // Saying the same again changes nothing and says nothing about it.
  const again = answer(H, 'reach_channels', 'email only').result?.say_to_user || '';
  assert.doesNotMatch(again, /taken off/);
});
