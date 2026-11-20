// Auto-send through Gmail drafts (lib/autosend/drafts.mjs) and the daily ChatGPT task (lib/autosend/dailytask.mjs):
// the steps after the second yes (profile, labels, the reply check and send of a first email due now, each follow-up
// as a threaded labelled draft, the read-back), a mismatch or an unknown answer as a stop that names the draft to
// delete, a first email due on a later day as unthreaded drafts, due days in the event's zone, the overdue check, and
// the daily task's text and link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { world, ledgerLines, addLines, draftText, PEOPLE, NOW, OWN, EVENT, SLUG } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { SENTENCE } from '../lib/autosend/common.mjs';
import { heldQuery, heldFrom, draftsNext, draftsAnswer, draftIds, verifyDraft, labelCreated, dueLabel, sendsAtApproval, draftArgs, overdueDays, overdueQuery, overdueFrom, overdueWords } from '../lib/autosend/drafts.mjs';
import { htmlBody } from '../lib/autosend/sendrecord.mjs';
import { dailyTaskText, chatgptLink, STOP_CHECKS, LINK_WARN_AT, dayTime } from '../lib/autosend/dailytask.mjs';

const ANA = PEOPLE[0];
const env = (sc) => JSON.stringify({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: sc, isError: false });
const profile = env({ id: 'u1', name: 'Sam', email: OWN });
const gap = () => 20000;

function setup({ now = NOW, people = [ANA] } = {}) {
  const w = world({ touches: 2, people, event: { ...EVENT, autosend_mode: 'drafts' } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(now);
  const r = readback(w.evDir, nowMs);
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, nowMs);
  return { ...w, nowMs, rb: r };
}
const step = (w, s, answer, nowMs = w.nowMs) => {
  writeFileSync(s.write, answer);
  return draftsAnswer(w.HOME, { run: s.run, file: s.write, nowMs });
};
const next = (w, run, nowMs = w.nowMs) => draftsNext(w.HOME, { event: SLUG, run, nowMs, cli: ['node', 'cli.mjs'], gapOf: gap });
const readBack = (it, extra = {}) => env({ id: 'm2', thread_id: 't1', to: [it.to], cc: [], bcc: [], subject: it.subject, body: it.body, labels: ['DRAFT', 'Label_9'], ...extra });

// Runs a fresh run up to the first draft step; returns { w, s, run }.
function toDraft(opts) {
  const w = setup(opts);
  let s = next(w, 'new');
  assert.equal(s.step, 'profile');
  assert.equal(step(w, s, profile).then, 'run next');
  s = next(w, s.run);
  assert.equal(s.step, 'create_label');
  assert.deepEqual(s.args, { name: 'floorboss/due-2026-10-19' });
  step(w, s, env({ id: 'Label_9', name: 'floorboss/due-2026-10-19' }));
  s = next(w, s.run);
  assert.deepEqual(s.args, { name: 'floorboss/held-check' }, 'the label a draft gets when its own label is unclear');
  step(w, s, env({ id: 'Label_10', name: 'floorboss/held-check' }));
  s = next(w, s.run);
  assert.equal(s.step, 'search');
  step(w, s, env({ emails: [], next_page_token: null }));
  s = next(w, s.run);
  assert.equal(s.step, 'send');
  assert.equal(s.args.to, ANA.email);
  assert.equal(s.args.reply_message_id, undefined);
  step(w, s, env({ id: 'm1', thread_id: 't1' }));
  s = next(w, s.run);
  assert.equal(s.step, 'draft');
  return { w, s };
}

test('drafts: the first email due now is sent, its follow-up becomes a threaded labelled draft, read back, recorded', () => {
  const { w, s: d } = toDraft();
  const t2 = draftText(ANA, 2);
  assert.equal(d.args.reply_message_id, 'm1', 'a reply in the first email’s thread');
  assert.equal(d.args.subject, t2.subject);
  assert.equal(d.args.payload.body.content, htmlBody(t2.body), 'the same HTML body as the send');
  assert.match(d.tool, /gmail_create_draft$/);
  step(w, d, env({ id: 'r-123', message: { id: 'm2', thread_id: 't1' } }));
  let s = next(w, d.run);
  assert.equal(s.step, 'verify', 'the content is read back before the label');
  assert.deepEqual(s.args, { email_id: 'm2' });
  step(w, s, readBack({ to: ANA.email, subject: t2.subject, body: t2.body.replace(/\n/g, '\r\n'), labels: ['DRAFT'] }));
  s = next(w, d.run);
  assert.equal(s.step, 'label');
  assert.deepEqual(s.args.email_ids, ['m2']);
  assert.deepEqual(s.args.label_names, ['floorboss/due-2026-10-19']);
  step(w, s, env({ ok: true }));
  s = next(w, d.run);
  assert.equal(s.step, 'verify_label');
  step(w, s, readBack({ to: ANA.email, subject: t2.subject, body: t2.body }));
  s = next(w, d.run);
  assert.equal(s.step, 'done');
  assert.equal(s.summary.sent.length, 1);
  assert.deepEqual(s.summary.drafted.map((x) => [x.touch, x.due, x.draft_id, x.threaded]), [[2, '2026-10-19', 'r-123', true]]);
  const L = ledgerLines(w.evDir);
  assert.ok(L.some((e) => e.type === 'sent' && e.id === 'c001' && e.touch === 1 && e.message_id === 'm1' && e.thread_id === 't1'));
  assert.ok(L.some((e) => e.type === 'autosend_drafted' && e.touch === 2 && e.draft_id === 'r-123' && e.message_id === 'm2' && e.due === '2026-10-19'));
  // A second run has nothing left to do.
  const again = next(w, 'new');
  step(w, again, profile);
  assert.equal(next(w, again.run).step, 'done');
});

test('drafts: a read-back that differs from the approved text stops, naming the draft to delete', () => {
  for (const [what, extra] of [
    ['body', { body: 'Something else entirely' }],
    ['subject', { subject: 'Changed' }],
    ['to', { to: ['eve@evil.example'] }],
    ['cc', { cc: ['eve@evil.example'] }],
    ['thread', { thread_id: 't9' }]
  ]) {
    const { w, s: d } = toDraft();
    const t2 = draftText(ANA, 2);
    step(w, d, env({ id: 'r-77', message: { id: 'm2', thread_id: 't1' } }));
    const s = next(w, d.run);
    assert.equal(s.step, 'verify', what);
    const out = step(w, s, readBack({ to: ANA.email, subject: t2.subject, body: t2.body }, extra));
    assert.equal(out.step, 'stop', what);
    assert.match(out.why, /delete the draft r-77/, what);
    assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_draft_bad' && e.draft_id === 'r-77'), what);
    assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_drafted'), what);
  }
  // The label not shown after labelling: the draft is held with floorboss/held-check, then the run stops.
  const { w, s: d } = toDraft();
  const t2 = draftText(ANA, 2);
  step(w, d, env({ id: 'r-77', message: { id: 'm2', thread_id: 't1' } }));
  let s = next(w, d.run);
  step(w, s, readBack({ to: ANA.email, subject: t2.subject, body: t2.body }));
  s = next(w, d.run);
  step(w, s, env({ ok: true }));
  s = next(w, d.run);
  step(w, s, readBack({ to: ANA.email, subject: t2.subject, body: t2.body }, { labels: ['DRAFT'] }));
  s = next(w, d.run);
  assert.equal(s.step, 'hold');
  const out = step(w, s, env({ ok: true }));
  assert.equal(out.step, 'stop');
  assert.match(out.why, /delete the draft r-77/);
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_drafted'));
});

test('drafts: an answer floorboss can’t strictly read is a stop, never a go', () => {
  for (const ans of ['not json', env({ ok: true }), JSON.stringify({ content: [{ type: 'text', text: 'x' }], isError: true }), env({ id: 'r-1', error: 'nope' })]) {
    const { w, s: d } = toDraft();
    const out = step(w, d, ans);
    assert.equal(out.step, 'stop', ans);
    assert.match(out.why, /Drafts folder/);
  }
  // A draft step asked for twice without its answer: it may exist, so the run stops.
  const { w, s: d } = toDraft();
  assert.equal(next(w, d.run).step, 'stop');
  // The read tools, strictly.
  assert.ok(draftIds(env({ status: 'failed', id: 'x' })).why);
  assert.ok(labelCreated(env({ id: 'L1', name: 'other' }), 'floorboss/due-2026-10-19').why);
  assert.ok(labelCreated(JSON.stringify({ content: [{ type: 'text', text: 'Label name exists' }], isError: true }), 'x').ok, 'an existing label is fine');
  const it = { to: ANA.email, subject: 'S', body: 'B' };
  assert.match(verifyDraft(it, env({ to: [ANA.email], subject: 'S', snippet: 'B', labels: ['x'] }), { label: 'x' }).why, /no body/);
  assert.ok(verifyDraft(it, env({ to: [`Ana <${ANA.email}>`], subject: 'S', body_html: htmlBody('B'), labels: ['x'] }), { label: 'x' }).ok);
});

test('drafts: a reply before the first send holds the person; nothing is sent or drafted for them', () => {
  const w = setup();
  let s = next(w, 'new');
  step(w, s, profile);
  s = next(w, s.run);
  step(w, s, env({ id: 'Label_9', name: 'floorboss/due-2026-10-19' }));
  s = next(w, s.run);
  step(w, s, env({ id: 'Label_10', name: 'floorboss/held-check' }));
  s = next(w, s.run);
  step(w, s, env({ emails: [{ id: 'x', thread_id: 'y', from_: ANA.email, to: [OWN], subject: 'Re: hi', snippet: 'yes', labels: ['INBOX'], email_ts: NOW }], next_page_token: null }));
  s = next(w, s.run);
  assert.equal(s.step, 'done');
  assert.deepEqual(s.summary.sent, []);
  assert.deepEqual(s.summary.drafted, []);
});

test('drafts: a first email due on a later day is an unthreaded draft, and so are its follow-ups; the readback says so', () => {
  // Saturday 17 October: the first email is planned for Monday 19th.
  const w = setup({ now: '2026-10-17T10:00:00Z' });
  assert.match(w.rb.text, /Message 1 waits in Gmail as a draft until its day\. Its follow-ups arrive as separate emails/);
  let s = next(w, 'new');
  step(w, s, profile);
  const labels = [];
  for (;;) {
    s = next(w, s.run);
    if (s.step !== 'create_label') break;
    labels.push(s.args.name);
    step(w, s, env({ id: `L${labels.length}`, name: s.args.name }));
  }
  // Each draft's day is its planned day from the readback (the event's zone).
  assert.deepEqual(labels, [...w.rb.items.map((x) => `floorboss/due-${x.planned_day}`), 'floorboss/held-check']);
  assert.equal(labels[0], 'floorboss/due-2026-10-19');
  for (const t of [1, 2]) {
    assert.equal(s.step, 'draft');
    assert.equal(s.args.reply_message_id, undefined, 'unthreaded');
    const d = draftText(ANA, t);
    assert.equal(s.args.subject, d.subject);
    step(w, s, env({ draft_id: `r-${t}`, message_id: `m${t}`, thread_id: `t${t}` }));
    s = next(w, s.run);
    assert.equal(s.step, 'verify');
    step(w, s, env({ to: [ANA.email], subject: d.subject, body: d.body, labels: [] }));
    s = next(w, s.run);
    assert.equal(s.step, 'label');
    step(w, s, env({}));
    s = next(w, s.run);
    assert.equal(s.step, 'verify_label');
    step(w, s, env({ to: [ANA.email], subject: d.subject, body: d.body, labels: [`L${t}`] }));
    s = next(w, s.run);
  }
  assert.equal(s.step, 'done');
  assert.equal(s.summary.sent.length, 0);
});

test('drafts: the readback in drafts mode says a first email due now goes at approval', () => {
  const w = setup();
  assert.match(w.rb.text, /Message 1 is sent as soon as you approve\. Its follow-ups wait in Gmail as drafts in its thread/);
});

test('due days and sending hours are in the event time zone', () => {
  assert.equal(dueLabel('2026-10-19'), 'floorboss/due-2026-10-19');
  assert.throws(() => dueLabel('19/10/2026'));
  const lis = { time_zone: 'Europe/Lisbon' };
  // 16:30 UTC on Monday 12 October is 17:30 in Lisbon: hours closed, so the first email waits as a draft.
  assert.equal(sendsAtApproval(lis, '2026-10-12', '2026-10-12', Date.parse('2026-10-12T16:30:00Z')), false);
  assert.equal(sendsAtApproval(lis, '2026-10-12', '2026-10-12', Date.parse('2026-10-12T08:30:00Z')), true);
  assert.equal(sendsAtApproval({ time_zone: 'Pacific/Kiritimati' }, '2026-10-13', '2026-10-13', Date.parse('2026-10-12T20:30:00Z')), true, '10:30 Tuesday there');
  assert.equal(sendsAtApproval(lis, '2026-10-13', '2026-10-12', Date.parse('2026-10-12T08:30:00Z')), false, 'a later day');
  assert.deepEqual(Object.keys(draftArgs({ to: 'a@b.example', subject: 's', body: 'b' })).sort(), ['payload', 'response_fields', 'subject', 'to']);
});

test('the overdue check: drafts whose day went by, still drafts and not held, mean daily sending is paused', () => {
  const w = setup();
  addLines(w.evDir, [{ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-19', draft_id: 'r-1', message_id: 'm2', thread_id: 't1', threaded: true, run: 'r' }]);
  assert.deepEqual(overdueDays(w.evDir, Date.parse(NOW)), [], 'not overdue on the day it was made');
  assert.deepEqual(overdueDays(w.evDir, Date.parse('2026-10-20T08:00:00Z')), [], 'nor the morning after (its run may not have come yet)');
  assert.deepEqual(overdueDays(w.evDir, Date.parse('2026-10-21T08:00:00Z')), ['2026-10-19']);
  const q = overdueQuery(['2026-10-19']);
  assert.match(q, /^in:drafts \(label:floorboss-due-2026-10-19\)/);
  assert.match(q, /-label:floorboss-held-replied/);
  assert.equal(overdueQuery([]), null);
  const o = overdueFrom(env({ emails: [{ id: '1', labels: ['DRAFT'] }, { id: '2', labels: ['floorboss/held-check'] }, { id: '3', labels: [] }], next_page_token: null }));
  assert.equal(o.overdue, 2);
  assert.equal(o.say, "Daily sending looks paused: 2 emails are overdue. Open chatgpt.com, go to Scheduled, and resume 'floorboss daily sending'.");
  assert.equal(overdueFrom(env({ emails: [], next_page_token: null })).say, null);
  assert.ok(overdueFrom('nope').why);
  assert.match(overdueWords(1), /1 email is overdue/);
});

test('the daily task: one fixed time, the Part B rules, the stop checks as a list, no summary email, Always allow, Resume', () => {
  const t = dailyTaskText({ time: '9:00', zone: 'America/New_York', after: '2026-11-19' });
  assert.match(t, /^Create a scheduled task named "floorboss daily sending" that repeats EVERY DAY at 9:00 \(America\/New_York time\)\. Keep that one fixed time; never move or reschedule it\. Confirm the time/);
  assert.ok(!/<TIME>|<ZONE>|<STOP_CHECKS>/.test(t));
  // One date per run.
  assert.match(t, /fix TODAY as the current date in America\/New_York, as YYYY-MM-DD\. Use that one date for the whole run/);
  assert.match(t, /has no label starting floorboss\/held/);
  // Pagination and errors: every page, an error or an incomplete answer never sends, only a successful empty result is clear.
  assert.match(t, /List the Gmail drafts, following every page/);
  assert.match(t, /Follow every page of each search/);
  assert.match(t, /If a search errors or looks incomplete, do not send this draft: skip it this run, with no label, and report it\. Only a successful, empty result counts as clear/);
  // Order, one send per address, the checks right before each send.
  assert.match(t, /in order: due date, then step \(a first email before its follow-ups\), oldest first/);
  assert.match(t, /At most one send per address per run/);
  assert.match(t, /Immediately before sending, run every stop check/);
  assert.match(t, /never open or read any email, body or snippet/);
  // Lateness.
  assert.match(t, /more than 3 days before TODAY, apply the label floorboss\/held-late and do not send/);
  // Recipients.
  assert.match(t, /To must be exactly one plain email address, with none in Cc or Bcc\. Anything else .* floorboss\/held-check/);
  // The previous email.
  assert.match(t, /search in:sent to:<that address>\. It sends only if there is an earlier sent email to that address and the latest one went out at least 1 calendar day before TODAY\. Otherwise skip it for today, with no label, and report it as deferred/);
  // Send failure.
  assert.match(t, /If the send fails, do not retry: apply floorboss\/held-check/);
  assert.match(t, /send this exact draft with the send-draft tool, unchanged/);
  assert.match(t, /never create or delete drafts/);
  assert.match(t, /Never send a summary or report email/);
  // The stop checks, a list: reply (anywhere, since the first send, auto-replies too) and bounce.
  assert.match(t, /STOP CHECKS \(each only holds\):\n1\. Reply: search Gmail for from:<that address> in:anywhere -in:sent -in:drafts after:2026\/11\/19\. Any result holds, an auto-reply too: label floorboss\/held-replied\.\n2\. Bounce: search Gmail for from:\(mailer-daemon OR postmaster\) "<that address>" in:anywhere after:2026\/11\/19\. Any result holds: label floorboss\/held-bounced\./);
  assert.ok(!/newer_than/.test(t), 'no expiry on the searches');
  assert.equal(STOP_CHECKS.length, 2);
  assert.match(t, /Each check can only hold, never send/);
  assert.match(t, /click "Always allow"/);
  assert.match(t, /keep this chat.*If the task ever shows Paused, open Scheduled and click Resume/);
  assert.equal(dayTime('09:30'), '9:30');
  assert.throws(() => dayTime('25:00'));
  assert.throws(() => dailyTaskText({ zone: 'Not/AZone', after: '2026-11-19' }));
  assert.throws(() => dailyTaskText({ zone: 'America/New_York' }), /first-send date/);
});

test('the chatgpt.com link: the text round-trips, and a long one warns', () => {
  const t = dailyTaskText({ time: '9:00', zone: 'Europe/Lisbon', after: '2026-11-19' });
  const l = chatgptLink(t);
  assert.ok(l.url.startsWith('https://chatgpt.com/?q='));
  assert.equal(decodeURIComponent(new URL(l.url).search.slice(3)), t);
  assert.equal(new URL(l.url).searchParams.get('q'), t);
  assert.equal(l.warn, undefined, `the real text fits (${l.length})`);
  const long = chatgptLink('x '.repeat(LINK_WARN_AT));
  assert.match(long.warn, /over about 6000/);
});

test('the CLI: on --mode drafts, approve points at drafts next, daily-task prints the link and the file, Claude Code is refused', async () => {
  const { autosend, said } = await import('./fixtures/autosend-world.mjs');
  const { readFileSync } = await import('node:fs');
  const w = world({ touches: 2, people: [ANA] });
  const on = autosend(w.HOME, ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes, send them'), '--own', OWN, '--mode', 'drafts']);
  assert.equal(on.mode, 'drafts', JSON.stringify(on));
  const rb = autosend(w.HOME, ['readback', '--event', SLUG]);
  assert.match(rb.text, /Message 1 is sent as soon as you approve/);
  const ap = autosend(w.HOME, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', said(w.HOME, SENTENCE)]);
  assert.match(ap.next, /drafts next --event harbor-expo --run new/, JSON.stringify(ap));
  const s = autosend(w.HOME, ['drafts', 'next', '--event', SLUG, '--run', 'new']);
  assert.equal(s.step, 'profile', JSON.stringify(s));
  assert.equal(s.then.slice(-6).join(' '), `drafts answer --run ${s.run} --file ${s.write}`);
  const d = autosend(w.HOME, ['daily-task', '--zone', 'Europe/Lisbon', '--time', '9:30']);
  assert.match(d.link, /^https:\/\/chatgpt\.com\/\?q=/);
  assert.equal(readFileSync(d.file, 'utf8').trim(), d.text.trim());
  assert.match(d.text, /EVERY DAY at 9:30 \(Europe\/Lisbon time\)/);
  assert.equal(d.searches_after, '2026-10-11', 'the day before the first yes');
  assert.match(d.text, /after:2026\/10\/11/);
  assert.match(d.show, /Always allow/);
  assert.ok(autosend(w.HOME, ['daily-task', '--zone', 'America/New_York'], { claude: true }).ERROR);
});

test('the CLI: status gives the overdue search first, and overdue-checked says daily sending looks paused', async () => {
  const { autosend, said } = await import('./fixtures/autosend-world.mjs');
  const w = world({ touches: 2, people: [ANA] });
  autosend(w.HOME, ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes'), '--own', OWN, '--mode', 'drafts']);
  assert.equal(autosend(w.HOME, ['status']).overdue_check, undefined, 'nothing drafted: no check');
  addLines(w.evDir, [{ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-19', draft_id: 'r-1', message_id: 'm2', thread_id: 't1', threaded: true, run: 'r' }]);
  const st = autosend(w.HOME, ['status'], { now: '2026-10-21T09:00:00Z' });
  assert.equal(st.overdue_check.step, 'search', JSON.stringify(st).slice(0, 400));
  assert.match(st.overdue_check.args.query, /label:floorboss-due-2026-10-19/);
  writeFileSync(st.overdue_check.write, env({ emails: [{ id: 'm2', labels: ['DRAFT'] }], next_page_token: null }));
  const o = autosend(w.HOME, st.overdue_check.then.slice(st.overdue_check.then.indexOf('overdue-checked')), { now: '2026-10-21T09:00:00Z' });
  assert.equal(o.say, "Daily sending looks paused: 1 email is overdue. Open chatgpt.com, go to Scheduled, and resume 'floorboss daily sending'.");
  assert.match(st.held_check.args.query, /label:floorboss-held-check/);
  writeFileSync(st.held_check.write, env({ emails: [{ id: 'm2', labels: ['floorboss/held-bounced'] }], next_page_token: null }));
  const hc = autosend(w.HOME, st.held_check.then.slice(st.held_check.then.indexOf('held-checked')), { now: '2026-10-21T09:00:00Z' });
  assert.match(hc.say, /1 draft is held after a bounce from that address/);
});

test('the cloud planner never sends from an event that goes through Gmail drafts', async () => {
  const { dueNow } = await import('../lib/autosend/plan.mjs');
  const w = setup();
  const p = dueNow(w.HOME, w.nowMs);
  assert.deepEqual(p.due, []);
  assert.match(p.waits[0].why, /Gmail drafts/);
});

test('the held check: drafts the daily task held for check, late or bounce are reported with what to do', () => {
  assert.equal(heldQuery(), 'in:drafts (label:floorboss-held-check OR label:floorboss-held-late OR label:floorboss-held-bounced)');
  const o = heldFrom(env({ emails: [{ id: '1', labels: ['floorboss/held-late'] }, { id: '2', labels: ['floorboss/held-late'] }, { id: '3', labels: ['floorboss/held-check'] }, { id: '4', labels: ['Label_77'] }], next_page_token: null }));
  assert.deepEqual(o.held, { check: 1, late: 2, bounced: 0, other: 1 });
  assert.match(o.say, /1 draft is held for a check \(an address that looked wrong, or a send that failed\)/);
  assert.match(o.say, /2 drafts are held as more than 3 days overdue/);
  assert.match(o.say, /1 draft is held by the daily task/);
  assert.equal(heldFrom(env({ emails: [], next_page_token: null })).say, null);
  assert.ok(heldFrom('x').why);
  assert.match(overdueQuery(['2026-10-19']), /-label:floorboss-held-late/);
});
