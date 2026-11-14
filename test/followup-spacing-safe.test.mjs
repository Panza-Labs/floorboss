// No branch of the rule can send a follow-up sooner than its gap after the real send, on the send day itself, on a
// weekend in a plan made off weekends, or after the event's last day: every day goes through one checked return
// (settle). And one sequence never holds days from two plans: re-planning a message re-plans the follow-ups after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, idOf, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { followupDay, settle, ruleAfter, plannedDays, modeFor } from '../lib/spacing.mjs';
import { addDays, daysBetween } from '../lib/tz.mjs';

const weekend = (k) => [0, 6].includes(new Date(`${k}T12:00:00Z`).getUTCDay());
const gapAt = (s, e, prevSent, touch) => ruleAfter(s, e, prevSent, touch, false).floor;
// A small seeded random, so a failure can be run again.
function rng(seed) {
  let x = seed;
  return (n) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
}

test('property: whatever day a branch offers, settle returns only a day that keeps all four conditions', () => {
  const r = rng(7);
  let checked = 0,
    replaced = 0;
  for (let i = 0; i < 200000; i++) {
    const start = addDays('2026-10-01', r(90));
    const e = { time_zone: 'Europe/Amsterdam', start_date: start, end_date: addDays(start, r(5)) };
    const prevSent = addDays(start, -r(40) + 3);
    const s = { followup_gap: r(3) ? [1 + r(14)] : null };
    const rule = ruleAfter(s, e, prevSent, 2 + r(5), !!r(2));
    // Any candidate at all: before the send, on it, a weekend, past the end, null.
    const candidate = r(10) ? addDays(prevSent, r(40) - 10) : null;
    const out = settle(e, prevSent, rule, candidate);
    checked++;
    if (out.day !== candidate) replaced++;
    if (!out.day) continue;
    assert.ok(out.day > prevSent && out.day >= addDays(prevSent, rule.floor) && !(rule.weekdays && weekend(out.day)) && out.day <= e.end_date, JSON.stringify({ e, prevSent, rule, candidate, out }));
  }
  assert.ok(checked === 200000 && replaced > 10000, `${replaced} candidates replaced`);
});

test('property: mixed plans, hand-edited planned days, moved events and early or late sends never give a day that breaks the rule', () => {
  const r = rng(11);
  let days = 0;
  for (let i = 0; i < 200000; i++) {
    const start = addDays('2026-10-05', r(80));
    const planEnd = addDays(start, r(4));
    // The event as it is now: moved earlier or later than when the plan was made, or not at all.
    const shift = [0, 0, -3, -7, 2, 6][r(6)];
    const e = { time_zone: ['Europe/Amsterdam', 'Pacific/Auckland', 'America/Los_Angeles'][r(3)], start_date: addDays(start, shift), end_date: addDays(planEnd, shift) };
    const gap = [null, [1], [2], [3], [5], [7], [2, 5]][r(7)];
    const s = { followup_gap: gap };
    const key = gap ? gap.join(',') : 'table';
    const touch = 2 + r(4);
    const prevPlanned = addDays(start, -r(30) - 1);
    const prevSent = addDays(prevPlanned, r(9) - 3); // early, on time or late
    // The follow-up's plan: from the same plan, another plan, or a day typed by hand (any day, weekend or not).
    const planned_due = [addDays(prevPlanned, 1 + r(10)), addDays(prevPlanned, -r(5)), addDays(start, r(6) - 3)][r(3)];
    const o = {
      prevSent,
      touch,
      planned_due,
      planned_gap: r(4) ? key : 'table',
      planned_from: [prevPlanned, addDays(prevPlanned, r(7) - 3), undefined][r(3)],
      prev_planned_due: r(5) ? prevPlanned : undefined,
      prev_planned_gap: r(4) ? key : '9'
    };
    const out = followupDay(s, e, o);
    if (!out.day) continue;
    days++;
    const floor = gapAt(s, e, prevSent, touch);
    const why = JSON.stringify({ e, gap, o, out });
    assert.ok(out.day > prevSent, `on or before the send: ${why}`);
    assert.ok(out.day >= addDays(prevSent, floor), `sooner than its gap after the real send: ${why}`);
    assert.ok(!weekend(out.day), `on a weekend in a plan made off weekends: ${why}`);
    assert.ok(out.day <= e.end_date, `after the event's last day: ${why}`);
  }
  assert.ok(days > 50000, `${days} days checked`);
});

test('the planned day stands only for one plan: another plan, a plan not made with today\'s gaps, or a raw planned day never skips the rule', () => {
  const e = { name: 'Expo', time_zone: 'Europe/Amsterdam', start_date: '2026-10-14', end_date: '2026-10-16' };
  // Gap 2 now; message 2 went on time on Wed 14 (the last-day band, where no new follow-up starts).
  const base = { prevSent: '2026-10-14', touch: 3, planned_due: '2026-10-16', planned_gap: '2', planned_from: '2026-10-14', prev_planned_due: '2026-10-14', prev_planned_gap: '2' };
  assert.equal(followupDay({ followup_gap: [2] }, e, base).day, '2026-10-16', 'one plan, on time: the planned day stands');
  // The message before it was planned with other gaps: the plan doesn't hold, so no follow-up that close.
  assert.deepEqual(followupDay({ followup_gap: [2] }, e, { ...base, prev_planned_gap: 'table' }), { day: null, why: 'last', waits: false, planned: '2026-10-16' });
  // This follow-up was planned with other gaps: its planned_due isn't a planned day now.
  assert.equal(followupDay({ followup_gap: [2] }, e, { ...base, planned_gap: 'table' }).day, null);
  // Counted from another day than the planned day of the message before it (F1): not one plan.
  assert.equal(followupDay({ followup_gap: [2] }, e, { ...base, planned_from: '2026-10-13' }).day, null);
  // Older plans without planned_from: at least the gap after the previous planned day.
  assert.equal(followupDay({ followup_gap: [2] }, e, { ...base, planned_from: undefined }).day, '2026-10-16');
  assert.equal(followupDay({ followup_gap: [2] }, e, { ...base, planned_from: undefined, planned_due: '2026-10-15' }).day, null);
  // The event moved earlier: a planned day past its new last day is never returned.
  assert.equal(followupDay({ followup_gap: [2] }, { ...e, end_date: '2026-10-15' }, base).day, null);
});

test('the lead time is read on the event\'s own date: far east of UTC, a sequence approved two days out gets its follow-ups, as the released code planned', () => {
  for (const zone of ['Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Kiritimati', 'Europe/Amsterdam', 'America/Los_Angeles']) {
    const e = { name: 'Expo', time_zone: zone, start_date: '2026-11-11', end_date: '2026-11-13' };
    const plan = plannedDays({}, e, '2026-11-09', modeFor(daysBetween('2026-11-09', '2026-11-11')), 3);
    assert.deepEqual(plan.map((p) => p.due), ['2026-11-11', '2026-11-13'], zone);
  }
});

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

function ready(n, event, gap = null) {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', event, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: Array(n).fill('email') } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, ...(gap ? { followup_gap: gap } : {}) }));
  if (event?.start_date) {
    const day = event.end_date;
    writeFileSync(join(H.dir, 'slots.json'), JSON.stringify({ slots: [{ id: 's1', start: `${day}T15:00:00Z`, end: `${day}T15:30:00Z` }, { id: 's2', start: `${day}T16:00:00Z`, end: `${day}T16:30:00Z` }] }));
  }
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
// Draft (the first message with an extra line when asked), pass and approve everything todo hands out, in rounds, as
// the flow does: a follow-up is written once the message before it passed.
function approveRounds(H, now, extra = '') {
  for (let i = 0; i < 4; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => x.kind === 'message' && !x.waits_for_previous)) {
      const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      const body = j.touch === 1 && extra ? `${d.body.replace(/\n\nBest, Sam/, ` ${extra}\n\nBest, Sam`)}` : d.body;
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], now);
      cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
// Every day from `from` for `days` days: send what send-list lists through the guard (twice a day, so a second
// follow-up made due by the first one's send would show), and record what went, by day.
function sendDays(H, from, days, only = null) {
  const went = {};
  for (let k = 0; k < days; k++) {
    const day = addDays(from, k);
    for (const hh of ['08:00', '08:05']) {
      const now = at(day, hh);
      cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
      const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
      const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
      for (const it of items)
        if (guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0) {
          cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: it.id, touch: it.touch, message_id: `m${it.touch}` }] })], now);
          if (!only || it.id === only) (went[day] ||= []).push(it.touch);
        }
    }
  }
  return went;
}
const noSameDay = (went) => Object.entries(went).forEach(([d, ts]) => assert.ok(ts.length === 1, `two messages on ${d}: ${ts}`));

test('F1: message 1 rewritten days after approval: follow-up 2 is planned again from follow-up 1, never sent the same day', () => {
  const H = ready(3, { start_date: '2026-11-17', end_date: '2026-11-19' }, [3]);
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H, NOW);
  const fb = join(H.dir, 'work', 'fb.txt');
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  writeFileSync(fb, 'make it a bit warmer');
  assert.ok(!cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', fb], at('2026-10-16')).ERROR);
  approveRounds(H, at('2026-10-16'), 'Happy to work around your day.');
  const went = sendDays(H, '2026-10-16', 12);
  noSameDay(went);
  assert.deepEqual(went, { '2026-10-16': [1], '2026-10-19': [2], '2026-10-22': [3] }, JSON.stringify(went));
  const replanned = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'replanned');
  assert.deepEqual(replanned.map((e) => [e.touch, e.planned_due, e.planned_from]), [[3, '2026-10-22', '2026-10-19']]);
});

test('F1 on the default: approved Mon 12 Oct, message 1 rewritten Mon 19: a week apart from then on', () => {
  const H = ready(3, { start_date: '2026-11-17', end_date: '2026-11-19' });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H, NOW);
  const fb = join(H.dir, 'work', 'fb.txt');
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  writeFileSync(fb, 'make it a bit warmer');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', fb], at('2026-10-19'));
  approveRounds(H, at('2026-10-19'), 'Happy to work around your day.');
  const went = sendDays(H, '2026-10-19', 16);
  noSameDay(went);
  assert.deepEqual(went, { '2026-10-19': [1], '2026-10-26': [2], '2026-11-02': [3] }, JSON.stringify(went));
});

test('Finding A end to end: event Wed 14 to Fri 16 Oct, every message on its planned day goes, message 3 on Fri 16; sent late, it is held with the real reason', () => {
  const H = ready(3, { start_date: '2026-10-14', end_date: '2026-10-16' });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H, NOW);
  assert.deepEqual(sendDays(H, '2026-10-12', 5), { '2026-10-12': [1], '2026-10-14': [2], '2026-10-16': [3] });
  // The same sequence with message 2 a day late (Thu 15): message 3 doesn't start that close, and every reader says why.
  const L = ready(3, { start_date: '2026-10-14', end_date: '2026-10-16', slug: 'late' });
  approveRounds(L, NOW);
  sendDays(L, '2026-10-12', 1);
  sendDays(L, '2026-10-15', 1);
  cli(L, 'event-outreach', ['status', '--event', L.slug, '--none', '--said', 'nobody replied'], at('2026-10-16'));
  const list = cli(L, 'event-outreach', ['send-list', '--event', L.slug, '--no-reply-check', 'nobody answered'], at('2026-10-16'));
  assert.ok(list.waiting.some((w) => w.touch === 3 && /no follow-up starts that close to the event/.test(w.why)), JSON.stringify(list.waiting));
  const d = JSON.parse(readFileSync(join(L.dir, 'work', 'drafts', `${idOf(L, 'Ana Berg')}-t3.json`), 'utf8'));
  writeFileSync(join(L.dir, 'derived', 'send-list.json'), JSON.stringify([{ id: idOf(L, 'Ana Berg'), touch: 3, via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: at('2026-10-16') }]));
  const g = guard(L, { to: 'ana@acme.test', subject: d.subject || '', body: d.body }, at('2026-10-16'));
  assert.equal(g.status, 2);
  assert.match(g.stderr, /no follow-up starts that close to the event/);
  assert.ok(ana);
});

test('an event moved earlier never gets a planned day past its new end; moved later, on-time sends keep their planned days', () => {
  const E = ready(4, {});
  approveRounds(E, NOW);
  // Planned 19 Oct, 26 Oct, 2 Nov; then the event moves to Tue 27 to Wed 28 Oct.
  const ev = JSON.parse(readFileSync(join(E.dir, 'event.json'), 'utf8'));
  writeFileSync(join(E.dir, 'event.json'), JSON.stringify({ ...ev, start_date: '2026-10-27', end_date: '2026-10-28' }));
  const went = sendDays(E, '2026-10-12', 18);
  assert.deepEqual(went, { '2026-10-12': [1], '2026-10-19': [2], '2026-10-26': [3] }, JSON.stringify(went));
  const Lt = ready(4, { slug: 'later' });
  approveRounds(Lt, NOW);
  const ev2 = JSON.parse(readFileSync(join(Lt.dir, 'event.json'), 'utf8'));
  writeFileSync(join(Lt.dir, 'event.json'), JSON.stringify({ ...ev2, start_date: '2026-11-20', end_date: '2026-11-22' }));
  assert.deepEqual(sendDays(Lt, '2026-10-12', 25), { '2026-10-12': [1], '2026-10-19': [2], '2026-10-26': [3], '2026-11-02': [4] });
});

const say = (H, words, now) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(join(H.HOME, 'work', 'gap.json'), JSON.stringify(words));
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', 'followup_gap', '--value-file', join(H.HOME, 'work', 'gap.json')], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
  return r.status ? { ERROR: r.stderr, note: '' } : JSON.parse(r.stdout).result;
};

test('the answer reads each plan as the send list does (the previous plan included), and names a day only once the message before has gone', () => {
  const H = ready(3, { start_date: '2026-10-14', end_date: '2026-10-16' }, [2]);
  approveRounds(H, NOW);
  sendDays(H, '2026-10-12', 1);
  const r = say(H, '3 days', NOW);
  // Follow-up 1 counts from a real send: a day. Follow-up 2's message before hasn't gone: its gap, then dropped.
  assert.match(r.note, /Ana Berg follow-up 1: Wed 14 Oct → Thu 15 Oct/, r.note);
  assert.match(r.note, /Ana Berg follow-up 2: 2 days after message 2 goes → dropped \(no room left before the event\)/, r.note);
  assert.match(r.note, /counted as going today \(a first message\) or on its own day; a later send moves the days after it/);
});

test('the answer counts a day already past as today: an overdue follow-up moves the one after it from today', () => {
  const H = ready(3, {});
  approveRounds(H, NOW);
  sendDays(H, '2026-10-12', 1);
  // Follow-up 1 was due Mon 19 Oct and still hasn't gone on Fri 23: follow-up 2 counts from today.
  const r = say(H, 'a week', at('2026-10-23'));
  assert.match(r.note, /Ana Berg follow-up 2: 4 days after message 2 goes → 7 days after message 2 goes/, r.note);
  assert.doesNotMatch(r.note, /follow-up 1:/, 'two days already due are no move');
});

test('a gap answer after the event is over says so plainly', () => {
  const H = ready(3, { start_date: '2026-10-14', end_date: '2026-10-16' });
  const r = say(H, '3 days', at('2026-10-20'));
  assert.match(r.note, /Test Expo is over, so this changes nothing there/, r.note);
});
