// 0.1.7: LinkedIn is never sent by floorboss; a LinkedIn step is always sent by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { effectiveSettings } from '../lib/config.mjs';
import { channelOn } from '../lib/sendcheck.mjs';
import { sendRoute } from '../skills/event-outreach/scripts/commands/routes.mjs';

const node = (id) => NODES.find((n) => n.id === id);
const ALL = { ev: { app_name: 'Grip' }, cfg: {}, ans: {}, inv: { found: { email: ['mcp:gmail'], chat: ['mcp:whatsapp'], browser: ['mcp:claude-in-chrome'] } } };

test('LinkedIn is not a channel floorboss can send on: not offered, never asked about, never saved', () => {
  for (const found of [ALL.inv.found, { browser: ['x'] }]) {
    const s = { ...ALL, inv: { found } };
    assert.ok(!node('sending').options(s).some((o) => /linkedin/i.test(o)), JSON.stringify(node('sending').options(s)));
    assert.doesNotMatch(node('sending').ask(s), /linkedin/i);
  }
  // An answer saved before (or typed) that names LinkedIn: the LinkedIn warning question isn't asked.
  assert.equal(node('linkedin_send').when({ ...ALL, ans: { sending_channels: ['email', 'linkedin'] } }), false);
  // Settings written before 0.1.7 with LinkedIn sending on: read as off, everywhere.
  const st = effectiveSettings({ sending: { channels: ['email', 'app', 'linkedin'], followups: 'scheduled', linkedin_ack: true } }, {});
  assert.deepEqual(st.sending.channels, ['email', 'app']);
  assert.equal(st.sending.linkedin_ack, false);
  assert.equal(channelOn(effectiveSettings({ sending: { channels: ['linkedin'], linkedin_ack: true } }, {}), 'browser'), false);
});

const answer = (HOME, ask, text) => {
  mkdirSync(join(HOME, 'work'), { recursive: true });
  const f = join(HOME, 'work', `${ask}.txt`);
  writeFileSync(f, text);
  return execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
};

test('an answer naming LinkedIn saves no LinkedIn sending', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-send-li-'));
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'full', linkedin_send_ack: true } }));
  answer(HOME, 'sending', 'email and linkedin please');
  const ans = JSON.parse(readFileSync(join(HOME, 'onboarding.json'), 'utf8')).answers;
  const chans = typeof ans.sending_channels === 'string' ? JSON.parse(ans.sending_channels) : ans.sending_channels;
  assert.deepEqual(chans, ['email']);
  answer(HOME, 'followups_mode', 'scheduled');
  const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
  assert.ok(!cfg.sending.channels.includes('linkedin'), JSON.stringify(cfg.sending));
  assert.equal(cfg.sending.linkedin_ack, false);
});

test('a LinkedIn step is always one the user sends by hand, even with settings that turned LinkedIn sending on', () => {
  const ct = { id: 'c001', name: 'Ana Berg', company: 'Acme', email: 'ana@acme.test', profile_url: 'https://www.linkedin.com/in/ana' };
  const settings = { channels: ['email', 'paste'], linkedin_messages: true, route: ['email', 'linkedin', 'app', 'email'], paste_limit: 600, sending: { channels: ['email', 'app', 'linkedin'], followups: 'scheduled', linkedin_ack: true } };
  const c = { byId: { c001: ct }, event: { app_name: 'Grip' }, settings, triage: { channels: {} }, config: {}, state: { c001: { touches: {} } }, folded: { people: { c001: { touches: {} } } } };
  assert.equal(sendRoute(c, 'c001', 'paste', 2), null, 'the LinkedIn step: by hand');
  assert.equal(sendRoute(c, 'c001', 'paste', 3)?.via, 'browser', 'the app note still goes in the browser');
});

test('a LinkedIn step on the send list says the user sends it themselves on LinkedIn', async () => {
  const { setup, cli, triage, draftApprove, idOf } = await import('./fixtures/harness.mjs');
  const { append } = await import('../lib/ledger.mjs');
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, route: ['email', 'linkedin', 'email'] } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  append(join(H.dir, 'ledger.jsonl'), { type: 'sent', who: 'floorboss', id: ana, touch: 1, date: '2026-10-12', via: 'floorboss', channel: 'email' }, new Date(NOW));
  const r = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nobody replied'], '2026-10-25T08:00:00Z');
  const w = (r.waiting || []).find((x) => x.id === ana && x.touch === 2);
  assert.equal(w?.why, 'you send this one yourself on LinkedIn', JSON.stringify(r).slice(0, 400));
});
