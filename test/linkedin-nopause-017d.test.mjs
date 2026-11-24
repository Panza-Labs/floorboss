// 0.1.7 section 12, fixes from the second independent review of 0ca723e..8f5efa4.
// A. The guard's staging check holds rule A1 as the send check does: a route that starts on LinkedIn, message 1 never
//    sent, the email after it approved as its follow-up: that text never goes into the drafts folder, on its day or after.
// B. An approval counts as LinkedIn only when it says LinkedIn: an email step approved for email, whose route step is
//    later edited to LinkedIn, is not passed over (the guard and send-list agree) and is never "a skipped LinkedIn message".
// Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, draftApprove, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { linkedInAt, wentBefore, linkedInPassed } from '../lib/route.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't2', user_confirmed: true } };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => {
  const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const hook = (H, tool, input, now) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input, session_id: 's1', tool_use_id: `tu-${Math.random().toString(36).slice(2)}` }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const draftOf = (H, id, t) => JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${t}.json`), 'utf8'));
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);

function world(route) {
  const H = setup({ attendees: PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route, linkedin_messages: true } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, stage_draft: STAGE }, followup_gap: [2] }));
  triage(H);
  const r = draftApprove(H);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  return { H, ana: idOf(H, 'Ana Berg'), jobs: r.jobs };
}

test('A: LinkedIn message 1 never sent: the guard never stages the email written as its follow-up, on its day or after', () => {
  const { H, ana, jobs } = world(['linkedin', 'email']);
  assert.deepEqual(jobs.filter((j) => j.kind === 'message').map((j) => [j.touch, j.planned_due ?? null]), [[1, null], [2, '2026-10-14']]);
  const d = draftOf(H, ana, 2);
  for (const day of ['2026-10-14', '2026-10-20']) {
    const now = at(day);
    writeFileSync(join(H.dir, 'stage-list.json'), JSON.stringify([{ id: ana, touch: 2, to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now }]));
    const g = hook(H, 'mcp__gmail__create_draft', { to: 'ana@acme.test', subject: d.subject || '', body: d.body }, now);
    assert.equal(g.status, 2, `${day}: ${g.stdout} ${g.stderr}`);
    assert.match(g.stderr, /written as a follow-up to a message that never went/, day);
  }
});

test('B: route: an approval with no "where" (an email) is no LinkedIn step, whatever the route says now', () => {
  const li = () => 'linkedin';
  assert.equal(linkedInAt({ touches: { 2: { approved: { via: 'email.send', to: 'ana@acme.test' } } } }, 2, li), false);
  assert.equal(linkedInAt({ touches: { 2: { approved: { to: 'ana@acme.test' } } } }, 2, li), false);
  assert.equal(linkedInAt({ touches: { 2: { approved: { where: 'LinkedIn' } } } }, 2, li), true);
  assert.equal(linkedInAt({ touches: { 2: {} } }, 2, li), true, 'no approval: the route decides');
  const st = { sent: { 1: '2026-10-12' }, touches: { 1: {}, 2: { approved: { via: 'email.send' } }, 3: {} } };
  const route = (t) => ['email', 'linkedin', 'email'][t - 1];
  assert.equal(wentBefore(st, 3, route), 2);
  assert.equal(linkedInPassed({ ...st, sent: { 1: '2026-10-12', 3: '2026-10-16' } }, 2, route), false);
});

test('B: three emails approved, then the route edited to email, LinkedIn, email: step 2 is not passed over, the guard and send-list agree', () => {
  const { H, ana } = world(['email', 'email', 'email']);
  // Message 1 goes on Mon 12.
  nobody(H, NOW);
  const d1 = draftOf(H, ana, 1);
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([{ id: ana, touch: 1, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d1.subject || '', body: d1.body, listed_at: NOW }]));
  assert.equal(hook(H, 'mcp__gmail__send_email', { to: 'ana@acme.test', subject: d1.subject || '', body: d1.body }, NOW).status, 0);
  assert.deepEqual(cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: ana, touch: 1, message_id: 'm1' }] })], NOW).recorded, [`${ana}:1`]);
  // The route in event.json edited by hand.
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify({ ...ev, settings: { ...ev.settings, route: ['email', 'linkedin', 'email'] } }));
  const FRI = at('2026-10-16');
  nobody(H, FRI);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug], FRI);
  assert.ok(!l.ERROR, l.ERROR);
  const listed = existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [];
  assert.ok(!listed.some((x) => x.id === ana && x.touch === 3), `send-list: ${JSON.stringify(listed)}`);
  // The guard on step 3, listed as a session could list it: refused too (step 2 hasn't gone).
  const d3 = draftOf(H, ana, 3);
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([{ id: ana, touch: 3, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d3.subject || '', body: d3.body, listed_at: FRI }]));
  const g = hook(H, 'mcp__gmail__send_email', { to: 'ana@acme.test', subject: d3.subject || '', body: d3.body }, FRI);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /the message before it hasn't gone/);
  const r = cli(H, 'event-outreach', ['render', '--event', H.slug], FRI);
  assert.ok(!r.ERROR, r.ERROR);
  assert.doesNotMatch(readFileSync(join(H.dir, 'outbox.html'), 'utf8'), /LinkedIn message to Ana Berg: skipped|LinkedIn message to Ana Berg was skipped/);
});
