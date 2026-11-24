// 0.1.7 spec section 2: an event-app step that can't be delivered is skipped with the app's reason, and the person's
// other steps keep their days. Nothing is written in its place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const log = (H) => join(H.dir, 'ledger.jsonl');
const add = (H, e, now = NOW) => append(log(H), { who: 'user', said: 'noted', ...e }, new Date(now));
const entries = (H) => readLedger(log(H)).entries;
const state = (H) => legacyState(fold(entries(H)));
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []);
const emailList = (H) => read(join(H.dir, 'derived', 'send-list.json'));
const browserList = (H) => read(join(H.dir, 'derived', 'browser-send-list.json'));
const listAt = (H, now) => cli(H, 'event-outreach', ['send-list', '--event', H.slug], now);

function routed(route) {
  const S = { sending: { channels: ['email', 'app'], followups: 'scheduled' }, route, ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  add(H, { type: 'sent', id: ana, touch: 1, date: later(1).slice(0, 10), via: 'floorboss', who: 'floorboss', channel: 'email' }, later(1));
  return { H, ana };
}

for (const result of ['not_found', 'messages_off']) {
  test(`an app note the app says can't go (${result}) is skipped with the app's words, and the email after it goes on its day`, () => {
    const { H, ana } = routed(['email', 'app', 'email']);
    assert.ok(state(H)[ana].touches[3]?.approved, 'the whole sequence was approved up front');
    add(H, { type: 'browser_send_opened', who: 'user', items: [`${ana}:2`], until: later(5, 20), said: 'go ahead' }, later(5));
    const r = cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '2', '--result', result, '--page-says', 'This attendee is no longer available'], later(5));
    assert.equal(r.ERROR, undefined, JSON.stringify(r));
    // No replacement: the step is never written again or put on a list.
    add(H, { type: 'no_reply_said', ids: [ana], channel: 'email', said: 'nothing by email' }, later(20));
    listAt(H, later(20));
    assert.ok(emailList(H).some((x) => x.id === ana && x.touch === 3), `the email after it goes: ${JSON.stringify(listAt(H, later(20))).slice(0, 400)}`);
    assert.ok(!browserList(H).some((x) => x.id === ana && x.touch === 2), 'the skipped note is not sent');
    const st = state(H)[ana];
    assert.equal(st.touches[2].skipped, true, 'the app step is skipped');
    const sk = entries(H).find((e) => e.type === 'step_skipped' && e.id === ana && e.touch === 2);
    assert.equal(sk?.reason, 'Grip said: "This attendee is no longer available"', "the app's words, quoted");
  });
}
