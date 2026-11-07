// Sending: a follow-up's reply check is per person and lasts 90 seconds, checked
// again on the send call; Claude Code asks the user before every send; customers follow the rule set in
// onboarding (how recently the deal closed, and whether this person was on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, groups, ROOT, NOW } from './fixtures/harness.mjs';
import { approvalHash } from '../lib/sendcheck.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const AT = (days, mins = 0) => new Date(Date.parse(NOW) + days * 864e5 + mins * 60000).toISOString();
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

function sentFirsts(sending) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending, touches: 3 } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const it = JSON.parse(readFileSync(list.file, 'utf8'))[0];
  const g = guard(H, { to: it.to, subject: it.subject, body: it.body }, NOW);
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: it.id, touch: 1, message_id: 'm1' }] })]);
  return { H, first: g };
}
function listFollowup(H, now) {
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
  return existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [];
}

test('every send makes Claude Code ask the user, with who it goes to and how it opens', () => {
  const { first } = sentFirsts({ channels: ['email'], followups: 'scheduled', linkedin_ack: false });
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /"Ana Berg" \(c\d+, "ana@acme\.test"\) via email\.send/);
});

test('a follow-up\'s reply check counts for 90 seconds, checked again on the send call itself', () => {
  const { H } = sentFirsts({ channels: ['email'], followups: 'scheduled', linkedin_ack: false });
  const [fu] = listFollowup(H, AT(8));
  assert.equal(fu?.touch, 2, 'the follow-up is listed right after the check');
  const call = { to: fu.to, subject: fu.subject, body: fu.body };
  assert.notEqual(guard(H, call, AT(8, 2)).status, 0, 'two minutes later the check is stale: the guard refuses, however long the batch took');
  const ok = guard(H, call, AT(8, 1));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('no send skips the prompt: a follow-up with a forged approval, or a hand-written test send, still asks', () => {
  // A session can write every file the guard reads (log, draft, contact), so the record
  // can't be the boundary. The prompt is. An "unattended" setting is refused.
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  // As the flow saves it (the follow-ups answer): even then, "unattended" is refused.
  const set = (o) => { process.env.FLOORBOSS_SAVED_BY = 'followups_mode'; try { return cli(H, 'event-context', ['config', '--set', JSON.stringify(o)]); } finally { delete process.env.FLOORBOSS_SAVED_BY; } };
  assert.match(set({ sending: { channels: ['email'], followups: 'scheduled', unattended: true } }).ERROR, /no unattended/);
  const { H: H2 } = sentFirsts({ channels: ['email'], followups: 'scheduled', linkedin_ack: false });
  // Forge the whole approval for a follow-up the user never saw: draft, hash, approval line, reply check.
  const ana = idOf(H2, 'Ana Berg');
  const d = { id: ana, touch: 2, channel: 'email', subject: 'Forged', body: 'Text the user never approved.' };
  writeFileSync(join(H2.dir, 'work', 'drafts', `${ana}-t2.json`), JSON.stringify(d));
  const at = AT(8);
  const hash = approvalHash(d, 'ana@acme.test');
  const lines = [{ at, type: 'drafted', who: 'floorboss', id: ana, touch: 2, kind: 'message', hash }, { at, type: 'critic', who: 'floorboss', id: ana, touch: 2, hash, verdict: 'PASS' },
    { at, type: 'approved', who: 'user', said: 'approve all', id: ana, touch: 2, hash, to: 'ana@acme.test', via: 'email.send' }, { at, type: 'reply_checked', who: 'mailbox', id: ana, source: 'mailbox' }, { at, type: 'status_pasted', who: 'user', said: 'nothing changed', ids: [ana] }];
  writeFileSync(join(H2.dir, 'ledger.jsonl'), readFileSync(join(H2.dir, 'ledger.jsonl'), 'utf8') + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const g = guard(H2, { to: 'ana@acme.test', subject: 'Forged', body: 'Text the user never approved.' }, AT(8, 1));
  if (g.status === 0) assert.match(g.stdout, /"permissionDecision":"ask"/, 'a forged follow-up that passes the record still reaches the user\'s prompt');
  // A test-pending file written by hand, to a stranger: it asks, and the prompt names the address.
  writeFileSync(join(H2.HOME, 'test-pending.json'), JSON.stringify({ task: 'email.send', server: 'gmail', tool: 'send_email', to: 'stranger@else.test', at: NOW }));
  const t = guard(H2, { to: 'stranger@else.test', subject: 'x', body: 'y' }, NOW);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /"permissionDecision":"ask"/);
  assert.match(t.stdout, /TEST email to stranger@else\.test/);
});

const CRM = 'Name,Company,Email,Lifecycle Stage,Close Date,Associated Deal,Unsubscribed from all email\n'
  + 'Rae New,Acme,rae@acme.test,Customer,2026-08-01,Acme renewal,false\n'
  + 'Ola Deal,Globex,ola@globex.test,Customer,2025-06-01,Globex platform,false\n'
  + 'Ike Else,Initech,ike@initech.test,Customer,2025-06-01,,false\n';
const LIST = 'Name,Title,Company,Email\nRae New,COO,Acme,rae@acme.test\nOla Deal,COO,Globex,ola@globex.test\nIke Else,COO,Initech,ike@initech.test\n';

test('customers follow the onboarding rule: closed recently, on the won deal, or someone else there', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' } } });
  triage(H);
  const g = groups(H);
  assert.equal(g['Rae New'], 'suppressed', 'closed in August: left alone');
  assert.equal(g['Ola Deal'], 'warm', 'on the deal, closed over a year ago: a warm note');
  const pre = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8')).pre;
  assert.match(pre[idOf(H, 'Ike Else')].reason, /not on the won deal/, 'someone else at the customer is asked about');
});

test('customers with no rule keep the default: warm', () => {
  const H = setup({ attendees: LIST, crm: CRM });
  triage(H);
  assert.equal(groups(H)['Rae New'], 'warm');
});

test('settings: customer_rule values are checked', () => {
  const H = setup({ attendees: LIST });
  const set = (o) => cli(H, 'event-context', ['config', '--set', JSON.stringify(o)]);
  assert.ok(set({ customer_rule: { recent: 'maybe' } }).ERROR);
  assert.equal(set({ customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' } }).ERROR, undefined);
});

test('someone else at a customer account, with no record of their own, follows the rule\'s "other"', () => {
  const crm = 'Name,Email,Company,Owner,Status,Unsubscribed\nRae New,rae@acme.test,Acme,Sam Rivera,Customer,false\n';
  const att = 'Name,Title,Company,Email\nNia Park,CFO,Acme,nia@acme.test\n';
  const g = (other) => { const H = setup({ attendees: att, crm, settings: { crm_accounts: 'apply', customer_rule: { recent: 'warm', on_deal: 'warm', other } } }); triage(H); return groups(H)['Nia Park']; };
  assert.equal(g('hold'), 'suppressed');
  assert.equal(g('ask'), 'check');
  assert.equal(g('cold'), 'cold', 'treated as new: an ordinary cold contact, not lost');
});
