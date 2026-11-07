// How a few answers are read: the option text the user picks can contain words of another option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followupsModeOf } from '../skills/flow/scripts/steps.mjs';

test('follow-up mode: "scheduled: each goes on its day" is scheduled, not each round', () => {
  assert.equal(followupsModeOf('scheduled: each goes on its day unless they reply, book or say stop (your mailbox or CRM is checked first)'), 'scheduled');
  assert.equal(followupsModeOf('I approve each round of follow-ups in bulk'), 'each_round');
  assert.equal(followupsModeOf('each round please'), 'each_round');
  assert.equal(followupsModeOf('just send them on schedule'), 'scheduled');
});

test('scan: tool names as the flow asks for them ("mcp__server__tool") are grouped and recognised', async () => {
  const { summarize } = await import('../skills/event-context/scripts/scan.mjs');
  const inv = summarize([], { tools: ['mcp__hubspot__search_contacts', 'mcp__hubspot__get_owner', 'mcp__gmail__list_messages', 'mcp__gmail__send_message', 'mcp__claude_ai_Notion__notion-calendar-list-events'] });
  assert.deepEqual(inv.found.crm, ['mcp:hubspot']);
  assert.deepEqual(inv.found.email, ['mcp:gmail']);
  assert.deepEqual(inv.found.calendar, ['mcp:claude_ai_Notion']);
});

test('running without the CRM: the warning names what is lost; "go ahead" keeps a warning on the gate card', async () => {
  const { CRM_INDEPENDENT_WARNING } = await import('../skills/flow/scripts/steps.mjs');
  for (const w of ['WARNING', 'Opt-outs', 'Colleagues', 'Customers', 'changed in the CRM recently', 'confirm each person']) assert.ok(CRM_INDEPENDENT_WARNING.includes(w), w);
  const { setup, cli, triage } = await import('./fixtures/harness.mjs');
  const { appendFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  appendFileSync(join(H.dir, 'ledger.jsonl'), JSON.stringify({ at: '2026-10-12T08:00:00Z', type: 'answered', who: 'user', ask: 'crm_independent', value: 'go_ahead', said: 'go ahead' }) + '\n');
  const t = triage(H);
  assert.match(t.fit.crm_warning || '', /NOT checked against your CRM/);
});

test('event app: "not sure / none" means no app, never an app called "not sure none"', async () => {
  const { setup, cli } = await import('./fixtures/harness.mjs');
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'app.json');
  writeFileSync(f, JSON.stringify('not sure / none'));
  assert.equal(cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'app', '--value-file', f]).ERROR, undefined);
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  assert.ok(!ev.app_name, `app_name: ${ev.app_name}`);
});

test('customers: the option a user picks is the rule saved, "(recommended)" or not', async () => {
  const { makeHome, cli } = await import('./sims/lib/driver.mjs');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const H = makeHome({});
  for (const [said, want] of [['a warm note (recommended)', 'warm'], ['ask me about each', 'ask'], ['leave customers alone', 'hold']]) {
    const f = join(H.HOME, 'work', 'c.json'); writeFileSync(f, JSON.stringify(said));
    cli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
    const r = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')).customer_rule;
    assert.deepEqual([r.recent, r.on_deal, r.other], [want, want, want], said);
  }
});

test('inbox_read: each inbox only on a yes for it; "no" leaves both closed', async () => {
  const { makeHome, cli } = await import('./sims/lib/driver.mjs');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const H = makeHome({});
  const set = (said) => { const f = join(H.HOME, 'work', 'i.json'); writeFileSync(f, JSON.stringify(said)); cli(H, 'flow', ['answer', '--ask', 'inbox_read', '--value-file', f]); const c = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')); return [c.inbox_read.linkedin, c.inbox_read.app, c.log_replies]; };
  assert.deepEqual(set('no, I\'ll tell you myself'), [false, false, false]);
  assert.deepEqual(set('yes: LinkedIn'), [true, false, false]);
  assert.equal(set('yes but only Meetwell, not LinkedIn')[0], false, 'a "not LinkedIn" is a no for LinkedIn');
  assert.equal(set('yes, everything except LinkedIn')[0], false);
  assert.equal(set('yes, LinkedIn and log the replies')[0], true);
  assert.deepEqual(set({ linkedin: false, app: true, log_replies: true }), [false, true, true]);
});
