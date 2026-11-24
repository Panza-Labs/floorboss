// F2 (spec 0.1.7 §7): a do-not-contact or opt-out hold the user has not lifted refuses a send, a stage, a draft and
// auto-send, never asks. The reviewer's reproduction: approve, make the send list, then her address reaches the
// do-not-contact list and the list is loaded, the send list is not made again, and the send is tried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { contactable, readLedger, fold } from '../lib/ledger.mjs';
import { verifySend } from '../lib/sendcheck.mjs';
import { listChangedSince } from '../lib/autosend/common.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Free,COO,Freeco,bo@freeco.test\n';
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const guard = (H, input, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

function listedThenHeld() {
  const H = setup({ attendees: LIST, settings: { route: ['email', 'email'], sending: { channels: ['email'], followups: 'scheduled' } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const f = join(H.dir, 'derived', 'send-list.json');
  let at = null, list = [];
  for (let d = 0; d <= 28 && !at; d++) {
    cli(H, 'event-outreach', ['send-list', '--event', H.slug], later(d, 60));
    list = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    if (list.some((x) => x.id === ana)) at = later(d, 60);
  }
  assert.ok(at, 'she was on the send list');
  const item = list.find((x) => x.id === ana);
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  const p = join(H.dir, 'work', 'dnc.txt');
  writeFileSync(p, 'ana@acme.test\n');
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', p], at);
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug], at).ERROR);
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at }));
  return { H, ana, item, at };
}

test('F2: the send from a send list made before the hold is refused at the guard, not asked', () => {
  const { H, item, at } = listedThenHeld();
  const g = guard(H, { to: item.to, subject: item.subject, body: item.body }, at);
  const out = g.stdout + g.stderr;
  assert.doesNotMatch(out, /"permissionDecision":"ask"/, out.slice(0, 400));
  assert.match(out, /do-not-contact list: floorboss does not write to them on any channel, and nothing was sent/, out.slice(0, 600));
});

test('F2: verifySend and the ledger refuse her; auto-send\'s yes no longer stands', () => {
  const { H, ana, item, at } = listedThenHeld();
  const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
  const fd = fold(entries, damaged);
  assert.match(contactable(fd, ana), /on your do-not-contact list: floorboss does not write to them on any channel, and nothing was sent/);
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  const v = verifySend({ ...item, touch: item.touch ?? 1 }, { evDir: H.dir, settings: ev.settings, state: {}, entries, folded: fd, nowMs: Date.parse(at), replyCheck: false, lent: false });
  assert.equal(v.ok, false);
  assert.match(v.why, /nothing was sent/);
  const appr = entries.filter((e) => e.type === 'approved' && e.id === ana).pop();
  assert.equal(listChangedSince(entries, appr, ana), true);
});

test('F2: no draft, no stage item and no CRM task for her once the hold is seen', () => {
  const { H, ana, at } = listedThenHeld();
  assert.equal(todoJobs(H, at).jobs.filter((j) => j.id === ana && j.kind === 'message').length, 0);
  cli(H, 'event-outreach', ['stage-list', '--event', H.slug], at);
  const st = join(H.dir, 'derived', 'stage-list.json');
  assert.ok(!(existsSync(st) ? JSON.parse(readFileSync(st, 'utf8')) : []).some((x) => x.id === ana));
  cli(H, 'event-outreach', ['task-list', '--event', H.slug], at);
  const tl = join(H.dir, 'task-list.json');
  assert.ok(!(existsSync(tl) ? JSON.parse(readFileSync(tl, 'utf8')) : []).some((x) => x.id === ana && x.kind === 'send'));
});

test('F2: lifted through the read-back, she may be written to again', () => {
  const { H, ana, at } = listedThenHeld();
  cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', ana], at);
  cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', ana, '--answer', '1', '--said', 'she wrote asking to meet'], at);
  const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
  assert.equal(contactable(fold(entries, damaged), ana), null);
});
