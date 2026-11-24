// 0.1.7 setup, second review: small fixes (N1, N5, F4): each test reads the text the user reads (the step's
// question, from wording.mjs HAND_SEND_ASKS when an id has an entry there), not only the tree node's own ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { HAND_SEND_ASKS, withWhy } from '../skills/flow/scripts/steps/wording.mjs';

const EV = { slug: 'ev', name: 'Expo', start_date: '2026-12-10', app_name: null, no_app: true };
const tools = (server, list) => list.map((t) => `mcp__${server}__${t}`);
const invOf = (toolList) => summarize([], { tools: toolList });
const st = (s0) => ({ ev: EV, cfg: {}, ...s0, ans: { setup_level: 'full', ...s0.ans } });
// What the user reads for this question, as steps/setup.mjs onboardingAsk builds it; null when it is not asked.
const userQ = (s0, id) => {
  const s = st(s0);
  const n = NODES.find((x) => x.id === id);
  if (!n || !n.when(s) || n.done(s)) return null;
  const hs = HAND_SEND_ASKS[id];
  return { question: withWhy(id, (hs && hs.question(s)) || n.ask(s)), options: n.options ? n.options(s) : null, for_agent: hs ? n.ask(s) : null };
};
const GMAIL_READ = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'list_labels']);
const GMAIL_DRAFTS = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft', 'get_draft', 'send_email']);
const GMAIL_SEND = tools('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft', 'send_email']);
const HUBSPOT = tools('claude_ai_HubSpot', ['search_crm_objects', 'get_crm_objects', 'search_owners', 'manage_crm_objects']);

test('N1. the CRM connect steps name Customize, then Connectors', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../skills/flow/scripts/steps/intake.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /open Settings, then Connectors/);
  assert.match(src, /Customize, then Connectors \(claude\.ai\/customize\/connectors\)/);
});


test('F4. a Gmail that can only read: the send setup says so, and does not say to connect Gmail again', () => {
  const ro = userQ({ inv: invOf(GMAIL_READ), ans: { sending_asked: true, sending_channels: ['email'] } }, 'send_setup');
  assert.match(ro.question, /Your Gmail connection here can read but not send/);
  assert.match(ro.question, /floorboss can still read replies, and you send each email yourself/);
  assert.match(ro.question, /a mailbox connection that can send/);
  assert.doesNotMatch(ro.question, /find Gmail, click Connect/);
});

test('N5. plain names and one question mark', async () => {
  const { personName } = await import('../skills/event-context/scripts/scan.mjs');
  assert.equal(personName('whatsapp'), 'WhatsApp');
  assert.equal(personName('@gongrzhe/server-gmail-autoauth-mcp'), 'Gmail');
  assert.equal(personName('pipedrive_crm'), 'Pipedrive');
  assert.equal(personName('gmail_autoauth'), 'Gmail');
  const inv = invOf([...tools('msteams', ['list_messages', 'send_message'])]);
  assert.deepEqual(inv.found.email, []);
  const ss = userQ({ inv: invOf(GMAIL_DRAFTS), cfg: { own_email: 'sam@x.example' }, ans: { sending_asked: true, sending_channels: ['email'] } }, 'send_setup');
  assert.doesNotMatch(ss.question, /\?\)\?|\?\?/, ss.question);
  assert.match(ss.question, /sam@x\.example/);
});

test('N3. the readback title is neutral unless the setup answer was 1; the log question says "never" once', async () => {
  const { readbackTitle } = await import('../skills/flow/scripts/review.mjs');
  assert.equal(readbackTitle('Expo', 4, 'drafts'), 'Expo: every message you approve (4)');
  assert.equal(readbackTitle('Expo', 4, 'self'), 'Expo: every message you approve (4)');
  assert.equal(readbackTitle('Expo', 4, 'auto'), 'Expo: every message auto-send would send (4)');
  const { crmLogWindowQuestion } = await import('../skills/flow/scripts/steps/channels.mjs');
  const q = crmLogWindowQuestion({ n: 2, crmName: 'HubSpot', fill: true, create: false });
  assert.equal((q.match(/never/g) || []).length, 1, q);
});

test('crm_use: a plain name or its number saves the server it came from; a name not listed is refused', async () => {
  const { setup, cli } = await import('./fixtures/harness.mjs');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const server of ['hubspot', 'claude_ai_HubSpot']) {
    for (const said of ['HubSpot', '1']) {
      const H = setup({ attendees: 'Name,Title,Company,Email\n' });
      const inv = invOf([...tools(server, ['search_contacts', 'get_owner']), ...tools('pipedrive', ['search_deals', 'get_person'])]);
      writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ ...inv, scanned_at: new Date().toISOString() }));
      const f = join(H.dir, 'crm.json');
      writeFileSync(f, JSON.stringify(said));
      const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_use', '--value-file', f]);
      assert.ok(!r.ERROR, r.ERROR);
      const st = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
      const a = { ...(st.answers || {}), ...(st.events?.[H.slug]?.answers || {}) };
      assert.equal(a.crm_choice, 'connector');
      assert.equal(a.crm_server, server, `${server} / "${said}"`);
    }
  }
  const H = setup({ attendees: 'Name,Title,Company,Email\n' });
  writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ ...invOf(tools('hubspot', ['search_contacts', 'get_owner'])), scanned_at: new Date().toISOString() }));
  const f = join(H.dir, 'crm.json');
  writeFileSync(f, JSON.stringify('Salesforce'));
  assert.ok(cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_use', '--value-file', f]).ERROR, 'a CRM not listed is refused');
});
