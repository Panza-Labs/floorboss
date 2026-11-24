// The findings of the 9 Nov security audit (security-audit skill, run-5) and the bugs found beside it, each as the
// case that went wrong then and must not now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { check } from '../hooks/guard.mjs';
import { parseRoute, sentKind, plannedStep } from '../lib/route.mjs';
import { lastReplyCheck, uncheckedChannels, verifySend, eventRecord } from '../lib/sendcheck.mjs';
import { namesToIds } from '../lib/names.mjs';
import { readLedger, append, fold, legacyState } from '../lib/ledger.mjs';
import { otherChannelStep, rewrittenSince, askedChannels, appOutcomeTarget, appStep } from '../skills/flow/scripts/steps.mjs';
import { loadEvent } from '../lib/event.mjs';
import { summarize } from '../skills/event-context/scripts/scan.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { draftFor } from './sims/lib/driver.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const CHAT = { server: 'wa', tool: 'send_message', args: { to: '{to}', body: '{body}' }, reading: 'x', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const NOTES = { app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false };
const guard = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const post = (H, tool, input, now = NOW) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const later = (d, min = 0) => new Date(Date.parse(NOW) + d * 864e5 + min * 6e4).toISOString();
const log = (H) => join(H.dir, 'ledger.jsonl');
const add = (H, e, now = NOW) => append(log(H), { who: 'user', said: 'noted', ...e }, new Date(now));
const entries = (H) => readLedger(log(H)).entries;
const state = (H) => legacyState(fold(entries(H)));
const put = (H, name, data) => { const f = join(H.HOME, 'work', name); mkdirSync(join(H.HOME, 'work'), { recursive: true }); writeFileSync(f, JSON.stringify(data)); return f; };
const record = (H, items, now = NOW) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', put(H, 'rec.json', { items })], now);
const listAt = (H, now, extra = []) => cli(H, 'event-outreach', ['send-list', '--event', H.slug, ...extra], now);
const browserList = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'browser-send-list.json'), 'utf8'));
const emailList = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'send-list.json'), 'utf8'));
const sentMark = (H, id, touch, extra = {}, now = NOW) => add(H, { type: 'sent', id, touch, date: now.slice(0, 10), via: 'floorboss', who: 'floorboss', ...extra }, now);
// A window already opened, its first call allowed.
function openWin(H, now = NOW, list = true) {
  if (list) listAt(H, now);
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: now }));
  cli(H, 'event-outreach', ['browser-send', '--event', H.slug, '--said', 'go ahead, send them in Grip'], now);
  guard(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 1] }, now);
  post(H, 'mcp__claude-in-chrome__computer', { action: 'left_click', coordinate: [1, 1] }, now);
}
const type = (H, text, now = NOW) => guard(H, 'mcp__claude-in-chrome__computer', { action: 'type', text }, now);

const APP_ONLY = { sending: { channels: ['app'], followups: 'scheduled' }, ...NOTES };
function appNote() {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: APP_ONLY });
  triage(H);
  draftApprove(H);
  return H;
}

test('a browser note is typed once: a repeat is refused until the user clears it, then asks and says so', () => {
  const H = appNote();
  openWin(H);
  const [item] = browserList(H);
  const first = type(H, item.body);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"permissionDecision":"ask"/);
  assert.ok(entries(H).some((e) => e.type === 'send_released' && e.id === item.id && e.via === 'browser' && e.where === 'Grip'), 'the release names where it goes');
  const repeat = type(H, item.body);
  assert.equal(repeat.status, 2, 'a repeat is refused');
  assert.match(repeat.stderr, /already let through once/);
  listAt(H, NOW, ['--resend', `${item.id}:${item.touch}`, '--said', 'it never went, send it again']);
  const again = type(H, item.body);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already let this message through once/);
});

test('a note whose receipt came back is refused at typing', () => {
  const H = appNote();
  openWin(H);
  const [item] = browserList(H);
  const r = cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', put(H, 'r.json', { sends: [{ id: item.id, touch: item.touch }] })]);
  assert.deepEqual(r.recorded, [`${item.id}:${item.touch}`], JSON.stringify(r));
  assert.equal(type(H, item.body).status, 2);
});

test('a note to someone who said stop after the window opened is refused at typing', () => {
  const H = appNote();
  openWin(H);
  const [item] = browserList(H);
  add(H, { type: 'stop', id: item.id, who: 'user', said: 'she asked me to stop' });
  const t = type(H, item.body);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /stop/i);
});

test('a note for someone the window was not opened for is refused at typing', () => {
  const H = appNote();
  openWin(H);
  const [item] = browserList(H);
  const w = JSON.parse(readFileSync(join(H.HOME, 'browser-send.json'), 'utf8'));
  writeFileSync(join(H.HOME, 'browser-send.json'), JSON.stringify({ ...w, ids: [] }));
  const t = type(H, item.body);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /wasn't opened for that note/);
});

test('an app note typed late in its window is not held to the 90-second reply check', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: { ...APP_ONLY, route: ['app', 'app'] } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'Grip', source: 'user' });
  const L = later(9);
  const list = listAt(H, L, ['--no-reply-check', 'nobody replied']);
  assert.equal(list.in_browser, 1, JSON.stringify(list));
  const [item] = browserList(H);
  assert.equal(item.touch, 2);
  openWin(H, L, false);
  assert.equal(verifySend(item, { evDir: H.dir, settings: { sending: APP_ONLY.sending }, ...eventRecord(H.dir), nowMs: Date.parse(L) + 10 * 60000 }).ok, false, 'the send check itself would refuse it by now');
  const late = type(H, item.body, later(9, 10));
  assert.equal(late.status, 0, late.stderr);
  assert.match(late.stdout, /permissionDecision/);
});

test('a window for app notes opens only the app; LinkedIn needs a LinkedIn note and its warning accepted; the prompt names the platform', () => {
  const app = appNote();
  openWin(app);
  const nav = (H, url) => guard(H, 'mcp__claude-in-chrome__navigate', { url });
  const li = nav(app, 'https://www.linkedin.com/in/someone');
  assert.equal(li.status, 2, 'an app-only window refuses LinkedIn');
  const inbox = nav(app, 'https://www.linkedin.com/messaging/thread/1');
  assert.equal(inbox.status, 2, 'the LinkedIn inbox too');
  assert.equal(nav(app, 'https://app.grip.events/people/ana').status, 0, 'and opens the app');
  const [item] = browserList(app);
  assert.match(type(app, item.body).stdout, /in \\"Grip/, 'the note prompt names the platform');

  const S = { sending: { channels: ['linkedin'], followups: 'scheduled', linkedin_ack: true }, route: ['linkedin', 'linkedin'], ...NOTES };
  const lin = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(lin);
  draftApprove(lin);
  listAt(lin, NOW);
  // 0.1.7: floorboss never sends on LinkedIn, so a LinkedIn step is never on the browser list.
  assert.ok(!existsSync(join(lin.dir, 'derived', 'browser-send-list.json')) || !browserList(lin).some((x) => x.where === 'LinkedIn'));
  // With an old linkedin_ack still in the settings, no send window opens for LinkedIn, and the guard refuses typing in
  // the browser during the run.
  writeFileSync(join(lin.HOME, 'active.json'), JSON.stringify({ at: NOW }));
  assert.match(cli(lin, 'event-outreach', ['browser-send', '--event', lin.slug, '--said', 'go ahead, send them on LinkedIn']).ERROR || '', /Nothing approved to send in the browser/);
  assert.equal(type(lin, 'Hi Ana').status, 2, 'nothing is typed on LinkedIn');
});

test('beside approve all, a name left unresolved holds the approval: nothing is approved', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Lind,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nBo Ek,CTO,Initech,boe@initech.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  for (const a of ['approve all but Lind', 'approve all, not Bo', 'approve all except Ana Lind, Bo']) {
    const r = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', a]);
    assert.match(r.ERROR || '', /Nothing was approved|can't be read/, `${a}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.equal(entries(H).filter((e) => e.type === 'approved').length, 0);
  // Run 6, round 3: a remark beside "approve all" is read back first, and kept as a comment on the user's yes.
  assert.equal(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all, the critic is being picky']).pending, true);
  const r = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'yes']);
  assert.equal(r.approved, 3, JSON.stringify(r).slice(0, 300));
  assert.deepEqual(r.read_as_comment, ['the critic is being picky']);
});

test('an attendee named after a connecting word never rewrites the answer into an approval', () => {
  const people = (more) => [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }, ...more];
  assert.equal(namesToIds('approve ana, not bo', people([{ id: 'c003', name: 'Not Sure' }])), 'approve c001, not bo');
  assert.equal(namesToIds('approve ana but bo', people([{ id: 'c003', name: 'But Ter' }])), 'approve ana but bo');
  // Run 6: the row "Ana And Bo" goes by id only, but "Ana" and "Bo" may still mean it, so both are left for the gate to ask.
  assert.equal(namesToIds('approve ana and bo', people([{ id: 'c003', name: 'Ana And Bo' }])), 'approve ana and bo', 'the row "Ana And Bo" makes both names shared');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nNot Sure,CFO,Initech,not@initech.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  const r = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve Ana, not Bo']);
  assert.ok(!(r.approved > 0), JSON.stringify(r).slice(0, 300));
  assert.equal(entries(H).filter((e) => e.type === 'approved').length, 0, 'none of the three is approved');
});

test('a sent message with no label counts on the channel it was meant for', () => {
  assert.equal(sentKind({ via: 'floorboss' }, { step: 'app' }), 'app');
  assert.equal(sentKind({ via: 'crm task' }, { step: 'linkedin' }), 'linkedin');
  assert.equal(sentKind({ via: 'floorboss' }), 'email', 'with nothing known it stays email');
  assert.equal(sentKind({ channel: 'Wizzlechat' }, { appName: 'Wizzlechat' }), 'app', 'an app named with chat is the app');
  assert.equal(sentKind({ channel: 'Wizzlechat', via: 'floorboss' }), null, 'without the app name it is read as a chat');
  assert.equal(sentKind({ source: 'linkedin' }), 'linkedin', 'an inbox read says where it was found');
  assert.equal(sentKind({ source: 'mailbox' }, { step: 'app' }), 'email', 'found in the mailbox it went by email');
  assert.equal(sentKind({ channel: 'LinkedIn' }, { step: 'app' }), 'linkedin', 'what was recorded beats the plan');
  assert.equal(plannedStep({ approved: { where: 'LinkedIn' } }, 'app'), 'linkedin', 'where it was approved beats the route');
  assert.equal(plannedStep({}, 'app'), 'app');
  const email = { id: 'c001', touch: 3, via: 'email.send' };
  const person = { touches: { 1: { sent: { via: 'floorboss' }, sent_at: later(-3) }, 2: { sent: { via: 'floorboss' }, sent_at: later(-2) } } };
  assert.deepEqual(uncheckedChannels(email, person, [], {}, Date.parse(NOW), { stepAt: (t) => (t === 2 ? 'app' : null) }), ['app']);
});

test('moving the route after approval means approving again: an app note is not typed on LinkedIn unapproved', () => {
  const S = { sending: { channels: ['app', 'linkedin'], followups: 'scheduled', linkedin_ack: true }, route: ['app', 'linkedin'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  assert.equal(listAt(H, NOW).in_browser, 1);
  assert.equal(browserList(H)[0].where, 'Grip');
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.route = ['linkedin', 'app'];
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  const list = listAt(H, NOW);
  assert.equal(list.in_browser, 0, JSON.stringify(list));
  assert.match(list.waiting.find((w) => w.id === ana && w.touch === 1).why, /you send this one yourself on LinkedIn/);
  const { jobs } = todoJobs(H);
  assert.ok(jobs.some((j) => j.id === ana && j.touch === 1), 'it comes back to be approved again');
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${ana}`]);
  assert.ok(g.approved >= 1, JSON.stringify(g));
  const relist = listAt(H, NOW);
  assert.equal(relist.in_browser, 0, JSON.stringify(relist));
});

test('the own-channel check reads that inbox: LinkedIn being read does not clear an app follow-up', () => {
  const S = { sending: { channels: ['app', 'linkedin'], followups: 'scheduled', linkedin_ack: true }, route: ['app', 'linkedin', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'Grip' }, later(-1));
  sentMark(H, ana, 2, { channel: 'LinkedIn' });
  const L = later(15);
  add(H, { type: 'reply_checked', id: ana, source: 'linkedin', who: 'floorboss' }, L);
  const list = listAt(H, L);
  assert.equal(list.in_browser, 0, JSON.stringify(list));
  assert.match(list.waiting.find((w) => w.touch === 3)?.why || '', /weren't checked in the 90 seconds/);
  add(H, { type: 'reply_checked', id: ana, source: 'app', who: 'floorboss' }, L);
  assert.equal(listAt(H, L).in_browser, 1);
});

test('a step sent back or dropped holds the next approved step out of the mailbox drafts, files and tasks; a skip does not', () => {
  const mk = () => {
    const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['chat'], followups: 'scheduled', linkedin_ack: true }, route: ['email', 'email', 'email'] } });
    writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: {} }));
    triage(H);
    draftApprove(H);
    sentMark(H, idOf(H, 'Ana Berg'), 1, { channel: 'email' }, later(-1));
    return H;
  };
  const staged = (H, now = later(8)) => cli(H, 'event-outreach', ['stage-list', '--event', H.slug], now);
  const H = mk();
  const ana = idOf(H, 'Ana Berg');
  assert.equal(staged(H).to_stage, 1, 'the next step is staged as usual');
  add(H, { type: 'revise', id: ana, touch: 2, feedback: 'shorter please', who: 'user', said: 'shorter' });
  assert.equal(staged(H).to_stage, 0, 'step 3 waits for step 2');
  const D = mk();
  add(D, { type: 'dropped', id: idOf(D, 'Ana Berg'), touch: 2, said: 'drop it' });
  assert.equal(staged(D).to_stage, 0);
  const K = mk();
  assert.equal(record(K, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]).applied, true);
  // Staged on its own day (the one rule): step 3, after a skipped step 2, is due Mon 26 Oct.
  assert.equal(staged(K).to_stage, 0, 'not before its day');
  const after = staged(K, later(14));
  assert.equal(after.to_stage, 1, 'a skipped step passes on to the next');
});

test('the app limit counts later-step app requests and first-in-app ones together: one app note listed, the other never approved past the limit', () => {
  const S = { sending: { channels: ['email', 'app'], followups: 'scheduled' }, app_request_limit: 1, route: ['email', 'app'], ...NOTES };
  const people = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,\n';
  const H = setup({ attendees: people, event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-1));
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'email', said: 'nothing by email' }, later(8));
  const list = listAt(H, later(8), ['--no-reply-check', 'nobody replied']);
  assert.equal(list.in_browser, 1, JSON.stringify(list));
  // Run 6: the over-limit app note is held at todo as a backup, so it is never written or approved to wait here.
  assert.ok(!entries(H).some((e) => e.type === 'approved' && e.touch === 2), 'no second app note past the limit is approved');

  const T = setup({ attendees: people, event: { app_name: 'Grip' }, settings: S });
  triage(T);
  const a2 = idOf(T, 'Ana Berg');
  sentMark(T, a2, 1, { channel: 'email', via: 'email.send' }, later(-1));
  sentMark(T, a2, 2, { channel: 'Grip' });
  const { t, jobs } = todoJobs(T);
  assert.ok(!jobs.some((j) => j.id === idOf(T, 'Bo Li')), 'the limit was spent at a later step: Bo waits');
  assert.match(JSON.stringify(t), /backup/);
});

test('a person declined for the CRM is not created by yes mode or an older yes', () => {
  const mk = (mode) => {
    const H = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { crm_log: 'browser', crm_create_contacts: mode, ...NOTES } });
    triage(H);
    draftApprove(H);
    const ana = idOf(H, 'Ana Berg');
    sentMark(H, ana, 1, { channel: 'LinkedIn', text: 'Hello Ana' });
    add(H, { type: 'crm_log_result', id: ana, touch: 1, result: 'not_found', who: 'floorboss', page_says: 'no match' });
    return { H, ana, list: () => cli(H, 'event-outreach', ['log-list', '--event', H.slug]) };
  };
  const yes = mk('yes');
  add(yes.H, { type: 'crm_create_declined', ids: [yes.ana], said: 'leave her out' });
  const r = yes.list();
  assert.deepEqual((r.not_in_crm || []).map((x) => x.id), [yes.ana], JSON.stringify(r));
  const asked = mk('ask');
  add(asked.H, { type: 'crm_create_ok', ids: [asked.ana], said: 'yes add her' });
  add(asked.H, { type: 'crm_create_declined', ids: [asked.ana], said: 'on second thoughts no' });
  const r2 = asked.list();
  assert.deepEqual((r2.not_in_crm || []).map((x) => x.id), [asked.ana], JSON.stringify(r2));
  const items = JSON.parse(readFileSync(join(asked.H.dir, 'crm-log-list.json'), 'utf8'));
  assert.ok(!items.some((x) => x.create), 'no create item is written');
});

// A three-email sequence, approved, for the staleness cases.
function sequence() {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const d = draftApprove(H);
  assert.equal(d.gate.approved, 3, JSON.stringify(d.gate).slice(0, 400));
  return { H, ana: idOf(H, 'Ana Berg') };
}
function rewrite(H, id, touch, now = NOW) {
  const { jobs, t } = todoJobs(H, now);
  const j = jobs.find((x) => x.id === id && x.touch === touch);
  assert.ok(j, `job ${touch}: ${JSON.stringify(jobs.map((x) => x.touch))}`);
  const d = draftFor({ ...t, insights: [] }, { ...j, slot_labels: j.slot_labels || [] });
  const out = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', id, '--touch', String(touch), '--json', JSON.stringify({ subject: 'Test Expo', body: `${d.body}\n\nRewritten.`, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], now);
  assert.ok(!out.ERROR, out.ERROR);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', id, '--touch', String(touch), '--text', 'PASS'], now);
}

test('a follow-up stays approved over a plain skip, and goes back when the message actually before it is rewritten', () => {
  const plain = sequence();
  assert.equal(record(plain.H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]).applied, true);
  sentMark(plain.H, plain.ana, 1, { channel: 'email', via: 'email.send' });
  const pl = listAt(plain.H, later(14), ['--no-reply-check', 'nobody replied']);
  assert.ok(emailList(plain.H).some((x) => x.touch === 3), JSON.stringify(pl));

  const { H, ana } = sequence();
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]).applied, true);
  const fb = put(H, 'fb.txt', {});
  writeFileSync(fb, 'shorter please');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', fb]);
  rewrite(H, ana, 1);
  const before = todoJobs(H).jobs.map((j) => j.touch).sort();
  assert.ok(before.includes(1) && before.includes(3), JSON.stringify(before));
  const g1 = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.equal(g1.not_ready.some((x) => x.touch === 3 && /rewritten|new draft|earlier version/.test(x.reason)), true, JSON.stringify(g1).slice(0, 500));
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' });
  const held = listAt(H, later(14), ['--no-reply-check', 'nobody replied']);
  assert.ok(!emailList(H).some((x) => x.touch === 3), 'message 3 is held');
  assert.match(held.waiting.find((w) => w.touch === 3)?.why || '', /needs a new draft/);
  // A forged map in the working copy changes nothing: the ledger's save decides.
  const f = join(H.dir, 'work', 'drafts', `${ana}-t3.json`);
  const dk = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...dk, before_hashes: { 1: state(H)[ana].touches[1].hash } }));
  listAt(H, later(14), ['--no-reply-check', 'nobody replied']);
  assert.ok(!emailList(H).some((x) => x.touch === 3), 'the working copy is not believed');
  writeFileSync(f, JSON.stringify(dk));
  const inp = cli(H, 'event-outreach', ['critic-input', '--event', H.slug, '--id', ana, '--touch', '3'], later(14));
  assert.match(JSON.stringify(inp), /Rewritten\./, 'the critic reads message 1 as the message before');
  rewrite(H, ana, 3, later(14));
  const g2 = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], later(14));
  assert.ok(g2.approved >= 1 && !g2.not_ready.some((x) => x.touch === 3), JSON.stringify(g2).slice(0, 500));
  listAt(H, later(14), ['--no-reply-check', 'nobody replied']);
  assert.ok(emailList(H).some((x) => x.touch === 3), 'rewritten and approved, it goes');
});

test('no skip: a rewrite still sends the next follow-up back, and the flow sees the same', () => {
  const { H, ana } = sequence();
  const fb = put(H, 'fb2.txt', {});
  writeFileSync(fb, 'shorter');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', fb]);
  rewrite(H, ana, 1);
  assert.ok(todoJobs(H).jobs.some((j) => j.touch === 2), 'the next run plans it again');
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(g.not_ready.some((x) => x.touch === 2), JSON.stringify(g).slice(0, 400));
  assert.equal(rewrittenSince({ before_hashes: { 1: 'a'.repeat(24) } }, {}, { touch: 3, previous_touch_now: 1, previous_hash_now: 'b'.repeat(24) }), true, 'skip passed over: compared with message 1');
  assert.equal(rewrittenSince({ before_hashes: { 1: 'a'.repeat(24) } }, {}, { touch: 3, previous_touch_now: 1, previous_hash_now: 'a'.repeat(24) }), false, 'unchanged');
  assert.equal(rewrittenSince({ previous_hash: 'c'.repeat(24) }, {}, { touch: 3, previous_touch_now: 1, previous_hash_now: 'a'.repeat(24) }), false, 'an older draft past a skip is never called stale from the skipped step');
  assert.equal(rewrittenSince({ previous_hash: 'c'.repeat(24) }, {}, { touch: 2, previous_touch_now: 1, previous_hash_now: 'a'.repeat(24) }), true, 'an older draft with no skip still compares');
});

test('a route step floorboss sends itself gets no CRM task; a LinkedIn step floorboss will not send does', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['email', 'app', 'linkedin'], crm_log: 'tasks', ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-3));
  const t2 = cli(H, 'event-outreach', ['task-list', '--event', H.slug], later(14));
  assert.equal(t2.by_kind?.send || 0, 0, JSON.stringify(t2));
  sentMark(H, ana, 2, { channel: 'Grip' }, later(14));
  // The LinkedIn step's task is made as soon as its day is known (owner decision 0.1.7: LinkedIn tasks are made early, due on their day, Mon 26 Oct here).
  const early = cli(H, 'event-outreach', ['task-list', '--event', H.slug], later(14));
  assert.equal(early.by_kind?.send || 0, 1, JSON.stringify(early));
  const t3 = cli(H, 'event-outreach', ['task-list', '--event', H.slug], later(18));
  assert.equal(t3.by_kind?.send || 0, 1, JSON.stringify(t3));
});

test('a step the guard already released cannot be skipped until it is settled', () => {
  const { H, ana } = sequence();
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' });
  const hash = entries(H).find((e) => e.type === 'approved' && e.touch === 2).hash;
  add(H, { type: 'send_released', who: 'guard', id: ana, touch: 2, hash, via: 'email.send', to: 'ana@acme.test' });
  const r = record(H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]);
  assert.match(JSON.stringify(r), /may have gone/, JSON.stringify(r));
  assert.ok(!state(H)[ana].touches[2].skipped);
  add(H, { type: 'release_cleared', id: ana, touch: 2, said: 'it never went', who: 'user' });
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]).applied, true);
  assert.ok(state(H)[ana].touches[2].skipped);
});

test('a send found after a skipped step takes the next unused touch and keeps the last message channel', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'app', 'linkedin', 'email'], ...NOTES } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-10));
  add(H, { type: 'step_skipped', id: ana, touch: 2, said: 'skip the app' });
  sentMark(H, ana, 3, { channel: 'LinkedIn' }, later(-5));
  const now = later(8);
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug], now);
  const out = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', put(H, 'sync.json', { people: [{ id: ana, messages: [{ message_id: 'm9', direction: 'out', at: later(5), subject: 'Re: Expo', text: 'x' }] }] })], now);
  assert.ok(!out.ERROR, out.ERROR);
  const st = state(H)[ana];
  assert.ok(st.sent[4], JSON.stringify(st.sent));
  assert.equal(fold(entries(H)).people[ana].touches[3].sent.channel, 'LinkedIn');
});

const RUN = { active: true, session: true, until: '2026-10-30T12:00:00.000Z' };
const browserCall = (tool, tool_input, extra = {}) => check({ tool_name: tool, tool_input }, { config: {}, active: RUN, ...extra });
test('a browser word inside a server or tool name no longer gets the browser read rules', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    for (const t of ['mcp__notes__chrome__find', 'mcp__filebrowser__get_text']) assert.match(browserCall(t, { query: 'short' }) || '', /wasn't given and didn't find/, t);
    assert.ok(browserCall('mcp__notes__chrome__find', { query: 'x'.repeat(301) }), 'a long value too');
    for (const t of ['mcp__claude-in-chrome__find', 'mcp__Claude_Browser__get_page_text', 'mcp__playwright__browser_snapshot', 'mcp__remote-devices__Claude_Browser__browser_snapshot', 'mcp__remote-devices__Claude_Browser__navigate', 'mcp__chrome-devtools__take_snapshot'])
      assert.equal(browserCall(t, { url: t.includes('navigate') ? 'https://www.linkedin.com/in/ana' : undefined }), null, t);
    writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ setup_servers: ['pw'], setup_found: { browser: ['mcp:pw'] }, setup_browser_tools: ['mcp:pw'], found: {} }));
    assert.equal(browserCall('mcp__pw__browser_snapshot', {}), null, 'a browser the first scan found still reads');
    assert.ok(browserCall('mcp__filebrowser__get_text', { path: '/x' }, { active: { ...RUN, browser: true } }), 'a run reading a page does not make filebrowser given');
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
});

const at = (min) => new Date(Date.parse(NOW) + min * 6e4).toISOString();
test('one word about the app does not clear LinkedIn: no_reply_said is about one channel', () => {
  const word = (channel) => ({ type: 'no_reply_said', ids: ['c001'], at: at(-1), channel });
  assert.equal(lastReplyCheck([word('app')], 'c001', 'browser', {}, 0, 'app') > 0, true);
  assert.equal(lastReplyCheck([word('app')], 'c001', 'browser', {}, 0, 'linkedin'), null);
  assert.equal(lastReplyCheck([word('linkedin')], 'c001', 'email.send', { email: false, crm: false }, 0), null, 'nor email');
  assert.equal(lastReplyCheck([word('email')], 'c001', 'email.send', { email: false, crm: false }, 0) > 0, true);
  assert.deepEqual(uncheckedChannels({ id: 'c001', touch: 3, via: 'email.send' }, { touches: { 1: { sent: { channel: 'Grip' }, sent_at: at(-5000) }, 2: { sent: { channel: 'LinkedIn' }, sent_at: at(-3000) } } }, [word('app')], {}, Date.parse(NOW)), ['linkedin']);
});

test('the no_reply answer is stored with the channel asked about, one person or several', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n' });
  triage(H);
  const [a, b] = [idOf(H, 'Ana Berg'), idOf(H, 'Bo Li')];
  const say = (v) => cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'no_reply', '--value-file', put(H, 'a.json', v)]);
  say({ id: a, answer: 'no reply', said: 'nothing there', channel: 'linkedin' });
  say({ none: true, people: [a, b], said: 'nobody', channel: 'app' });
  assert.deepEqual(entries(H).filter((e) => e.type === 'no_reply_said').map((e) => e.channel ?? null), [null, null], 'a channel in the answer is not believed');
  assert.deepEqual(askedChannels({ ask: { channels: ['app', 'linkedin'] } }), ['app', 'linkedin'], 'the step says which');
  assert.deepEqual(askedChannels({ ask: { channels: ['fax'] } }), [null]);
  const list = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email'] } });
  writeFileSync(join(list.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(list);
  draftApprove(list);
  sentMark(list, idOf(list, 'Ana Berg'), 1, { channel: 'email', via: 'email.send' });
  listAt(list, later(14), ['--no-reply-check', 'nobody replied']);
  assert.equal(entries(list).filter((e) => e.type === 'no_reply_said').pop().channel, 'email', 'send-list --no-reply-check says which');
});

test('a CRM read clears neither the app nor LinkedIn inbox; only a read of that inbox or the word about it does', () => {
  const crm = { type: 'reply_checked', id: 'c001', source: 'crm', at: at(-1) };
  const tasks = { type: 'reply_checked', id: 'c001', source: 'tasks', at: at(-1) };
  const app = { type: 'reply_checked', id: 'c001', source: 'app', at: at(-1) };
  for (const e of [crm, tasks]) {
    assert.equal(lastReplyCheck([e], 'c001', 'browser', { other: true }, 0, 'app'), null, e.source);
    assert.equal(lastReplyCheck([e], 'c001', 'browser', { other: true }, 0, 'linkedin'), null, e.source);
    assert.ok(lastReplyCheck([e], 'c001', 'chat.send', { other: true }, 0) > 0, `${e.source} still counts for a chat follow-up`);
  }
  assert.ok(lastReplyCheck([app], 'c001', 'browser', { other: true }, 0, 'app') > 0);
  assert.equal(lastReplyCheck([{ type: 'no_reply_said', ids: ['c001'], at: at(-1), channel: 'app' }], 'c001', 'browser', { other: false }, 0, 'app') > 0, true, 'the word about that inbox counts where no reader stands in for it');
  const email = { id: 'c001', touch: 3, via: 'email.send' };
  const person = { touches: { 1: { sent: { channel: 'Grip' }, sent_at: at(-5000) }, 2: { sent: { channel: 'LinkedIn' }, sent_at: at(-3000) } } };
  assert.deepEqual(uncheckedChannels(email, person, [crm], { email: true, crm: true, other: true }, Date.parse(NOW)).sort(), ['app', 'linkedin']);
});

test('people the app or LinkedIn inbox cannot be read for are asked in one question, about that channel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-other-'));
  const e = { event: { slug: 'ev', app_name: 'Grip' }, paths: { derived: dir, dir, work: dir }, state: { tool_failed: {} }, settings: {} };
  const s = otherChannelStep({}, e, { connectors: {} }, { id: 'c001', name: 'Ana Berg', check: ['app'] }, [{ id: 'c002', name: 'Bo Li', check: ['app'] }, { id: 'c003', name: 'Cy Ek', check: ['linkedin'] }]);
  assert.equal(s.ask.id, 'no_reply');
  assert.deepEqual(s.ask.channels, ['app']);
  assert.deepEqual(s.ask.people.map((p) => p.id), ['c001', 'c002']);
  assert.match(s.ask.question, /Ana Berg, Bo Li/);
  const one = otherChannelStep({}, e, { connectors: {} }, { id: 'c001', name: 'Ana Berg', check: ['linkedin'] }, []);
  assert.equal(one.ask.person.id, 'c001');
  assert.deepEqual(one.ask.channels, ['linkedin']);
  const all = otherChannelStep({}, e, { connectors: {} }, { id: 'c001', name: 'Ana Berg', via: 'browser', where: 'LinkedIn', check: ['email', 'app'] }, [{ id: 'c002', name: 'Bo Li', via: 'browser', where: 'LinkedIn', check: ['email', 'app'] }, { id: 'c003', name: 'Cy Ek', via: 'browser', where: 'LinkedIn', check: [] }]);
  assert.deepEqual(all.ask.channels, ['email', 'app', 'linkedin'], 'one question for every channel floorboss can not read');
  assert.deepEqual(all.ask.people.map((p) => p.id), ['c001', 'c002', 'c003']);
});

test('a route step goes on its channel: an app step is not sent by chat to someone with an email and a phone', () => {
  const S = { sending: { channels: ['email', 'chat', 'app'], followups: 'scheduled' }, route: ['email', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,Phone\nAna Berg,COO,Acme,ana@acme.test,+4915123456789\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, 'chat.send': CHAT } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-1));
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'email', said: 'nothing by email' }, later(9));
  const list = listAt(H, later(9), ['--no-reply-check', 'nobody replied']);
  assert.equal(list.by_chat, 0, JSON.stringify(list));
  assert.equal(list.in_browser, 1, JSON.stringify(list));
  assert.equal(browserList(H)[0].where, 'Grip');
  assert.doesNotMatch(browserList(H)[0].to, /\+49/);
});

test('an app route step is not shown as a LinkedIn card in the outbox', () => {
  const cards = (extra) => [{ id: 'c001', touch: 2, name: 'Ana', title: 'COO', company: 'Acme', kind: 'message', channel: 'paste', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [], earliest: '', ...extra }];
  const render = (extra) => renderOutbox({ event: { name: 'Test', app_name: 'Grip' }, cards: cards(extra), slots: [], counts: {} });
  assert.doesNotMatch(render({ routed: 'app' }), /data-li="1"/);
  assert.match(render({}), /data-li="1"/, 'a LinkedIn step still is');
  // Through the real outbox: a routed app step names the app, not the LinkedIn link it also has.
  const S = { sending: { channels: ['chat'], followups: 'scheduled' }, route: ['email', 'app'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  sentMark(H, idOf(H, 'Ana Berg'), 1, { channel: 'email', via: 'email.send' }, later(-1));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], later(8));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /paste it in Grip/);
  assert.match(html, /Paste message \(Grip\)/);
  assert.doesNotMatch(html.slice(html.indexOf('class="card'), html.indexOf('</article>')), /linkedin\.com\/in\/ana/, 'not the LinkedIn address');
});

test('a route answer it cannot read leaves the question open; "email only" keeps the follow-ups', () => {
  assert.deepEqual(parseRoute('email only'), ['email', 'email']);
  assert.deepEqual(parseRoute('just email'), ['email', 'email']);
  assert.deepEqual(parseRoute('email'), ['email'], 'one step, said plainly, is still one step');
  assert.deepEqual(parseRoute('just email then linkedin'), ['email', 'linkedin']);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const say = (v) => cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'message_route', '--value-file', put(H, 'route.json', v)]);
  const bad = say('fax only');
  assert.match(bad.ERROR || '', /isn't a channel/);
  const ob = () => JSON.parse(existsSync(join(H.HOME, 'onboarding.json')) ? readFileSync(join(H.HOME, 'onboarding.json'), 'utf8') : '{}');
  assert.ok(!JSON.stringify(ob()).includes('message_route_asked'), 'still unanswered');
  const ok = say('email only');
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.ok(JSON.stringify(ob()).includes('message_route_asked'));
});

test('the critic is the separate critic in everything shipped', () => {
  for (const f of ['commands/event-draft.md', 'skills/flow/scripts/steps.mjs', 'skills/flow/scripts/context.mjs', ...readdirSync(join(ROOT, 'skills/flow/scripts/steps')).map((f) => `skills/flow/scripts/steps/${f}`), 'skills/event-outreach/scripts/drafter.mjs', 'agents/outreach-critic.md'])
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /independent critic/i, f);
});

test('multi-channel route with a skipped step: an unlabelled LinkedIn send, one word per channel, and a CRM read that clears neither', () => {
  const S = { sending: { channels: ['email', 'linkedin', 'app'], followups: 'scheduled', linkedin_ack: true }, route: ['email', 'app', 'linkedin', 'email'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, 'crm.activity': { server: 'hubspot', tool: 'activity' } } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-8));
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip the app' }]).applied, true);
  // Message 3 went on LinkedIn by hand and was pasted back with no channel.
  add(H, { type: 'sent', id: ana, touch: 3, date: later(-1).slice(0, 10), who: 'user', said: 'status' }, later(-1));
  const L = later(22);
  const waiting = () => {
    const list = listAt(H, L);
    return list.waiting.find((w) => w.id === ana && w.touch === 4);
  };
  add(H, { type: 'reply_checked', id: ana, source: 'crm', who: 'floorboss', sees_email: true }, L);
  assert.match(waiting()?.why || '', /linkedin/, 'the LinkedIn send, read from the route, still needs checking; a CRM read does not do it');
  add(H, { type: 'no_reply_said', who: 'user', ids: [ana], channel: 'app', said: 'nothing in the app' }, L);
  assert.deepEqual(waiting()?.check, ['linkedin'], 'nor does a word about the app');
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug, '--channel', 'linkedin', '--ids', ana], L);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'sync-list.json'), 'utf8')).length, 1, 'the unlabelled send counts as LinkedIn for the inbox read too');
  add(H, { type: 'no_reply_said', who: 'user', ids: [ana], channel: 'linkedin', said: 'nothing on LinkedIn' }, L);
  add(H, { type: 'reply_checked', id: ana, source: 'mailbox', who: 'mailbox' }, L);
  const final = listAt(H, L);
  assert.ok(emailList(H).some((x) => x.touch === 4 && x.id === ana), JSON.stringify(final.waiting));
});

// From the independent review of these fixes.
const ROWS = (name) => [{ id: 'c1', name: 'Ana Berg' }, { id: 'c2', name: 'Bo Li' }, { id: 'c3', name }];
test('a stray word between names stays unread whatever names are on the list, so it is refused', () => {
  for (const [name, word] of [['Minus Ter', 'minus'], ['Never Land', 'never'], ['Sans Serif', 'sans'], ['Besides Mo', 'besides'], ['Nope Way', 'nope'], ['Dont Know', 'dont'], ['Maybe Not', 'maybe'], ['Skip Lee', 'skip'], ['Leave Out', 'leave']])
    assert.equal(namesToIds(`approve Ana ${word} Bo`, ROWS(name)), `approve ana ${word} bo`, name);
  assert.equal(namesToIds('approve Ana, Bo and c3', ROWS('Cy Ng')), 'approve c1, c2 and c3');
  assert.equal(namesToIds('approve all except Ana, Bo Li too', ROWS('Cy Ng')), 'approve all except c1, c2 too');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nNever Land,CFO,Initech,nl@initech.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  const r = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve Ana never Bo']);
  assert.ok(!(r.approved > 0), JSON.stringify(r).slice(0, 200));
  const run = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve Ana Bo']);
  assert.match(JSON.stringify(run), /commas/, 'a run of names with spaces only asks for commas or ids');
  assert.equal(entries(H).filter((e) => e.type === 'approved').length, 0);
  const said = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve Ana Berg\nAna Berg minus legal']);
  assert.match(said.ERROR || '', /Nothing was approved|isn't/, 'a refused line naming someone approved in words stops the approval');
  assert.equal(entries(H).filter((e) => e.type === 'approved').length, 0);
});

test('during a run the browser read rule goes by exact names or what setup found', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    for (const t of ['mcp__file-browser__get_text', 'mcp__file_browser__get_text', 'mcp__notes-chrome__find', 'mcp__browser-notes__get_text', 'mcp__chrome-history__find', 'mcp__notes.browser__find', 'mcp__remote-devices__notes__chrome__find'])
      assert.ok(browserCall(t, { path: '~/.ssh/id_rsa' }), t);
    for (const t of ['mcp__claude-in-chrome__find', 'mcp__Claude_Browser__find', 'mcp__remote-devices__Claude_Browser__find', 'mcp__playwright__browser_snapshot', 'mcp__plugin_playwright_playwright__browser_snapshot', 'mcp__chrome-devtools__take_snapshot', 'mcp__browsermcp__get_text', 'mcp__browserbase__get_text', 'mcp__steel-browser__get_text', 'mcp__computer-use__screenshot'])
      assert.equal(browserCall(t, {}), null, t);
    const inv = summarize([], { tools: ['mcp__hyperbrowser__navigate', 'mcp__hyperbrowser__get_page_text', 'mcp__hyperbrowser__click'] });
    assert.ok(inv.found.browser.includes('mcp:hyperbrowser'), JSON.stringify(inv.found));
    writeFileSync(join(H.HOME, 'inventory.json'), JSON.stringify({ setup_servers: ['hyperbrowser'], setup_found: { browser: ['mcp:hyperbrowser'] }, setup_browser_tools: ['mcp:hyperbrowser'], found: {} }));
    assert.equal(browserCall('mcp__hyperbrowser__get_page_text', {}), null, 'a browser setup found has a way in');
    assert.ok(browserCall('mcp__file-browser__get_text', { path: '/x' }, { active: { ...RUN, browser: true } }));
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
});

test('send-list --no-reply-check stays refused where a reader exists; the user answer about the channel still counts', () => {
  const S = { ...APP_ONLY, route: ['app', 'app'] };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'crm.activity': { server: 'hubspot', tool: 'activity' } } }));
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'Grip', source: 'user' });
  const L = later(9);
  const flagged = listAt(H, L, ['--no-reply-check', 'nobody replied']);
  assert.equal(flagged.in_browser, 0, JSON.stringify(flagged));
  assert.match(flagged.waiting[0].why, /can look at their replies/);
  assert.equal(entries(H).filter((e) => e.type === 'no_reply_said').length, 0, 'no word is written from the flag');
  add(H, { type: 'no_reply_said', ids: [ana], channel: 'app', said: 'nothing in Grip' }, L);
  assert.equal(listAt(H, L).in_browser, 1, 'the answer about that inbox clears it with a CRM connected');
});

test('an app_outcome answer settles the person the step asked about, never another note', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP,Globex,\n', event: { app_name: 'Grip' }, settings: APP_ONLY });
  triage(H);
  draftApprove(H);
  const [ana, bo] = [idOf(H, 'Ana Berg'), idOf(H, 'Bo Li')];
  const hash = (id) => entries(H).find((e) => e.type === 'approved' && e.id === id).hash;
  add(H, { type: 'send_released', who: 'guard', id: ana, touch: 1, hash: hash(ana), via: 'browser', to: 'x' });
  add(H, { type: 'app_result', who: 'floorboss', id: ana, touch: 1, result: 'failed', page_says: '?' });
  add(H, { type: 'release_cleared', id: ana, touch: 1, said: 'it did not go' }, later(0, 1));
  add(H, { type: 'answered', who: 'user', ask: 'app_outcome', value: 'no', said: 'it did not go' }, later(0, 2));
  add(H, { type: 'send_released', who: 'guard', id: bo, touch: 1, hash: hash(bo), via: 'browser', to: 'y' }, later(0, 3));
  const folded = fold(entries(H));
  assert.equal(appOutcomeTarget(folded, null).id, bo, 'with no step, the one still open');
  const step = { ask: { id: 'app_outcome', person: { id: bo, touch: 1 } } };
  assert.deepEqual(appOutcomeTarget(folded, step), { id: bo, touch: 1, released: true });
});

test('one reply question covers the send window: later notes in it are not asked again, and nothing outside it is waived', () => {
  const S = { ...APP_ONLY, route: ['app', 'app'] };
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP,Globex,\nCy Ng,CFO,Initech,\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const ids = ['Ana Berg', 'Bo Li', 'Cy Ng'].map((n) => idOf(H, n));
  for (const id of ids) sentMark(H, id, 1, { channel: 'Grip', source: 'user' });
  const L = later(9);
  add(H, { type: 'no_reply_said', ids, channel: 'app', said: 'nothing there' }, L);
  assert.equal(listAt(H, L).in_browser, 3);
  openWin(H, L, false);
  const later100 = later(9, 2);
  sentMark(H, ids[0], 2, { channel: 'Grip' }, later100);
  const mid = listAt(H, later100);
  assert.equal(mid.in_browser, 2, JSON.stringify(mid.waiting));
  assert.deepEqual(mid.waiting.filter((w) => /replies weren't checked/.test(w.why)), [], 'not asked again in the window');
  add(H, { type: 'stop', id: ids[1], said: 'she asked to stop' }, later100);
  assert.equal(listAt(H, later100).in_browser, 1, 'a stop still takes someone out of the window');
  const w = JSON.parse(readFileSync(join(H.HOME, 'browser-send.json'), 'utf8'));
  writeFileSync(join(H.HOME, 'browser-send.json'), JSON.stringify({ ...w, ids: [] }));
  const outside = listAt(H, later100);
  assert.equal(outside.in_browser, 0, 'a note outside the window still needs a fresh check');
});

test('beside approve all, a company word holds the approval too; an ordinary remark does not', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Zento,ana@zento.test\nBo Li,VP,Globex,bo@globex.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  for (const a of ['approve all but Zento', 'approve all but the Zento person'])
    assert.match(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', a]).ERROR || '', /can't be read|isn't a list of IDs or listed names|may be about someone/, a);
  assert.equal(entries(H).filter((e) => e.type === 'approved').length, 0);
  // Run 6, round 3: an ordinary remark is read back first and saved on yes.
  assert.equal(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all, no changes']).pending, true);
  assert.equal(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'yes']).approved, 2);
});

test('the app name found inside a channel label counts as the app, before any chat test', () => {
  assert.equal(sentKind({ channel: 'Wizzlechat app' }, { appName: 'Wizzlechat' }), 'app');
  assert.equal(sentKind({ channel: 'Grip chat' }, { appName: 'Grip' }), 'app');
  assert.equal(sentKind({ channel: 'Griphold chat' }, { appName: 'Grip' }), null, 'only as a word of its own');
});

test('two listed notes in one form call are refused, so each prompt names one person', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,\nBo Li,VP,Globex,\n', event: { app_name: 'Grip' }, settings: APP_ONLY });
  triage(H);
  draftApprove(H);
  openWin(H);
  const [a, b] = browserList(H);
  const r = guard(H, 'mcp__playwright__browser_fill_form', { fields: [{ name: 'M1', type: 'textbox', ref: 'e1', value: a.body }, { name: 'M2', type: 'textbox', ref: 'e2', value: b.body }] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one listed note per call/);
  assert.ok(!entries(H).some((e) => e.type === 'send_released'), 'neither is released');
});

// Variants of records already fixed.
test('app limit variant: three people first in the app at limit 2: only two are written and listed', () => {
  const S = { sending: { channels: ['app', 'linkedin'], followups: 'scheduled', linkedin_ack: true }, app_request_limit: 2, route: ['app', 'linkedin'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\nBo Li,VP,Globex,https://www.linkedin.com/in/bo\nCy Ng,CFO,Initech,https://www.linkedin.com/in/cy\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  const list = listAt(H, NOW);
  assert.equal(list.in_browser, 2, JSON.stringify(list.waiting));
  assert.equal(entries(H).filter((e) => e.type === 'approved' && e.touch === 1).length, 2, 'the third waits as a backup, unwritten');
  assert.ok(browserList(H).every((x) => x.where === 'Grip'));
});

test('logList variant: a later yes after a decline creates the contact again', () => {
  const H = setup({ attendees: 'Name,Title,Company,LinkedIn\nAna Berg,COO,Acme,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: { crm_log: 'browser', crm_create_contacts: 'ask', ...NOTES } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 1, { channel: 'LinkedIn', text: 'Hello Ana' });
  add(H, { type: 'crm_log_result', id: ana, touch: 1, result: 'not_found', who: 'floorboss', page_says: 'no match' });
  add(H, { type: 'crm_create_declined', ids: [ana], said: 'no' });
  add(H, { type: 'crm_create_ok', ids: [ana], said: 'actually yes' });
  cli(H, 'event-outreach', ['log-list', '--event', H.slug]);
  assert.ok(JSON.parse(readFileSync(join(H.dir, 'crm-log-list.json'), 'utf8')).some((x) => x.create), 'the newest answer decides');
});

test('sendRoute variant: a LinkedIn step goes in LinkedIn for someone with a phone; a person routed to chat by hand or with no email still goes by chat', () => {
  const S = { sending: { channels: ['chat', 'linkedin'], followups: 'scheduled', linkedin_ack: true }, route: ['linkedin', 'linkedin'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn,Phone\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana,+4915123456789\nBo Li,VP,Globex,,,+4915123456780\n', event: { app_name: 'Grip' }, settings: S });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'chat.send': CHAT } }));
  triage(H);
  draftApprove(H);
  const list = listAt(H, NOW);
  const ana = idOf(H, 'Ana Berg');
  assert.equal(list.waiting[0].why, 'you send this one yourself on LinkedIn', JSON.stringify(list));
  assert.ok(JSON.parse(readFileSync(join(H.dir, 'derived', 'send-list.json'), 'utf8')).some((x) => x.id === idOf(H, 'Bo Li') && x.via === 'chat.send'), JSON.stringify(list));
});

test('taskList variant: an app step with app sending off is a task, and is not doubled', () => {
  const S = { sending: { channels: ['chat'], followups: 'scheduled', linkedin_ack: true }, route: ['email', 'app'], crm_log: 'tasks', ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  sentMark(H, idOf(H, 'Ana Berg'), 1, { channel: 'email', via: 'email.send' }, later(-3));
  const t = cli(H, 'event-outreach', ['task-list', '--event', H.slug], later(14));
  assert.equal(t.by_kind?.send || 0, 1, JSON.stringify(t));
});

test('skip variant: a bounce settles a release for skipping; a skip with no touch named still lands past a skipped step', () => {
  const { H, ana } = sequence();
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' });
  const hash = entries(H).find((e) => e.type === 'approved' && e.touch === 2).hash;
  add(H, { type: 'send_released', who: 'guard', id: ana, touch: 2, hash, via: 'email.send', to: 'ana@acme.test' });
  assert.match(JSON.stringify(record(H, [{ who: 'Ana Berg', what: 'skipped', said: 'skip the next one' }])), /may have gone/, 'the default touch is the released one');
  add(H, { type: 'bounced', id: ana, touch: 2, who: 'mailbox', source: 'mailbox', ext: 'b1' });
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'skipped', touch: 2, said: 'skip it' }]).applied, true);
  assert.ok(state(H)[ana].touches[2].skipped);
});

test('sync variant: a confirmation does not throw off the count, and two finds take two touches past two skips', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  sentMark(H, ana, 0, { channel: 'email', via: 'email.send' }, later(-20));
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' }, later(-15));
  add(H, { type: 'step_skipped', id: ana, touch: 2, said: 'skip it' });
  add(H, { type: 'step_skipped', id: ana, touch: 3, said: 'skip that too' });
  const now = later(12);
  cli(H, 'event-outreach', ['sync-list', '--event', H.slug], now);
  const out = cli(H, 'event-outreach', ['sync', '--event', H.slug, '--source', 'mailbox', '--file', put(H, 'sync2.json', { people: [{ id: ana, messages: [{ message_id: 'm1', direction: 'out', at: later(3), subject: 'x', text: 'x' }, { message_id: 'm2', direction: 'out', at: later(10), subject: 'y', text: 'y' }] }] })], now);
  assert.ok(!out.ERROR, out.ERROR);
  const st = state(H)[ana];
  assert.deepEqual(Object.keys(st.sent).map(Number).sort((a, b) => a - b), [0, 1, 4, 5], JSON.stringify(st.sent));
});

// From the second review of these fixes.
test('a row whose name holds a list separator or a structural word goes by id only, through the real gate', () => {
  for (const [row, answer] of [['Ana & Bo', 'approve all except Ana & Bo'], ['Ana · Bo', 'approve all except Ana · Bo'], ['"Ana, Bo"', 'approve all except Ana, Bo'], ['Bo Too', 'approve Ana, Bo too']]) {
    const H = setup({ attendees: `Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\n${row},CFO,Initech,ab@initech.test\n` });
    triage(H);
    draftApprove(H, NOW, 'edit c001');
    const odd = entries(H).find((e) => e.type === 'person' && /Initech/.test(e.company || ''))?.id;
    cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', answer]);
    const approved = entries(H).filter((e) => e.type === 'approved').map((e) => e.id);
    // "approve all" approves the row itself, as anyone not held back; what matters is that it never stands for them.
    if (!/except/.test(answer)) assert.ok(!approved.includes(odd), `${row}: the row is never named by its name`);
    if (/except/.test(answer)) assert.ok(!approved.includes(idOf(H, 'Ana Berg')) && !approved.includes(idOf(H, 'Bo Li')), `${row}: those held back stay held: ${approved}`);
  }
});

test('inside an app-only send window, LinkedIn messaging stays shut even when its inbox may be read', () => {
  const app = appNote();
  openWin(app);
  writeFileSync(join(app.HOME, 'config.json'), JSON.stringify({ inbox_read: { linkedin: true, app: true } }));
  for (const u of ['https://www.linkedin.com/messaging/thread/1', 'https://www.linkedin.com/messaging/compose/?recipient=ana'])
    assert.equal(guard(app, 'mcp__claude-in-chrome__navigate', { url: u }).status, 2, u);
});

test('app-result clears only a browser release for a note in the window, never an email release', () => {
  const { H, ana } = sequence();
  sentMark(H, ana, 1, { channel: 'email', via: 'email.send' });
  const hash = entries(H).find((e) => e.type === 'approved' && e.touch === 2).hash;
  add(H, { type: 'send_released', who: 'guard', id: ana, touch: 2, hash, via: 'email.send', to: 'ana@acme.test' });
  cli(H, 'event-outreach', ['app-result', '--event', H.slug, '--id', ana, '--touch', '2', '--result', 'not_found', '--page-says', 'no such person']);
  assert.ok(!entries(H).some((e) => e.type === 'release_cleared'), 'the email release stands');
  assert.ok(state(H)[ana].touches[2].released);
  const B = appNote();
  openWin(B);
  const [item] = browserList(B);
  assert.equal(type(B, item.body).status, 0);
  cli(B, 'event-outreach', ['app-result', '--event', B.slug, '--id', item.id, '--touch', String(item.touch), '--result', 'too_long', '--page-says', '335/200 characters']);
  assert.ok(entries(B).some((e) => e.type === 'release_cleared' && e.id === item.id), 'a typed note the page refused is settled');
});

test('the first setup scan finds a browser by its tools, never by its name', () => {
  const kinds = (name, tools) => summarize([], { tools: tools.map((t) => `mcp__${name}__${t}`) }).found.browser || [];
  for (const name of ['file-browser', 'notes-chrome', 'chrome-history', 'browser-notes', 'brave-browser', 'Control_Chrome', 'mcp-chrome'])
    assert.deepEqual(kinds(name, ['get_text', 'list_files']), [], name);
  assert.ok(kinds('claude-in-chrome', ['navigate', 'read_page', 'get_page_text', 'find', 'computer']).length);
  assert.ok(kinds('playwright', ['browser_navigate', 'browser_snapshot', 'browser_click']).length);
  assert.ok(kinds('chrome-devtools', ['navigate_page', 'take_snapshot', 'take_screenshot']).length);
  assert.ok(kinds('Control_Chrome', ['open_url', 'get_page_content', 'list_tabs']).length);
  assert.ok(kinds('hyperbrowser', ['navigate', 'get_page_text']).length, 'a browser under another name, by its tools');
  assert.deepEqual(kinds('notes', ['screenshot']), [], 'one page tool alone is no browser');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'session.json');
  writeFileSync(f, JSON.stringify({ tools: ['mcp__file-browser__get_text', 'mcp__file-browser__list_files'] }));
  spawnSync('node', [join(ROOT, 'skills', 'event-context', 'scripts', 'cli.mjs'), 'scan', '--session-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    assert.ok(browserCall('mcp__file-browser__get_text', { path: '~/.ssh/id_rsa' }), 'a name setup saw is no way in');
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
});

test('one reply question for the batch covers every channel anyone in it waits on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-other-'));
  const e = { event: { slug: 'ev', app_name: 'Grip' }, paths: { derived: dir, dir, work: dir }, state: { tool_failed: {} }, settings: {} };
  const s = otherChannelStep({}, e, { connectors: {} }, { id: 'c001', name: 'Ana Berg', via: 'email.send', check: ['email', 'linkedin'] }, [
    { id: 'c002', name: 'Bo Li', via: 'email.send', check: ['email', 'app'] },
    { id: 'c003', name: 'Cy Ng', via: 'email.send', check: ['email', 'app', 'linkedin'] }
  ]);
  assert.deepEqual([...s.ask.channels].sort(), ['app', 'email', 'linkedin']);
  assert.deepEqual(s.ask.people.map((p) => p.id), ['c001', 'c002', 'c003']);
});

test('the same note twice in one form call is refused and nothing is released', () => {
  const H = appNote();
  openWin(H);
  const [a] = browserList(H);
  const r = guard(H, 'mcp__playwright__browser_fill_form', { fields: [{ name: 'M1', type: 'textbox', ref: 'e1', value: a.body }, { name: 'M2', type: 'textbox', ref: 'e2', value: a.body }] });
  assert.equal(r.status, 2);
  assert.ok(!entries(H).some((e) => e.type === 'send_released'));
});

test('a LinkedIn step card names LinkedIn, not the app', () => {
  const S = { sending: { channels: ['app'], followups: 'scheduled' }, route: ['email', 'linkedin'], ...NOTES };
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n', event: { app_name: 'Grip' }, settings: S });
  triage(H);
  draftApprove(H);
  sentMark(H, idOf(H, 'Ana Berg'), 1, { channel: 'email', via: 'email.send' }, later(-1));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], later(8));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /Paste message \(LinkedIn\)/);
  assert.doesNotMatch(html, /Paste message \(Grip or a DM\)/);
});

// From the third review.
test('only a plainly shaped name, with no word the list grammar reads, stands for someone: the rest go by id, through the real gate', () => {
  const rows = 'Ana Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nCy Ek,CTO,Hooli,cy@hooli.test\n';
  for (const [row, answer, held] of [
    ['Ana. Bo', 'approve all except Ana. Bo', true], ['Ana! Bo', 'approve all except Ana! Bo', true], ['Ana | Bo', 'approve all except Ana | Bo', true],
    ['Ana x Bo', 'approve all except Ana x Bo', true], ['Ana vs Bo', 'approve all except Ana vs Bo', true], ['Ana With Bo', 'approve all except Ana With Bo', true],
    ['Ana As Well', 'approve Ana as well', false], ['Ana Anyway', 'approve Ana anyway', false]
  ]) {
    const H = setup({ attendees: `Name,Title,Company,Email\n${rows}"${row}",CFO,Initech,odd@initech.test\n` });
    triage(H);
    draftApprove(H, NOW, 'edit c001');
    const odd = entries(H).find((e) => e.type === 'person' && /Initech/.test(e.company || ''))?.id;
    cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', answer]);
    const approved = entries(H).filter((e) => e.type === 'approved').map((e) => e.id);
    if (held) assert.ok(!approved.includes(idOf(H, 'Ana Berg')) && !approved.includes(idOf(H, 'Bo Li')), `${row}: ${approved}`);
    else assert.ok(!approved.includes(odd), `${row}: the row is never named by its name (${approved})`);
  }
  const P = [{ id: 'c1', name: 'Chloé Durand' }, { id: 'c2', name: "Sean O'Brien" }, { id: 'c3', name: 'Jean-Luc Picard' }, { id: 'c4', name: 'ana berg' }, { id: 'c5', name: 'Bo Li' }];
  assert.equal(namesToIds("approve Chloe Durand, sean o'brien, Jean-Luc and Ana Berg", P), 'approve c1, c2, c3 and c4');
  assert.equal(namesToIds('approve Ana Berg and Bo Li', P), 'approve c4 and c5');
  const H = setup({ attendees: `Name,Title,Company,Email\n${rows}` });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  assert.equal(cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve Ana Berg and Bo Li']).approved, 2);
});

test('a full name that starts with a first name someone else on the list has never soaks up a remark, through the real gate', () => {
  const rows = 'Ana Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nCy Ek,CTO,Hooli,cy@hooli.test\n';
  // Run 6, round 3: none of these saves anything at once, so the remark can't be soaked up unseen. Each is asked again
  // or read back by ID and name, and the reading names the crafted row whenever it would touch it.
  for (const [row, answer] of [
    ['Ana Please', 'approve all except Ana please'],
    ['Ana Ok', 'approve Ana ok'],
    ['Bo Thanks', 'approve Ana, drop Bo thanks']
  ]) {
    const H = setup({ attendees: `Name,Title,Company,Email\n${rows}${row},CFO,Initech,odd@initech.test\n` });
    triage(H);
    draftApprove(H, NOW, 'edit c001');
    const odd = entries(H).find((e) => e.type === 'person' && /Initech/.test(e.company || ''))?.id;
    const r = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', answer]);
    assert.ok(r.ERROR || r.pending, `${row}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(entries(H).filter((e) => e.type === 'approved' || e.type === 'dropped').length, 0, `${row}: nothing saved`);
    if (r.pending && /drop/.test(answer)) assert.match(r.say_to_user, new RegExp(`drop ${odd} "Bo Thanks"`), `${row}: the reading names the row it would drop: ${r.say_to_user}`);
    // Run 6, round 6: the read-back goes on to the yes, which saves exactly the people it named, and something.
    if (r.pending) {
      const y = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'yes']);
      assert.ok(!y.ERROR, y.ERROR);
      const done = entries(H).filter((e) => e.type === 'approved' || e.type === 'dropped');
      assert.ok(done.length, `${row}: the yes saved the reading`);
      // Round 7: exactly the IDs the reading listed under "approve" (or "drop"), each one, and no other.
      const listed = (verb) => new Set(r.say_to_user.split(/;\s*|\.\s+/).filter((p) => new RegExp(`(?:^|reads as: )${verb} `).test(p.trim())).flatMap((p) => p.match(/\bc\d{3,}\b/g) || []));
      for (const e of done) assert.ok(listed(e.type === 'approved' ? 'approve' : 'drop').has(e.id), `${row}: ${e.type} ${e.id} was listed under ${e.type === 'approved' ? 'approve' : 'drop'}: ${r.say_to_user}`);
      for (const id of listed('approve')) assert.ok(done.some((e) => e.type === 'approved' && e.id === id), `${row}: ${id} was listed and approved`);
    }
  }
  const twoAnas = [{ id: 'c1', name: 'Ana Berg' }, { id: 'c2', name: 'Ana Silva' }, { id: 'c3', name: 'Bo Li' }];
  // Run 6: with two Anas a bare "Ana" is asked about, but the whole name, typed as listed, says which.
  assert.equal(namesToIds('approve Ana Berg and Bo Li', twoAnas), 'approve c1 and c3', 'with two Anas, the whole name still resolves');
  assert.equal(namesToIds('approve Ana and Bo Li', twoAnas), 'approve ana and c3', 'and "Ana" alone does not');
});

test('a browser needs a navigate tool and a real page tool, under whatever prefix its server gives them', () => {
  const kinds = (name, tools) => summarize([], { tools: tools.map((t) => `mcp__${name}__${t}`) }).found.browser || [];
  assert.deepEqual(kinds('notes', ['goto', 'find']), []);
  assert.deepEqual(kinds('docs-site', ['navigate', 'find']), []);
  assert.ok(kinds('pp', ['puppeteer_navigate', 'puppeteer_screenshot', 'puppeteer_click']).length, 'Puppeteer under another name');
  assert.ok(kinds('bb', ['browserbase_stagehand_navigate', 'browserbase_screenshot']).length, 'Browserbase under another name');
  assert.ok(kinds('claude-in-chrome', ['navigate', 'read_page', 'find']).length);
});

test('appStep closes a send window once none of its notes is listed, so a reply read after it is not refused', () => {
  const H = appNote();
  openWin(H);
  const [item] = browserList(H);
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', put(H, 'r.json', { sends: [{ id: item.id, touch: item.touch }] })]);
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ inbox_read: { linkedin: true } }));
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://www.linkedin.com/messaging/thread/1' }).status, 2, 'while the window is open');
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    const ev = loadEvent(H.slug);
    const { entries: es } = readLedger(ev.paths.ledger);
    const e = { ...ev, entries: es, state: fold(es), today: NOW.slice(0, 10) };
    appStep({ now: new Date(NOW), home: H.HOME, cfg: {} }, e, {});
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'browser-send.json'), 'utf8')).closed, true);
  assert.equal(guard(H, 'mcp__claude-in-chrome__navigate', { url: 'https://www.linkedin.com/messaging/thread/1' }).status, 0, 'the inbox read the user allowed opens');
});
