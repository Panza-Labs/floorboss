// 0.1.7: the rule the channel choice leans on, which holds today: an email reply holds that person's event-app follow-up.
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

test('an email reply holds the event-app follow-up for that person', () => {
  const { H, ana } = routed(['email', 'app', 'email']);
  add(H, { type: 'replied', id: ana, touch: 1, channel: 'email', source: 'mailbox', who: 'mailbox' }, later(3));
  const st = state(H)[ana];
  assert.equal(st.replied, true, JSON.stringify(st).slice(0, 300));
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'email', said: 'nothing else' }, later(8));
  const out = listAt(H, later(8));
  assert.ok(!browserList(H).some((x) => x.id === ana && x.touch === 2), `the app note is held: ${JSON.stringify(out).slice(0, 300)}`);
  assert.ok(!emailList(H).some((x) => x.id === ana), 'and nothing else goes');
});
