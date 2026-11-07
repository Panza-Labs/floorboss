// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Third verify after round 7: a dropped or revised touch never sends its old approval, a text the critic
// failed can't be skipped past the critic, a confirmation carries no link, and the "failed twice" hold is
// counted in the ledger, not in a working copy Claude can write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, todoJobs, fitAll, draftApprove, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { confirmationLinks } from '../skills/event-outreach/scripts/checks.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const guard = (H, input, now = NOW) => {
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};
const listed = (H, now, extra = []) => { const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug, ...extra], now); return l.ERROR ? [] : JSON.parse(readFileSync(l.file, 'utf8')); };
const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-19', '2026-10-21'];

// Two touches for Ana, both passed by the critic, sending on: the gate answer decides what may go.
function twoTouches(answer, verdicts = {}) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\n', settings: { touches: 2, sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const { t, jobs } = todoJobs(H);
  for (const j of jobs.filter((x) => x.kind === 'message')) {
    const times = j.slot_labels?.length ? `Could you do ${j.slot_labels.join(' or ')}?` : 'Could we find 30 minutes at Test Expo?';
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi Ana, message ${j.touch} about Test Expo. ${times}\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x' })]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', verdicts[j.touch] || 'PASS']);
  }
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', answer(idOf(H, 'Ana Berg'))]);
  return { H, g, ana: idOf(H, 'Ana Berg') };
}
const sendFirst = (H, id) => {
  const items = listed(H, NOW);
  assert.deepEqual(items.map((x) => `${x.id}:${x.touch}`), [`${id}:1`], 'the first message goes');
  assert.match(guard(H, { to: items[0].to, subject: items[0].subject, body: items[0].body }).out, /"ask"/);
  const rf = join(H.dir, 'work', 'r.json'); writeFileSync(rf, JSON.stringify({ sends: [{ id, touch: 1, message_id: 'm1' }] }));
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', rf]);
};

test('1: a follow-up dropped at the gate is never listed or let through, and the first message still goes', () => {
  const { H, g, ana } = twoTouches((id) => `approve all, drop ${id}:2`);
  assert.equal(g.approved, 1, 'the dropped follow-up isn\'t approved');
  assert.equal(g.dropped, 1);
  sendFirst(H, ana);
  for (const day of DAYS) assert.deepEqual(listed(H, `${day}T08:00:00Z`, ['--no-reply-check', 'nobody replied, I checked']), [], day);
});

test('2: a follow-up sent back for a rewrite never sends its old approved text', () => {
  const { H, ana } = twoTouches(() => 'approve all');
  const ff = join(H.dir, 'work', 'fb.txt'); writeFileSync(ff, 'do not mention the price');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:2`, '--feedback-file', ff]);
  // The sequence isn't whole any more: the first message waits for the rewritten follow-up's approval.
  assert.deepEqual(listed(H, NOW), []);
  for (const day of DAYS) assert.deepEqual(listed(H, `${day}T08:00:00Z`, ['--no-reply-check', 'nobody replied, I checked']), [], day);
});

test('3: a text the critic failed can\'t be skipped past it after a revise, and "approve all" leaves it out', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,VP Ops,Globex,bo@globex.example\n' });
  fitAll(H, cli(H, 'crm-triage', ['load', '--event', H.slug]));
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  const r = todoJobs(H);
  const bo = idOf(H, 'Bo Li');
  for (const j of r.jobs) {
    const d = (({ body, structure, fact_source, insight }) => ({ subject: 'Test Expo', body, brief: 'x', structure, fact_source, ...(insight ? { insight } : {}) }))(draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] }));
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify(d)]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', j.id === bo ? 'FAIL: invents a customer' : 'PASS']);
  }
  const ff = join(H.dir, 'work', 'fb.txt'); writeFileSync(ff, 'shorter please');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', bo, '--feedback-file', ff]);
  const s = cli(H, 'event-outreach', ['skip-review', '--event', H.slug, '--all', '--said', 'the critic is down, skip the review']);
  assert.deepEqual(s.skipped_review, []);
  assert.deepEqual(s.not_skipped, [`${bo}:1`]);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(g.not_ready.some((x) => x.id === bo), JSON.stringify(g));
  assert.ok(!readFileSync(join(H.dir, 'outbox.html'), 'utf8').includes('Bo Li'));
});

test('4: a confirmation with a link fails its checks and is never approved; the prompt calls it a confirmation', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\n', settings: { touches: 1, meeting_place: 'North Lounge', sending: { channels: ['email'], followups: 'scheduled', linkedin_ack: false } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H); draftApprove(H);
  const it = listed(H, NOW)[0];
  guard(H, { to: it.to, subject: it.subject, body: it.body });
  const rf = join(H.dir, 'work', 'r.json'); writeFileSync(rf, JSON.stringify({ sends: [{ id: it.id, touch: 1, message_id: 'm1' }] }));
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', rf]);
  const bf = join(H.dir, 'work', 'b.json'); writeFileSync(bf, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Ana booked Tuesday 10:00' }] }));
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', bf]);
  const cj = todoJobs(H).jobs.find((j) => j.touch === 0);
  const save = (body) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', cj.id, '--touch', '0', '--json', JSON.stringify({ subject: 'Re: Test Expo', body })]);
  for (const link of ['https://evil.example/pay', 'www.evil.example', 'pay at evil.example now']) {
    const s = save(`Hi Ana, confirming ${cj.slot_labels.join('')} at the North Lounge. Please see ${link} first.\n\nBest, Sam`);
    assert.ok(s.checks.some((x) => /carries no link/.test(x)), link);
  }
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.equal(g.approved, 0);
  assert.match(cli(H, 'event-outreach', ['critic-input', '--event', H.slug, '--id', cj.id, '--touch', '0']).ERROR || '', /Confirmations don't go to the critic/);
  // A plain confirmation passes and its send prompt says what it is.
  save(`Hi Ana, thanks, see you ${cj.slot_labels.join('')} at the North Lounge.\n\nBest, Sam`);
  cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  const c = listed(H, NOW).find((x) => x.touch === 0);
  assert.ok(c);
  assert.match(guard(H, { to: c.to, subject: c.subject, body: c.body }).out, /the meeting confirmation/);
});

test('5: the "failed twice, held" count is the ledger\'s: zeroing it in the working copy changes nothing', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\nBo Li,COO,Globex,bo@globex.example\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const save = (j) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body: `Hi ${j.contact.name.split(' ')[0]}, we're both at Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`, brief: 'x' })]);
  const verdict = (j, text) => cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', text]);
  const [bad] = jobs;
  save(bad); verdict(bad, 'FAIL: could go to anyone'); save(bad); verdict(bad, 'FAIL: still could go to anyone');
  const f = bad.draft_file;
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), critic_rewrites: 0 }));
  assert.ok(todoJobs(H).jobs.find((j) => j.id === bad.id).critic_held);
});

test('6: a rewrite saved back as the very text that failed counts as a second fail, so it is held', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.example\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const [j] = jobs;
  const body = `Hi Ana, we're both at Test Expo. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`;
  const save = () => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x' })]);
  save(); cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', '1', '--text', 'FAIL: could go to anyone']); save();
  assert.ok(todoJobs(H).jobs.find((x) => x.id === j.id).critic_held);
});

test('7: the confirmation link check reads links loosely and lets the user\'s own address and a phone number through', () => {
  const S = { own_domains: ['lanecraft.example'], own_email: 'sam@lanecraft.example' };
  for (const x of ['see evil.de/pay', 'evil.shop', 'goo.gl/abc', 'http://10.0.0.1/x', 'hxxps://evil[.]shop', 'evil dot com', 'billing@evil.example', 'mailto:x@pay.example', '//evil.shop/x', 'evil\uff0eshop', '\u0435vil.com', 'site.co.uk'])
    assert.ok(confirmationLinks(x, S).length, x);
  for (const x of ['reach me at sam@lanecraft.example', 'see lanecraft.example/day', 'call me on +1 202 555 0147', 'at 9.30 or 13.00', 'Mr. Smith, e.g. the lounge', 'Best, Sam'])
    assert.deepEqual(confirmationLinks(x, S), [], x);
});

test('8: "approve all, drop" of a failed follow-up approves the first message in the same answer', () => {
  const { g } = twoTouches((id) => `approve all, drop ${id}:2`, { 2: 'FAIL: repeats the first message' });
  assert.equal(g.approved, 1, JSON.stringify(g.not_ready));
  assert.equal(g.dropped, 1);
});
