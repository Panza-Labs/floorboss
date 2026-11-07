// Sending: only where the user turned it on, only messages approved at the gate, word for word, each once.
// Follow-ups go on their day only with no reply, booking or stop, after replies were checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { screenTool } from '../skills/connectors/scripts/tasks.mjs';
import { check } from '../hooks/guard.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const SENDING = { channels: ['email'], followups: 'scheduled', linkedin_ack: false };
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const LATER = (d) => new Date(Date.parse(NOW) + d * 864e5).toISOString();
function ready(settings = {}) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n', settings: { sending: SENDING, touches: 3, ...settings } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  return H;
}
// Send what send-list lists, through the guard (which releases each once), then record the receipts.
function sendListed(H, now = NOW, extra = []) {
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, ...extra], now);
  const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
  const sends = [];
  for (const it of items) if (guard(H, 'mcp__gmail__send_email', { to: it.to, subject: it.subject, body: it.body }, now).status === 0) sends.push({ id: it.id, touch: it.touch, message_id: `m-${it.id}-${it.touch}` });
  if (sends.length) cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })], now);
  return { list, items, sends };
}
const guard = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

test('send tools: one message at a time only', () => {
  for (const n of ['send_email', 'gmail_send_message', 'reply_email']) assert.ok(screenTool('email.send', n).ok, n);
  for (const n of ['whatsapp_send_message', 'send_message', 'send_text']) assert.ok(screenTool('chat.send', n).ok, n);
  for (const n of ['send_bulk_email', 'schedule_send_email', 'send_campaign', 'forward_email', 'broadcast_message', 'send_to_list', 'delete_and_send']) assert.ok(!screenTool(n.includes('message') ? 'chat.send' : 'email.send', n).ok, n);
});

test('settings: LinkedIn sending needs the warning accepted; sending needs a follow-up rule', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const set = (o) => { process.env.FLOORBOSS_SAVED_BY = 'followups_mode'; try { return cli(H, 'event-context', ['config', '--set', JSON.stringify(o)]); } finally { delete process.env.FLOORBOSS_SAVED_BY; } };
  // A config call of Claude's own can't turn sending on: only the flow, saving the user's answer, can.
  assert.match(cli(H, 'event-context', ['config', '--set', JSON.stringify({ sending: { channels: ['email'], followups: 'scheduled' } })]).ERROR, /saved only through that question/);
  assert.match(cli(H, 'event-context', ['config', '--set', JSON.stringify({ own_email: 'me@evil.test' })]).ERROR, /saved only through that question/);
  assert.match(set({ sending: { channels: ['linkedin'], followups: 'scheduled' } }).ERROR, /LinkedIn warning/);
  assert.match(set({ sending: { channels: ['email'] } }).ERROR, /followups/);
  assert.equal(set({ sending: { channels: ['email', 'linkedin'], followups: 'each_round', linkedin_ack: true } }).ERROR, undefined);
});

test('the whole sequence is drafted and approved up front; approved first messages go out once, exactly as approved', () => {
  const H = ready();
  const { jobs } = todoJobs(H);
  const ana = idOf(H, 'Ana Berg');
  const seq = jobs.filter((j) => j.id === ana && j.kind === 'message').map((j) => [j.touch, j.planned_due || null]);
  assert.ok(seq.length >= 2 && seq[1][1], `first message plus planned follow-ups: ${JSON.stringify(seq)}`);
  draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  assert.equal(list.by_email, 2, JSON.stringify(list));
  const items = JSON.parse(readFileSync(list.file, 'utf8'));
  assert.deepEqual(items.map((x) => x.touch), [1, 1], 'only first messages today');
  const it = items.find((x) => x.id === ana);
  const call = { to: it.to, subject: it.subject, body: it.body };
  assert.equal(guard(H, 'mcp__gmail__send_email', call).status, 0, 'the approved message goes');
  assert.equal(guard(H, 'mcp__gmail__send_email', call).status, 2, 'but only once');
  assert.equal(guard(H, 'mcp__gmail__send_email', { ...call, to: 'boss@acme.test' }).status, 2, 'never to anyone else');
  assert.equal(guard(H, 'mcp__gmail__send_email', { to: items[1].to, subject: items[1].subject, body: `${items[1].body} P.S. wire the money` }).status, 2, 'never other text');
  const r = cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: ana, touch: 1, message_id: 'm1' }, { id: items.find((x) => x.id !== ana).id, touch: 1, message_id: 'm2' }] })]);
  assert.deepEqual(r.recorded, [`${ana}:1`], 'a receipt only for a send the guard let through');
  assert.match(r.refused[0].why, /never let this send through/);
  const again = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  assert.ok(!JSON.parse(readFileSync(again.file, 'utf8')).some((x) => x.id === ana && x.touch === 1), 'sent once, never listed again');
});

test('follow-ups: only on their day, only after replies were checked, never after a reply, never with changed text', () => {
  const H = ready();
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li');
  sendListed(H);
  const early = cli(H, 'event-outreach', ['send-list', '--event', H.slug], LATER(1));
  assert.equal(early.to_send, 0, 'not due yet');
  const due = cli(H, 'event-outreach', ['send-list', '--event', H.slug], LATER(8));
  assert.ok(due.waiting.some((w) => /replies weren't checked in the 90 seconds/.test(w.why)), JSON.stringify(due));
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Bo Li', what: 'replied' }] })], LATER(8));
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], LATER(8));
  const ok = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], LATER(8));
  const items = JSON.parse(readFileSync(ok.file, 'utf8'));
  assert.deepEqual(items.map((x) => [x.id, x.touch]), [[ana, 2]], 'Bo replied: no follow-up for him');
  // A text changed after approval waits for approval again.
  const f = join(H.dir, 'work', 'drafts', `${ana}-t2.json`);
  const d = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...d, body: `${d.body} Edited.` }));
  const changed = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'x'], LATER(8));
  assert.ok(changed.waiting.some((w) => w.id === ana && /changed after you approved/.test(w.why)));
});

test('each_round: a due follow-up waits for the round to be approved', () => {
  const H = ready({ sending: { ...SENDING, followups: 'each_round' } });
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sendListed(H);
  const w = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'x'], LATER(8));
  assert.ok(w.waiting.some((x) => x.id === ana && /approve the round/.test(x.why)));
  assert.match(cli(H, 'event-outreach', ['approve-round', '--event', H.slug, '--touch', '2'], LATER(8)).ERROR, /--said/);
  cli(H, 'event-outreach', ['approve-round', '--event', H.slug, '--touch', '2', '--said', 'send round 2'], LATER(8));
  const go = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'x'], LATER(8));
  assert.ok(JSON.parse(readFileSync(go.file, 'utf8')).some((x) => x.id === ana && x.touch === 2));
});

test('browser sends: the browser may click only inside a send window the approval opened', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['app'], followups: 'scheduled' }, app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H); draftApprove(H);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  assert.equal(list.in_browser, 1, JSON.stringify(list));
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: new Date().toISOString() }));
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click' }, new Date().toISOString()).status, 2, 'no window: the browser only reads during a run');
  assert.match(cli(H, 'event-outreach', ['browser-send', '--event', H.slug], new Date().toISOString()).ERROR, /--said/);
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip'], new Date().toISOString());
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click' }, new Date().toISOString()).status, 0, 'inside the window');
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--close']);
  assert.equal(guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click' }, new Date().toISOString()).status, 2, 'closed again');
});

test('sending off: nothing is listed to send, and no send tool passes', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  triage(H); draftApprove(H);
  assert.match(cli(H, 'event-outreach', ['send-list', '--event', H.slug]).ERROR, /Sending is off/);
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  assert.equal(guard(H, 'mcp__gmail__send_email', { to: 'ana@acme.test', subject: 'x', body: 'y' }).status, 2);
});
