// Fixes from the CRM-connected three-session study (2026-11-06, cmp5): a CRM that reads its logged mail is no
// mailbox; a marketing-qualified lead is no conversation; the researcher knows which company it is by its
// domain; the user's words for customers reach their drafts. Invented people at .example and .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
import { defaultStatusMeaning } from '../skills/crm-triage/scripts/sources.mjs';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';

test('a CRM that lists the mail it logged is a CRM, not a mailbox floorboss could send from', () => {
  const kinds = (name, tools) => summarize([], { mcp: [{ name, tools }] }).found;
  const pd = kinds('pipedrive', ['find_person', 'add_person', 'list_mail_messages', 'list_person_activities']);
  assert.ok(pd.crm.some((x) => /pipedrive/.test(x)), JSON.stringify(pd));
  assert.ok(!(pd.email || []).some((x) => /pipedrive/.test(x)), JSON.stringify(pd));
  const hs = kinds('hubspot', ['search_contacts', 'list_engagements', 'get_email_messages']);
  assert.ok(!(hs.email || []).some((x) => /hubspot/.test(x)));
  // A real mailbox stays one, whatever else its tools read.
  assert.ok(kinds('claude_ai_Gmail', ['search_threads', 'get_thread', 'create_draft']).email.length);
  assert.ok((kinds('zoho_mail', ['list_messages', 'get_message', 'search_mail']).email || []).length, 'a mail server named after a CRM vendor');
  assert.ok((kinds('outlook', ['list_messages', 'get_person', 'get_organization']).email || []).length);
  assert.ok((kinds('m365', ['list-mail-messages', 'find-person']).email || []).length);
});

test('a marketing-qualified lead (a download, a form) is no conversation; a sales-qualified one is', () => {
  for (const v of ['Marketing Qualified Lead', 'MQL', 'marketing-qualified']) assert.equal(defaultStatusMeaning(v), 'ignore', v);
  for (const v of ['Sales Qualified Lead', 'SQL', 'Opportunity']) assert.equal(defaultStatusMeaning(v), 'warm', v);
  // Anything two-way beside the MQL still reads as a conversation.
  for (const v of ['MQL - meeting booked', 'MQL to SQL', 'SQL (was MQL)', 'MQL, demo scheduled', 'MQL (replied)', 'Marketing qualified - in conversation'])
    assert.equal(defaultStatusMeaning(v), 'warm', v);
  for (const v of ['MQL, never responded', 'MQL - demo requested', 'MQL - not yet met', 'MQL - meeting no-show', 'MQL - not met', "MQL - hasn't replied", 'MQL - no demo yet']) assert.equal(defaultStatusMeaning(v), 'ignore', v);
});

test('the company plan gives the researcher the company\'s own domain, from a work address', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Haulvo,ana@haulvo-freight.example\nBo Li,CFO,Haulvo,bo@haulvo-freight.example\nCy Ng,COO,Solo Co,cy@gmail.test\nDi Fox,COO,Brightwave,di@agency-partners.example\nEd Roe,CEO,Live Oakfield Freight,ed@live.test\nFay Lo,COO,HXL Freight,fay@hxl.example\nGus Ho,CFO,HXL Supply Chain,gus@hxl-sc.example\n' });
  triage(H);
  const plan = cli(H, 'attendee-research', ['company-plan', '--event', H.slug]);
  const of = (name) => (plan.companies || []).find((x) => x.company === name);
  assert.ok(of('Haulvo') && of('Solo Co'), JSON.stringify(plan).slice(0, 300));
  assert.equal(of('Haulvo').domain, 'haulvo-freight.example');
  assert.equal(of('Solo Co').domain, undefined, 'a mail provider is no company domain');
  if (of('Brightwave')) assert.equal(of('Brightwave').domain, undefined, "an agency's domain doesn't carry the company's name");
  assert.ok(of('Live Oakfield Freight') && of('HXL Freight'), JSON.stringify(plan).slice(0, 400));
  assert.equal(of('Live Oakfield Freight').domain, undefined, 'a mail provider, even one sharing a word with the company');
  assert.equal(of('HXL Freight').domain, 'hxl.example', 'a three-letter name as the domain itself');
  assert.equal(of('HXL Supply Chain')?.domain, 'hxl-sc.example', 'a three-letter brand beside longer words');
});

test('the user\'s own words for customers are saved with the rule and reach a customer\'s draft', async () => {
  const { makeHome, cli: dcli } = await import('./sims/lib/driver.mjs');
  const H = makeHome({});
  const f = join(H.HOME, 'work', 'c.json');
  writeFileSync(f, JSON.stringify('a warm note, but just a friendly hello and a coffee, no pitch, no upsell'));
  dcli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  assert.equal(cfg.customer_rule.other, 'warm');
  assert.match(cfg.customer_said, /no pitch, no upsell/);
  writeFileSync(f, JSON.stringify('a warm note (recommended)'));
  dcli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')).customer_said, '', 'an option alone carries no words');
  writeFileSync(f, JSON.stringify('warm, no pitch'));
  dcli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')).customer_said, 'warm, no pitch', 'short guidance is kept');
  writeFileSync(f, JSON.stringify('warm, reference the Q3 rollout'));
  dcli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
  assert.match(JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')).customer_said, /Q3 rollout/, 'guidance phrased as a to-do');
  for (const bare of ['ask me each time', 'warm note', 'A warm note.', 'leave customers alone', 'a warm note for all of them', 'yes the warm note one', 'warm note for every customer', 'a warm note (recommended), just the default', 'hello? warm note']) {
    writeFileSync(f, JSON.stringify(bare));
    dcli(H, 'flow', ['answer', '--ask', 'customers', '--value-file', f]);
    assert.equal(JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')).customer_said, '', bare);
  }
  // At the event: a customer the rule placed gets the words in their job.
  const C = setup({
    attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n',
    crm: 'Name,Email,Company,Owner,Status\nAna Berg,ana@acme.test,Acme,Sam Rivera,Customer\n',
    settings: { crm_user_name: 'Sam Rivera', customer_rule: { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' }, customer_said: 'a friendly hello and a coffee, no pitch' }
  });
  triage(C);
  const { jobs, t } = todoJobs(C);
  const job = jobs.find((j) => j.id === idOf(C, 'Ana Berg'));
  assert.ok(!t.ERROR, t.ERROR);
  assert.ok(job, 'Ana has a draft job');
  assert.match(job.user_note || '', /How to write to your customers: a friendly hello and a coffee, no pitch/);
});

test('after a bounce with a new address, the CRM is looked up again for the new one', async () => {
  const { gatherEvidence } = await import('../skills/crm-triage/scripts/evidence.mjs');
  const claire = { id: 'c016', name: 'Claire Dubois', company: 'Portlane', email: 'claire.dubois@portlane.example', emails: ['claire.dubois@portlane.example', 'cdubois@portlane.example'] };
  // "Not found" for the old address says nothing about the new one: the new one is looked up before anything goes.
  const ev = gatherEvidence(claire, { crm: { not_found: ['cdubois@portlane.example'] }, today: '2026-11-06' });
  assert.ok(ev.some((e) => e.unanswered), JSON.stringify(ev));
  assert.ok(!gatherEvidence(claire, { crm: { not_found: [claire.email] }, today: '2026-11-06' }).some((e) => e.unanswered));
  // The user says the CRM has nobody for them at this address: "not-in-crm" settles it, for that address only.
  const { resolve } = await import('../skills/crm-triage/scripts/resolve.mjs');
  const settle = (matches) => resolve({ ...claire, title: 'COO', company_key: 'portlane' }, ev, { settings: {}, today: '2026-11-06', fit: { segment: 'ops', reason: 'COO', score: 80 }, matches });
  assert.equal(settle([]).group, 'check');
  assert.equal(settle([{ group: 'different-person' }]).group, 'check', 'an answer about another lookalike settles nothing here');
  assert.equal(settle([{ group: 'not-in-crm', email: 'cdubois@portlane.example' }]).group, 'check', 'said for the old address');
  assert.equal(settle([{ group: 'not-in-crm', email: claire.email }]).group, 'reach');
});

test('a bounce with a new address says the CRM is looked up again, and what to do if it holds the old one', async () => {
  const { planRecord } = await import('../skills/event-outreach/scripts/record.mjs');
  const byId = { c016: { id: 'c016', name: 'Claire Dubois', company: 'Portlane', email: 'cdubois@portlane.example' } };
  const state = { c016: { sent: { 1: '2026-11-03' }, touches: { 1: { status: 'sent' } } } };
  const run = (crmConnected) =>
    planRecord([{ who: 'c016', what: 'bounced', new_email: 'claire.dubois@portlane.example' }], { byId, state, approved: new Set(), coordinate: new Map(), slots: [], zone: 'Europe/Amsterdam', now: new Date('2026-11-06T09:00:00Z'), minutes: 30, eventDays: [], crmConnected });
  assert.match(run(true).lines.join(' '), /asked whether your CRM has them under the new address; if it has a record under the old one, add the new address there yourself/);
  assert.doesNotMatch(run(false).lines.join(' '), /your CRM/);
});

test('sends the user made days ago and records now are asked about before any follow-up', { timeout: 300000 }, async () => {
  const { NOW } = await import('./fixtures/harness.mjs');
  const { simplePersona, drive } = await import('./sims/lib/driver.mjs');
  const { MOCK, envOf, run, loadMock, home } = await import('./fixtures/r2.mjs');
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip' } });
  const r = drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 220 });
  const sent = (r.last.summary?.in_outbox_to_send || []).filter((x) => x.touch === 1).map((x) => x.id);
  assert.ok(sent.length);
  const f = join(HOME, 'work', 'sent.json');
  // Sent ten days ago, recorded in this run: answers could have come.
  writeFileSync(f, JSON.stringify({ items: sent.map((who) => ({ who, what: 'sent', date: new Date(Date.parse(NOW) - 10 * 864e5).toISOString().slice(0, 10) })) }));
  assert.ok(!run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]).ERROR);
  assert.equal(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since');
});

test('a draft left out at the gate is approved later by its id only: "yes" or "approve all" approves nothing', { timeout: 300000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { NOW, ROOT } = await import('./fixtures/harness.mjs');
  const { simplePersona } = await import('./sims/lib/driver.mjs');
  const { untilStep } = await import('./fixtures/flow-until.mjs');
  const { MOCK, envOf, run, loadMock, home, answer } = await import('./fixtures/r2.mjs');
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  untilStep({ HOME, now: NOW, env: envOf(HOME) }, per, 'approve');
  const ids = [...new Set(JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8')).jobs.filter((j) => j.kind === 'message').map((j) => j.id))];
  assert.ok(!answer(HOME, 'approve', `approve all except ${ids[0]}`).ERROR);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.ok((s.accepts || []).includes('approve_held'), JSON.stringify(s).slice(0, 300));
  assert.ok(!(s.accepts || []).includes('approve'));
  // In turn, as real use runs (no out-of-turn test switch).
  const env = { ...envOf(HOME) };
  delete env.FLOORBOSS_OUT_OF_TURN;
  const say = (ask, text) => {
    const f = join(HOME, 'work', 'held.txt');
    writeFileSync(f, text);
    try {
      return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', MOCK, '--ask', ask, '--value-file', f], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      return { ERROR: String(e.stderr || e.stdout) };
    }
  };
  const approvedNow = () => readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).some((x) => x.type === 'approved' && x.id === ids[0]);
  assert.match(say('approve', 'yes').ERROR || '', /isn't asking "approve"/);
  for (const t of ['yes', 'approve all', `approve all except ${ids[1]}`]) assert.match(say('approve_held', t).ERROR || '', /by its id only/, t);
  assert.equal(approvedNow(), false);
  assert.match(say('approve_held', `approve ${ids[0]}:1`).ERROR || '', /names the person/, 'a message number on an approval is refused');
  assert.ok(!say('approve_held', `approve ${ids[0]}`).ERROR);
  assert.equal(approvedNow(), true);
});

test('stuck drafts are dropped or edited by id; a bare "ok" there approves nothing', async () => {
  const { MOCK, loadMock, home, answer } = await import('./fixtures/r2.mjs');
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  for (const t of ['ok', 'yes', 'approve all']) assert.match(answer(HOME, 'stuck_drafts', t).ERROR || '', /dropped or edited by id/, t);
  assert.ok(!answer(HOME, 'stuck_drafts', 'leave them for now').ERROR);
});

test('check-these: "<id> not-in-crm" settles a lookup that gave no answer, for the address they have', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\n' });
  const f = join(H.dir, 'crm-records.json');
  writeFileSync(f, JSON.stringify({ records: [], not_found: ['bo@globex.test'] }));
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm-records', '--file', f]).ERROR);
  triage(H);
  const groupOf = (name) => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(H, name)].group;
  assert.equal(groupOf('Ana Berg'), 'check', 'the lookup gave no answer for Ana');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${idOf(H, 'Ana Berg')} not-in-crm`]);
  assert.ok(!r.ERROR, r.ERROR);
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.notEqual(groupOf('Ana Berg'), 'check');
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(led.some((x) => x.type === 'decide' && x.group === 'not-in-crm' && x.email === 'ana@acme.test'), 'recorded with the address it was said for');
});

test('not-in-crm: offered by the flow where the lookup gave no answer, takes no row, and settles someone with no address', async () => {
  const { parseDecisions } = await import('../skills/crm-triage/scripts/decisions.mjs').catch(() => ({}));
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana-berg-example\nBo Li,COO,Globex,bo@globex.test,\n' });
  const f = join(H.dir, 'crm-records.json');
  writeFileSync(f, JSON.stringify({ records: [], not_found: ['bo@globex.test'] }));
  assert.ok(!cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm-records', '--file', f]).ERROR);
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  const groupOf = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[ana].group;
  assert.equal(groupOf(), 'check');
  assert.match(cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${ana} not-in-crm crm:0`]).ERROR || '', /./, 'a row after not-in-crm is refused');
  assert.ok(!cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${ana} not-in-crm`]).ERROR);
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.notEqual(groupOf(), 'check', 'no address: the answer recorded with none settles them');
  assert.match(cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ana, '--group', 'not-in-crm', '--because', 'x']).ERROR || '', /--group is one of/);
  void parseDecisions;
});
