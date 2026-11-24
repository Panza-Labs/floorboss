// 0.1.7 (spec section 12): a step that did not go never blocks the person's later steps. Message 1 an app note the app
// says can't go: the next step goes as a first message would, on its day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';
import { touchBefore } from '../lib/route.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);

function firstApp(route) {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, route, ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  append(join(H.dir, 'ledger.jsonl'), { type: 'browser_send_opened', who: 'user', said: 'go ahead', items: [`${ana}:1`], until: later(1, 20) }, new Date(later(1)));
  const r = cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '1', '--result', 'not_found', '--page-says', 'This attendee is no longer available'], later(1));
  assert.equal(r.ERROR, undefined, JSON.stringify(r));
  return { H, ana };
}

test('touchBefore is 0 when every earlier step was skipped', () => {
  assert.equal(touchBefore({ touches: { 1: { skipped: true } } }, 2), 0);
  assert.equal(touchBefore({ touches: { 1: {}, 2: { skipped: true } } }, 3), 1);
});

// Owner answer A1 (after round 2): the next step becomes the first message, written again and approved again
// (test/channels-017-first-contact.test.mjs follows it to its send). Here: it comes due, as a first message.
for (const [route, ch] of [[['app', 'email'], 'email'], [['app', 'linkedin'], 'paste']]) {
  test(`route ${route.join(', ')}: message 1 the app says can't go, then message 2 comes due as the first message`, () => {
    const { H, ana } = firstApp(route);
    const j = todoJobs(H, later(2)).jobs.find((x) => x.id === ana && x.kind === 'message' && x.touch === 2);
    assert.ok(j, 'message 2 comes due');
    assert.equal(j.channel, ch);
    assert.equal(j.followup, false);
  });
}
