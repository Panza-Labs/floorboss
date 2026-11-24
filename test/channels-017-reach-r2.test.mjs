// 0.1.7 review round 2, channel choice: the reply describes the route really used; more ways of saying no; a default
// route keeps the first gap; a hand edit of the choice takes approvals back when the route is next read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW, setup, cli, triage, draftApprove, idOf } from './fixtures/harness.mjs';
import { readReach, reachSaid } from '../lib/reach.mjs';
import { effectiveSettings } from '../lib/config.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';

const home = (cfg) => {
  const H = mkdtempSync(join(tmpdir(), 'fb-r2-'));
  mkdirSync(join(H, 'work'));
  writeFileSync(join(H, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'full' } }));
  if (cfg) writeFileSync(join(H, 'config.json'), JSON.stringify(cfg));
  return H;
};
const answer = (H, ask, text) => {
  const f = join(H, 'work', `${ask}.txt`);
  writeFileSync(f, text);
  return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H, FLOORBOSS_NOW: NOW }, encoding: 'utf8' }));
};

test('the reply describes the route that will really be used', () => {
  const H = home({ route: ['email', 'linkedin', 'email'] });
  const said = answer(H, 'reach_channels', 'the app').result?.say_to_user || '';
  assert.match(said, /Every message is an email/, said);
  assert.doesNotMatch(said, /note in the event app/, said);
});

test('when the user\'s own sequence has no step on a channel they chose, the reply says so in one line', () => {
  const H = home({ route: ['email', 'linkedin', 'email'] });
  const said = answer(H, 'reach_channels', 'the app').result?.say_to_user || '';
  assert.match(said, /Your own sequence has no app step, so the event app isn't used; say "change my sequence" to add one\./, said);
  const H2 = home({ route: ['email', 'app', 'email'] });
  assert.match(answer(H2, 'reach_channels', 'both').result?.say_to_user || '', /no LinkedIn step, so LinkedIn isn't used/);
});

test('more ways of saying no are read right, and the read-back is plain English', () => {
  for (const [t, reach] of [['I do not want linkedin', []], ["I don't want the app", []], ['neither app nor linkedin', []], ['app yes linkedin no', ['app']], ['linkedin yes, app no', ['linkedin']]])
    assert.deepEqual(readReach(t)?.reach, reach, t);
  assert.equal(reachSaid(['linkedin']), 'email and LinkedIn, and not the event app');
  assert.equal(reachSaid(['app']), 'email and the event app, and not LinkedIn');
});

test('with no route and no count of their own, email only keeps the first gap', () => {
  assert.deepEqual(effectiveSettings({ followup_gap: [2, 5], reach: [] }, {}).followup_gap, [2, 5]);
});

test('a choice changed by hand in the settings takes the approvals on channels no longer chosen back when the route is next read', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ reach: ['app', 'linkedin'] }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const log = join(H.dir, 'ledger.jsonl');
  append(log, { type: 'sent', who: 'floorboss', id: ana, touch: 1, date: '2026-10-13', via: 'floorboss', channel: 'email' }, new Date(NOW));
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ reach: [] }));
  const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nobody replied'], '2026-10-22T08:00:00Z');
  const st = legacyState(fold(readLedger(log).entries))[ana];
  for (const t of [2, 3]) assert.ok(!st.touches[t]?.approved, `step ${t} taken back`);
  assert.ok(!(sl.waiting || []).some((w) => /LinkedIn/.test(w.why) && w.touch === 2), JSON.stringify(sl.waiting));
});

for (const cmd of ['send-list', 'todo'])
  test(`a hand edit that takes approvals back is said in one line by ${cmd}`, () => {
    const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
    writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ reach: ['app', 'linkedin'] }));
    triage(H);
    draftApprove(H);
    writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ reach: [] }));
    const r = cli(H, 'event-outreach', [cmd, '--event', H.slug], '2026-10-22T08:00:00Z');
    assert.match(r.channels_changed || '', /1 Grip note and 1 LinkedIn message are taken off/, JSON.stringify(r).slice(0, 300));
  });
