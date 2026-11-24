// Second review of the CRM holds (spec 0.1.7, N1 to N7). Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { contactable, readLedger, fold } from '../lib/ledger.mjs';
import { verifySend } from '../lib/sendcheck.mjs';
import { listChangedSince } from '../lib/autosend/common.mjs';
import { noteStop } from '../skills/crm-triage/scripts/sources.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Free,COO,Freeco,bo@freeco.test\n';
const S = { route: ['email', 'email'], sending: { channels: ['email'], followups: 'scheduled' } };
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const hook = (H, input, now = NOW, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ ...input, ...extra }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const bash = (H, args, extra = {}) =>
  hook(H, { tool_name: 'Bash', tool_input: { command: `node ${join(ROOT, 'skills/crm-triage/scripts/cli.mjs')} ${args}` }, session_id: 's1' }, NOW, extra);
const put = (H, name, text) => { mkdirSync(join(H.dir, 'work'), { recursive: true }); const p = join(H.dir, 'work', name); writeFileSync(p, text); return p; };

// N1: lift-hold --answer 1 asks the user at the guard; a subagent and any other spelling are refused.
test('N1: lifting a hold asks the user at the guard, with the read-back, the person and their words', () => {
  const H = setup({ attendees: LIST, dnc: 'ana@acme.test\n', settings: S });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  const first = bash(H, `lift-hold --event ${H.slug} --id ${id}`);
  assert.equal(first.status, 0);
  assert.doesNotMatch(first.stdout, /"ask"/, 'asking the question needs no prompt');
  cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id]);
  const g = bash(H, `lift-hold --event ${H.slug} --id ${id} --answer 1 --said "yes she asked"`);
  assert.equal(g.status, 0, g.stderr);
  const out = JSON.parse(g.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /floorboss asked: "Ana Berg is on your do-not-contact list \(since Mon 12 Oct\)\. Take Ana Berg off it in floorboss\?"/);
  assert.match(out.permissionDecisionReason, /Their words, as given: "yes she asked"/);
  assert.match(out.permissionDecisionReason, /Allow: they come off the hold in floorboss.*Deny: they stay held/s);
  assert.equal(bash(H, `lift-hold --event ${H.slug} --id ${id} --answer 2`).status, 0, '"no" goes on as before');
  for (const form of ['--answer=1', '--answer " 1"', '--answer 1 --answer 2'])
    assert.equal(bash(H, `lift-hold --event ${H.slug} --id ${id} ${form} --said x`).status, 2, form);
  const sub = bash(H, `lift-hold --event ${H.slug} --id ${id} --answer 1 --said "yes"`, { agent_id: 'sub-1' });
  assert.equal(sub.status, 2, sub.stdout);
  assert.match(sub.stderr, /never a subagent/);
});

// N2: a hold seen at one event refuses the last check at another, with or without that event's triage.
function twoEvents() {
  const E1 = setup({ attendees: LIST, settings: S });
  writeFileSync(join(E1.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(E1);
  const E2 = setup({ home: E1.HOME, attendees: LIST.replace('ana@acme.test', 'ana+expo@acme.test'), event: { slug: 'ev2', name: 'Second Expo' }, settings: S });
  triage(E2);
  draftApprove(E2);
  const ana2 = idOf(E2, 'Ana Berg');
  const f = join(E2.dir, 'derived', 'send-list.json');
  let at = null, list = [];
  for (let d = 0; d <= 28 && !at; d++) {
    cli(E2, 'event-outreach', ['send-list', '--event', E2.slug], later(d, 60));
    list = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    if (list.some((x) => x.id === ana2)) at = later(d, 60);
  }
  assert.ok(at);
  cli(E1, 'crm-triage', ['inputs', '--event', E1.slug, '--kind', 'dnc', '--file', put(E1, 'd.txt', 'ana@acme.test\n')], at);
  assert.ok(!cli(E1, 'crm-triage', ['load', '--event', E1.slug], at).ERROR);
  writeFileSync(join(E1.HOME, 'active.json'), JSON.stringify({ at }));
  return { E1, E2, ana2, item: list.find((x) => x.id === ana2), at };
}
for (const loaded of [false, true])
  test(`N2: a hold seen at the first event refuses the old send list at the second${loaded ? ' (its triage ran)' : ' (its triage never ran)'}`, () => {
    const { E2, ana2, item, at } = twoEvents();
    if (loaded) cli(E2, 'crm-triage', ['load', '--event', E2.slug], at);
    const g = hook(E2, { tool_name: 'mcp__gmail__send_email', tool_input: { to: item.to, subject: item.subject, body: item.body } }, at);
    assert.equal(g.status, 2, g.stdout.slice(0, 300));
    assert.match(g.stderr, /they are on your do-not-contact list: floorboss does not write to them on any channel, and nothing was sent/);
    const { entries, damaged } = readLedger(join(E2.dir, 'ledger.jsonl'));
    const fd = fold(entries, damaged);
    assert.match(contactable(fd, ana2) || '', /do-not-contact list/);
    const ev = JSON.parse(readFileSync(join(E2.dir, 'event.json'), 'utf8'));
    assert.equal(verifySend({ ...item, touch: item.touch ?? 1 }, { evDir: E2.dir, settings: ev.settings, state: {}, entries, folded: fd, nowMs: Date.parse(at), replyCheck: false, lent: false }).ok, false);
    assert.equal(listChangedSince(entries, entries.filter((e) => e.type === 'approved' && e.id === ana2).pop(), ana2), true);
    assert.ok(!readFileSync(join(E2.dir, 'ledger.jsonl'), 'utf8').includes('"carried"'), 'never written to the second event');
  });
test('N2: a lift at the first event lifts it at the second', () => {
  const { E1, E2, ana2, at } = twoEvents();
  const a1 = idOf(E1, 'Ana Berg');
  cli(E1, 'crm-triage', ['lift-hold', '--event', E1.slug, '--id', a1], at);
  cli(E1, 'crm-triage', ['lift-hold', '--event', E1.slug, '--id', a1, '--answer', '1', '--said', 'she asked to meet'], at);
  const { entries, damaged } = readLedger(join(E2.dir, 'ledger.jsonl'));
  assert.equal(contactable(fold(entries, damaged), ana2), null);
});

// N3: these notes are clear stops.
test('N3: opt out, remove from list and data erasure requests are clear stops', () => {
  for (const n of ['opt out', 'opt-out', 'remove from list', 'remove from your list', 'GDPR erase request', 'erase my data', 'delete my data', 'remove me from your mailing list']) assert.equal(noteStop(n), 'clear', n);
});

// N4: every by-name path that would draft someone in a lost-deal wait asks first.
const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted\n';
const lostWorld = () => {
  const H = setup({ attendees: LIST, crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,2026-08-10\n', settings: { status_map: { 'Closed Lost': 'lost' }, rejected_months: 6, route: ['email', 'email'] } });
  triage(H);
  return H;
};
const drafted = (H) => { triage(H); return todoJobs(H).jobs.some((j) => j.id === idOf(H, 'Ana Berg') && j.kind === 'message'); };
const ASK = "Ana's deal was lost 2 months ago; your wait is 6 months. Write to them anyway? 1. Yes. 2. No.";
for (const [how, say] of [
  ['decide', (H) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', idOf(H, 'Ana Berg'), '--group', 'reach', '--because', 'go'])],
  ['decide-batch by id', (H) => cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${idOf(H, 'Ana Berg')} reach because go`])]
])
  for (const ans of ['1', '2'])
    test(`N4: ${how} for a lost deal asks the read-back first; ${ans === '1' ? 'yes drafts her' : 'no keeps her held'}`, () => {
      const H = lostWorld();
      const r = say(H);
      assert.equal(r.say_to_user, ASK, JSON.stringify(r).slice(0, 300));
      assert.ok(!/"type":"decide"/.test(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')), 'nothing saved before the answer');
      const a = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--lost-answer', ans]);
      assert.ok(!a.ERROR, a.ERROR);
      assert.equal(drafted(H), ans === '1');
    });

// N5: the task check fails closed.
test('N5: a send task whose event record cannot be read, or that names nobody, is refused', async () => {
  const H = setup({ attendees: LIST, settings: S });
  triage(H);
  const led = join(H.dir, 'ledger.jsonl');
  chmodSync(led, 0o000);
  try {
    const mod = await import('../hooks/guard/check.mjs');
    const why = mod.holdOneRefusalForTest?.(H.HOME, H.slug, 'c001', 'send');
    assert.match(why || '', /floorboss can't read that event's record, so it can't check this task\. No task was created\./);
    assert.doesNotMatch(why, /EACCES/);
    assert.match(mod.holdOneRefusalForTest(H.HOME, H.slug, null, 'send'), /names nobody on the list/);
    assert.match(mod.holdOneRefusalForTest(H.HOME, '../x', 'c001', 'send'), /names no event/);
  } finally {
    chmodSync(led, 0o644);
  }
});

// N6/N7: one definition; the words.
test('N7: the opt-out read-back and a kept hold say the day as a person writes it', () => {
  const H = setup({ attendees: LIST, crm: 'Name,Email,Company,Owner,Status,Unsubscribed\nAna Berg,ana@acme.test,Acme,Sam Rivera,Lead,true\n', settings: { status_map: { Lead: 'ignore' }, route: ['email', 'email'] } });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  assert.equal(cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id]).ask, 'Ana Berg opted out in your CRM (Mon 12 Oct). Take that hold off in floorboss?');
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm', '--file', put(H, 'c2.csv', 'Name,Email,Company,Owner,Status\nAna Berg,ana@acme.test,Acme,Sam Rivera,Lead\n')]);
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm']);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const says = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[id].says;
  assert.match(says, /seen Mon 12 Oct; no longer in the file, still held/);
  assert.doesNotMatch(says, /\d{4}-\d{2}-\d{2}/);
});
test('N6: "said no to contact on the event\'s list" is hold 1 in the ledger and in the triage alike', async () => {
  const { isHoldOne } = await import('../lib/ledger.mjs');
  const { isNeverHold } = await import('../skills/crm-triage/scripts/resolve.mjs');
  const h = { rung: 'do_not_contact', group: 'skip', says: "said no to contact on the event's list" };
  assert.equal(isHoldOne(h), true);
  assert.equal(isNeverHold(h), true);
});

// P1: each of --event, --id, --answer and --said once, in the guard and in the command; the prompt names person and event.
test('P1: a repeated --event, --id, --answer or --said is refused by the guard and by the command', () => {
  const H = setup({ attendees: LIST, dnc: 'ana@acme.test\n', settings: S });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id]);
  for (const extra of [`--event ev2 --event ${H.slug} --id ${id} --answer 1 --said "she asked"`, `--event ${H.slug} --id c002 --id ${id} --answer 1 --said x`, `--event ${H.slug} --id ${id} --answer 1 --said a --said b`]) {
    const g = bash(H, `lift-hold ${extra}`);
    assert.equal(g.status, 2, extra);
    assert.match(g.stderr, /takes --\w+ once/);
  }
  for (const args of [['--event', 'ev2', '--event', H.slug, '--id', id, '--answer', '1', '--said', 'x'], ['--event', H.slug, '--id', id, '--answer', '1', '--said', 'a', '--said', 'b']])
    assert.match(cli(H, 'crm-triage', ['lift-hold', ...args]).ERROR || '', /takes --\w+ once/);
  const g = bash(H, `lift-hold --event ${H.slug} --id ${id} --answer 1 --said "she asked"`);
  assert.match(JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason, /^floorboss: take "Ana Berg" off the hold at "Test Expo"\?/);
});

// P4: the task check fails closed with no ledger, and on a damaged line.
test('P4: a send task for an event with no record, or with a damaged line, is refused', async () => {
  const mod = await import('../hooks/guard/check.mjs');
  const H = setup({ attendees: LIST, settings: S });
  assert.match(mod.holdOneRefusalForTest(H.HOME, H.slug, 'c001', 'send'), /this event has no record yet/);
  triage(H);
  writeFileSync(join(H.dir, 'ledger.jsonl'), readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8') + '{"type":"hold_seen","id":"c001","rung":\n');
  assert.match(mod.holdOneRefusalForTest(H.HOME, H.slug, 'c001', 'send') || '', /damaged line.*No task was created/);
});
