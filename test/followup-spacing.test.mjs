// The days between follow-ups: the lead-time table decides unless the user says otherwise, in plain words, and
// every place that shows or checks a follow-up's day (todo, the outbox, send-list, the guard) agrees on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { levelAllows, NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const SENDING = { channels: ['email'], followups: 'scheduled', linkedin_ack: false };
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,VP Ops,Initech,cy@initech.test\n';
const at = (day) => `${day}T08:00:00Z`;
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

// An event with sending on by email, and a route of `n` emails (n - 1 follow-ups), triaged on the harness clock.
function ready(n = 4, now = NOW) {
  const H = setup({ attendees: LIST, settings: { sending: SENDING, route: Array(n).fill('email') } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug], now);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')], now);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults'], now);
  return H;
}
// The user's words, saved as the flow saves an answer.
const say = (H, words, now = NOW, env = {}) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'gap.json');
  writeFileSync(f, JSON.stringify(words));
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', 'followup_gap', '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 800) };
  return JSON.parse(r.stdout);
};
const gapNow = (H) => cli(H, 'event-context', ['config', '--get', 'followup_gap']);
const planned = (H, name, now = NOW) =>
  todoJobs(H, now).jobs.filter((j) => j.id === idOf(H, name) && j.kind === 'message' && j.touch > 1).map((j) => [j.touch, j.planned_due]);
// Send what send-list lists, through the guard, then record the receipts.
function sendListed(H, now, extra = []) {
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, ...extra], now);
  const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
  const sends = [];
  for (const it of items) if (guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0) sends.push({ id: it.id, touch: it.touch, message_id: `m-${it.id}-${it.touch}` });
  if (sends.length) cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })], now);
  return { list, items, sends: sends.map((s) => [s.id, s.touch]) };
}

test('nothing said: the lead-time table still decides, and the plan card says which spacing that is', () => {
  const H = ready(4);
  assert.equal(gapNow(H), null, 'no gap of the user\'s own');
  // 29 days out: a week apart, each moved off the weekend, all three before the event.
  assert.deepEqual(planned(H, 'Ana Berg'), [[2, '2026-10-19'], [3, '2026-10-26'], [4, '2026-11-02']]);
  const p = cli(H, 'crm-triage', ['plan', '--event', H.slug]);
  assert.equal(p.follow_up, '2026-10-19');
  assert.match(p.follow_up_spacing, /7 days apart/);
  assert.match(p.follow_up_spacing, /how far off the event is/);
});

test('each plain-words answer is read into whole days, and "the default" goes back to the table', () => {
  const H = ready(4);
  for (const [words, want] of [
    ['3 days between follow-ups', [3]],
    ['a week apart', [7]],
    ['2 days, then 5', [2, 5]],
    ['every 4 days', [4]],
    ['two days', [2]],
    ['one week, then two weeks', [7, 14]],
    ['5', [5]],
    [[2, 5], [2, 5]],
    ['back to the default', null],
    ['3 days', [3]],
    ['the default', null]
  ]) {
    const r = say(H, words);
    assert.ok(!r.ERROR, `${JSON.stringify(words)}: ${r.ERROR}`);
    assert.deepEqual(gapNow(H), want, JSON.stringify(words));
    assert.match(r.result.note, want ? new RegExp(`${want[0]} days?`) : /how far off the event is/, r.result.note);
  }
  say(H, '2 days, then 5');
  // The last gap carries on for the steps after it.
  assert.deepEqual(planned(H, 'Ana Berg'), [[2, '2026-10-14'], [3, '2026-10-19'], [4, '2026-10-26']]);
});

test('an answer it can\'t read is refused, says what to type, and changes nothing', () => {
  const H = ready(3);
  const first = say(H, 'soon');
  assert.match(first.ERROR, /whole days/);
  const ob = () => (existsSync(join(H.HOME, 'onboarding.json')) ? readFileSync(join(H.HOME, 'onboarding.json'), 'utf8') : '');
  assert.ok(!ob().includes('followup_gap_asked'), 'still unanswered');
  assert.ok(!say(H, '3 days').ERROR);
  assert.ok(ob().includes('followup_gap_asked'));
  for (const words of ['a few days', '3 or 4 days', '3-4 days', '12 hours', 'whenever', 'a month', '']) {
    const r = say(H, words);
    assert.match(r.ERROR || '', /whole days/, JSON.stringify(words));
    assert.match(r.ERROR, /"3 days"/);
    assert.match(r.ERROR, /"the default"/);
    assert.deepEqual(gapNow(H), [3], `${JSON.stringify(words)} left the gap as it was`);
  }
});

test('limits: whole days from 1 to 14, at most one gap per follow-up; the same limits hold for a setting written directly', () => {
  const H = ready(3);
  assert.match(say(H, '0 days').ERROR, /at least 1 day/);
  assert.match(say(H, '15 days').ERROR, /at most 14 days/);
  assert.match(say(H, '3 weeks').ERROR, /at most 14 days/);
  assert.match(say(H, '1.5 days').ERROR, /whole days/);
  assert.match(say(H, '1, 1, 1, 1, 1, 1, 1, 1').ERROR, /At most 7 gaps/);
  assert.equal(gapNow(H), null);
  assert.ok(!say(H, '14 days').ERROR);
  assert.ok(!say(H, '1 day').ERROR);
  assert.deepEqual(gapNow(H), [1]);
  assert.match(cli(H, 'event-context', ['config', '--set', JSON.stringify({ followup_gap: 30 })]).ERROR, /at most 14 days/);
  assert.match(cli(H, 'event-context', ['config', '--set', JSON.stringify({ followup_gap: [2, 'x'] })]).ERROR, /whole days/);
  assert.ok(!cli(H, 'event-context', ['config', '--set', JSON.stringify({ followup_gap: [2, 5] })]).ERROR);
  assert.deepEqual(gapNow(H), [2, 5]);
});

test('near the event a gap is never shortened: a follow-up that would land after the last day is dropped, and the answer says which', () => {
  const near = at('2026-11-05');
  const H = ready(4, near);
  // The table, 5 days out: 2 days apart (the Saturday moved to Monday), two follow-ups fit.
  assert.deepEqual(planned(H, 'Ana Berg', near), [[2, '2026-11-09'], [3, '2026-11-11']]);
  const five = say(H, '5 days', near);
  assert.ok(!five.ERROR, five.ERROR);
  assert.match(five.result.note, /1 of the 3 follow-ups fits/);
  assert.match(five.result.note, /follow-ups 2 and 3 are dropped/);
  assert.deepEqual(planned(H, 'Ana Berg', near), [[2, '2026-11-10']]);
  const ten = say(H, '10 days', near);
  assert.match(ten.result.note, /none of the 3 follow-ups fits/);
  assert.deepEqual(planned(H, 'Ana Berg', near), []);
  // A day or less before the event there are no follow-ups at all, whatever the gap (as with the table).
  const last = at('2026-11-09');
  const one = say(H, '1 day', last);
  assert.match(one.result.note, /a day or less/);
  assert.deepEqual(planned(H, 'Ana Berg', last), []);
});

test('quick setup never asks it; the setup question is one id at full setup, and the answer is taken at any step', () => {
  const node = NODES.find((n) => n.id === 'followup_gap');
  assert.ok(node, 'one question id');
  assert.ok(!levelAllows('followup_gap', 'quick') && !levelAllows('followup_gap', 'standard') && levelAllows('followup_gap', 'full'));
  // Quick setup's summary says what spacing it keeps.
  const H = ready(3);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(join(H.HOME, 'work', 'level.txt'), 'quick');
  const q = cli(H, 'flow', ['answer', '--ask', 'setup_level', '--value-file', join(H.HOME, 'work', 'level.txt')]);
  assert.match(q.result.assumes, /follow-ups.*how far off the event is/i);
  // Out of turn, as a real run would save it ("3 days between follow-ups" said at the shortlist, or later).
  const r = say(H, '3 days between follow-ups', NOW, { FLOORBOSS_OUT_OF_TURN: '' });
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(gapNow(H), [3]);
});

test('the due day agrees across todo, the outbox, send-list and the guard', () => {
  const H = ready(3);
  assert.ok(!say(H, '3 days').ERROR);
  const ana = idOf(H, 'Ana Berg');
  // Monday 12 Oct, then 3 days: Thursday 15 Oct; then 3 more lands on the Sunday, so Monday 19 Oct.
  assert.deepEqual(planned(H, 'Ana Berg'), [[2, '2026-10-15'], [3, '2026-10-19']]);
  draftApprove(H);
  const first = sendListed(H, NOW);
  assert.ok(first.sends.some(([id, t]) => id === ana && t === 1), JSON.stringify(first.list));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open']);
  const card = (html, id) => html.slice(html.indexOf(`data-id="${id}"`), html.indexOf('</article>', html.indexOf(`data-id="${id}"`)));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(card(html, ana), /planned for 2026-10-15/);
  // The day before: not listed, and a list written by hand for it doesn't get past the guard.
  const d14 = at('2026-10-14');
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], d14);
  const early = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], d14);
  assert.equal(early.to_send, 0, JSON.stringify(early));
  const d15 = at('2026-10-15');
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], d15);
  const due = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], d15);
  const items = JSON.parse(readFileSync(due.file, 'utf8'));
  const it = items.find((x) => x.id === ana);
  assert.equal(it?.touch, 2, JSON.stringify(due));
  writeFileSync(due.file, JSON.stringify([{ ...it, listed_at: d14 }]));
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], d14);
  const g = guard(H, { to: it.to, subject: it.subject, body: it.body }, d14);
  assert.equal(g.status, 2, 'the guard works out the same day');
  assert.match(g.stderr, /isn't due until Thursday 15 October, Rotterdam time/);
});

test('changed after approval: approved follow-ups keep their text and go on the new spacing from the last send, never to someone who replied or said stop, never twice', () => {
  const H = ready(3);
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li'), cy = idOf(H, 'Cy Ng');
  // Approved on the table: a week apart.
  assert.deepEqual(planned(H, 'Ana Berg'), [[2, '2026-10-19'], [3, '2026-10-26']]);
  draftApprove(H);
  assert.equal(sendListed(H, NOW).sends.length, 3);
  const r = say(H, '2 days');
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.result.note, /approved/i, 'says what happens to follow-ups already approved');
  // Still approved: no new approval, the same text, now due 2 days after the first message went.
  const d13 = at('2026-10-13'), d14 = at('2026-10-14');
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], d13);
  assert.equal(cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nobody answered'], d13).to_send, 0, 'not before its day');
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Bo Li', what: 'replied' }, { who: 'Cy Ng', what: 'stop' }] })], d14);
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody else replied'], d14);
  const second = sendListed(H, d14, ['--no-reply-check', 'nothing connected; nobody else answered']);
  assert.deepEqual(second.sends, [[ana, 2]], JSON.stringify(second.list));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], d14);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const card = html.slice(html.indexOf(`data-id="${ana}"`), html.indexOf('</article>', html.indexOf(`data-id="${ana}"`)));
  assert.match(card, /planned for 2026-10-16/, 'the outbox shows the new day of the next one');
  // Changed again: nothing already sent goes again; the next one counts from its own last send.
  assert.ok(!say(H, 'a week', d14).ERROR);
  const d20 = at('2026-10-20'), d21 = at('2026-10-21');
  for (const d of [d20, d21]) cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody else replied'], d);
  assert.deepEqual(sendListed(H, d20, ['--no-reply-check', 'nobody answered']).sends, [], 'a week after the 14th is the 21st');
  const third = sendListed(H, d21, ['--no-reply-check', 'nobody answered']);
  assert.deepEqual(third.sends, [[ana, 3]], JSON.stringify(third.list));
  for (const p of [bo, cy]) assert.ok(!third.items.some((x) => x.id === p), 'never to someone who replied or said stop');
  const after = sendListed(H, at('2026-10-28'), ['--no-reply-check', 'nobody answered']);
  assert.deepEqual(after.sends, [], 'nothing goes twice');
});
