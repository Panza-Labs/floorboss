// Staged drafts verified by fingerprint; close dates count only on customer rows and never from the future;
// d/m/y read from close dates too; a bounce with a new address re-opens the approvals; look-alike letters
// never match; option text in answers; "treat as new" means new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, groups, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { approvedText } from '../hooks/guard.mjs';
import { planQuestions } from '../skills/event-context/scripts/onboarding-tree.mjs';

const guard = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };

test('a staged draft is held to the approval fingerprint: the approved body to another address or subject is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const STAGE = { ...RECIPE, tool: 'create_draft', tool_hash: 'd'.repeat(64) };
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE } }));
  triage(H); draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${ana}-t1.json`), 'utf8'));
  process.env.FLOORBOSS_HOME = H.HOME; // approvedText reads the event's settings from the home, as the hook does
  assert.equal(approvedText(H.dir, { id: ana, touch: 1, to: 'evil@x.test', subject: 'Invoice attached', body: d.body }), false);
  assert.equal(approvedText(H.dir, { id: ana, touch: 1, to: 'ana@acme.test', subject: d.subject, body: d.body }), true);
  writeFileSync(join(H.dir, 'stage-list.json'), JSON.stringify([{ id: ana, touch: 1, to: 'evil@x.test', subject: 'Invoice attached', body: d.body }]));
  assert.equal(guard(H, 'mcp__gmail__create_draft', { to: 'evil@x.test', subject: 'Invoice attached', body: d.body }).status, 2);
});

test('a look-alike letter or a decorated address never passes as the approved one; the prompt quotes the call', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nKim Berg,COO,Acme,kim@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const [it] = JSON.parse(readFileSync(list.file, 'utf8'));
  assert.equal(guard(H, 'mcp__gmail__send_email', { to: 'Kim@acme.test', subject: it.subject, body: it.body }).status, 2, 'Kelvin sign');
  const list2 = JSON.parse(readFileSync(list.file, 'utf8'));
  writeFileSync(list.file, JSON.stringify(list2.map((x) => ({ ...x, to: `"${x.to}"` }))));
  assert.equal(guard(H, 'mcp__gmail__send_email', { to: `"${it.to}"`, subject: it.subject, body: it.body }).status, 2, 'quoted address in the list');
  writeFileSync(list.file, JSON.stringify(list2));
  const ok = guard(H, 'mcp__gmail__send_email', { to: it.to, subject: it.subject, body: it.body });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /, \\"kim@acme\.test\\"\)/, 'the prompt shows the address the call carries');
});

const LIST = 'Name,Title,Company,Email\nRae New,COO,Acme,rae@acme.test\nLee Lost,COO,Globex,lee@globex.test\nOla Open,COO,Initech,ola@initech.test\nEve Else,COO,Umbrella,eve@umbrella.test\n';
const RULE = { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' };

test('close dates: only a customer or won row counts, never a lost or open deal, never a future date; placeholders are not a deal', () => {
  const crm = 'Name,Company,Email,Deal Stage,Close Date,Associated Deal,Unsubscribed from all email\n'
    + 'Rae New,Acme,rae@acme.test,Closed Won,2026-08-01,Acme renewal,false\n'
    + 'Lee Lost,Globex,lee@globex.test,Closed Lost,2026-09-01,Globex platform,false\n'
    + 'Ola Open,Initech,ola@initech.test,Proposal,2027-01-15,Initech rollout,false\n'
    + 'Eve Else,Umbrella,eve@umbrella.test,Customer,2024-03-01,—,false\n';
  const H = setup({ attendees: LIST, crm, settings: { customer_rule: RULE } });
  triage(H);
  const g = groups(H), pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.equal(g['Rae New'], 'suppressed', 'won in August: left alone');
  assert.notEqual(g['Lee Lost'], 'warm', `a lost deal is not a customer: ${pre[idOf(H, 'Lee Lost')].reason}`);
  assert.notEqual(g['Ola Open'], 'suppressed', `an open deal with a forecast date is not a recent customer: ${pre[idOf(H, 'Ola Open')].reason}`);
  assert.equal(g['Eve Else'], 'check', `"—" in the deal column is not a deal: ${pre[idOf(H, 'Eve Else')].reason}`);
});

test('close dates written day-first are read, with no last-contact column', () => {
  const crm = 'Name,Company,Email,Lifecycle Stage,Close Date,Unsubscribed from all email\nRae New,Acme,rae@acme.test,Customer,25/08/2026,false\n';
  const H = setup({ attendees: LIST, crm, settings: { customer_rule: RULE } });
  triage(H);
  assert.equal(groups(H)['Rae New'], 'suppressed');
});

test('"treat as new" is new: no warm note from an old last-contact date; a malformed rule asks instead of letting through', () => {
  const crm = 'Name,Company,Email,Lifecycle Stage,Close Date,Last Contacted,Unsubscribed from all email\nRae New,Acme,rae@acme.test,Customer,2024-08-01,2026-10-01,false\n';
  const H = setup({ attendees: LIST, crm, settings: { customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'cold', other: 'cold' } } });
  triage(H);
  assert.notEqual(groups(H)['Rae New'], 'warm');
  const H2 = setup({ attendees: LIST, crm, settings: { customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'cold', other: 'maybe' } } });
  triage(H2);
  assert.equal(groups(H2)['Rae New'], 'check');
});

test('a bounce with a new address re-opens the approvals; an address another contact has is refused; a future send date is refused', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const rec = (items) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })]);
  assert.match(rec([{ who: 'Ana Berg', what: 'bounced', new_email: 'bo@globex.test' }]).ERROR, /already Bo Li's address/);
  assert.match(rec([{ who: 'Ana Berg', what: 'sent', date: '2027-01-01' }]).ERROR, /hasn't happened yet/);
  rec([{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }]);
  rec([{ who: 'Ana Berg', what: 'bounced', new_email: 'ana.berg@acme.test' }]);
  const { jobs } = todoJobs(H);
  assert.ok(jobs.some((j) => j.id === idOf(H, 'Ana Berg') && j.kind === 'message'), 'todo offers her messages again');
});

test('onboarding: an answer given as the option text still drives the tree', () => {
  const inv = { found: { crm: ['mcp:hubspot'] }, summary: {} };
  const s = { inv, cfg: { company_caps: { mode: 'scale' }, goal: 'x', own_company: 'Me', home_tz: 'Europe/Berlin' }, ev: { slug: 'e', name: 'E', app_name: 'x', start_date: '2026-11-20', end_date: '2026-11-21' }, ans: { inventory_confirmed: true, goal_type: 'selling', meetings_wanted_asked: true, must_meet_asked: true, works_alone: true, accounts_asked: true, dnc_asked: true, app_limit_asked: true, crm_choice: 'yes, use it (connector)' }, slots: 0, list: null };
  // The CRM's own questions come once it's read (the triage phase).
  const ids = planQuestions(s, { batch: 20, phase: 'triage' }).questions.map((q) => q.id);
  assert.ok(ids.includes('customers') && ids.includes('crm_name'), ids.join(','));
});
