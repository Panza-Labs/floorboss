// The edges of the one rule: nothing goes once the event is over (in its own time), a step recorded out of order counts
// as the latest send, a re-planned day is the day every reader uses, the guard reads the day in the event's zone, and
// the small cases a mutation of the rule would let through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, idOf, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { followupDay, settle, ruleAfter } from '../lib/spacing.mjs';
import { taskItems } from '../skills/event-outreach/scripts/tracking.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);

function ready({ route = ['email', 'email'], event = {}, gap = null, settings = {}, slots = null, attendees = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n' } = {}) {
  const H = setup({ attendees, event, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route, ...settings } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, ...(gap ? { followup_gap: gap } : {}) }));
  if (slots) writeFileSync(join(H.dir, 'slots.json'), JSON.stringify({ slots }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
function approveRounds(H, now = NOW, extra = '') {
  for (let i = 0; i < 4; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => x.kind === 'message' && !x.waits_for_previous)) {
      const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      // Leave room for a shorter third message in the four-touch sequences.
      const note = j.touch === 2 && !j.last_touch ? 'We could compare shift handoffs.' : j.touch === 1 ? extra : '';
      const body = note ? d.body.replace(/\n\nBest, Sam/, ` ${note}\n\nBest, Sam`) : d.body;
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) })], now);
      cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
// Send what send-list lists through the guard and record it; the touches that went.
function sendNow(H, now) {
  nobody(H, now);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
  const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
  const went = [];
  for (const it of items)
    if (guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0) {
      cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: it.id, touch: it.touch, message_id: `m${it.touch}` }] })], now);
      went.push(it.touch);
    }
  return { list, went };
}
// A send list written by hand for one approved email (what a session could write), then the real guard on it.
function handListed(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([{ id, touch, name: 'x', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now }]));
  nobody(H, now);
  return guard(H, { to: 'ana@acme.test', subject: d.subject || '', body: d.body }, now);
}

test('A: once the event is over in its own time, nothing is listed, let through, made a task or shown as due', () => {
  // Auckland: Fri 16 Oct there ends at 11:00 UTC the same day, while the UTC date is still the 16th.
  const event = { time_zone: 'Pacific/Auckland', start_date: '2026-10-16', end_date: '2026-10-16', app_name: 'Grip' };
  const H = ready({ event, slots: [] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.deepEqual(sendNow(H, NOW).went, [1]);
  for (const now of ['2026-10-16T12:00:00Z', '2026-10-19T08:00:00Z', '2026-10-30T08:00:00Z']) {
    const { list, went } = sendNow(H, now);
    assert.deepEqual(went, [], now);
    assert.ok(list.waiting.some((w) => w.touch === 2 && /the event is over/.test(w.why)), `${now}: ${JSON.stringify(list.waiting)}`);
    const g = handListed(H, ana, 2, now);
    assert.equal(g.status, 2, now);
    assert.match(g.stderr, /the event is over/);
    const s = cli(H, 'event-outreach', ['summary', '--event', H.slug], now);
    assert.deepEqual(s.follow_ups_due, [], now);
    assert.match(s.note, /is over: nothing more is sent/);
  }
  // On its last day (23:00 there, 10:00 UTC) the overdue follow-up still goes.
  const L = ready({ event: { ...event, slug: 'last' }, slots: [] });
  approveRounds(L);
  sendNow(L, NOW);
  assert.deepEqual(sendNow(L, '2026-10-16T10:00:00Z').went, [2]);
});

test('A: no CRM send task after the event, for a note the user sends by hand', () => {
  const H = ready({ route: ['email', 'app'], event: { time_zone: 'Pacific/Auckland', start_date: '2026-10-16', end_date: '2026-10-16', app_name: 'Grip' }, settings: { crm_log: 'tasks', app_note_times: 'in_app' }, slots: [] });
  approveRounds(H);
  sendNow(H, NOW);
  const before = cli(H, 'event-outreach', ['task-list', '--event', H.slug], '2026-10-15T08:00:00Z');
  assert.equal(before.by_kind?.send || 0, 1, JSON.stringify(before));
  const after = cli(H, 'event-outreach', ['task-list', '--event', H.slug], '2026-10-16T12:00:00Z');
  assert.equal(after.by_kind?.send || 0, 0, JSON.stringify(after));
  // The unit: no send task once today is past the last day; an opt-out task still comes.
  const card = { kind: 'message', channel: 'paste', id: 'c001', touch: 2, name: 'Ana', company: 'Acme', body: 'x', due_on: '2026-10-14' };
  const args = { cards: [card], stops: ['c001'], created: new Set(), event: { name: 'X', end_date: '2026-10-16' }, byId: { c001: { name: 'Ana', company: 'Acme' } }, crmOf: () => null };
  assert.deepEqual(taskItems({ ...args, today: '2026-10-16' }).map((t) => t.kind), ['send', 'opt_out']);
  assert.deepEqual(taskItems({ ...args, today: '2026-10-17' }).map((t) => t.kind), ['opt_out']);
});

test('the guard reads today in the event\'s zone: the due day starts at midnight there, not in UTC', () => {
  // Auckland (UTC+13): Thu 15 Oct starts at 11:00 UTC on the 14th.
  const A = ready({ event: { time_zone: 'Pacific/Auckland' }, gap: [3] });
  approveRounds(A);
  sendNow(A, NOW);
  const ana = idOf(A, 'Ana Berg');
  assert.match(handListed(A, ana, 2, '2026-10-14T10:00:00Z').stderr, /isn't due until Thursday 15 October/);
  assert.equal(handListed(A, ana, 2, '2026-10-14T12:00:00Z').status, 0, 'past midnight in Auckland, still the 14th in UTC');
  // Pago Pago (UTC-11): approved there on Sun 11 Oct, follow-up due Wed 14, which starts at 11:00 UTC on the 14th.
  const P = ready({ event: { time_zone: 'Pacific/Pago_Pago', slug: 'pago' }, gap: [3] });
  approveRounds(P);
  sendNow(P, NOW);
  assert.match(handListed(P, idOf(P, 'Ana Berg'), 2, '2026-10-14T08:00:00Z').stderr, /isn't due until Wednesday 14 October/, 'the 14th in UTC, still the 13th there');
  assert.equal(handListed(P, idOf(P, 'Ana Berg'), 2, '2026-10-14T12:00:00Z').status, 0);
});

test('5: a step recorded out of order passes over the earlier ones, and the next step counts its gap from it', () => {
  const H = ready({ route: ['email', 'email', 'email', 'email'], gap: [3] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.deepEqual(sendNow(H, NOW).went, [1]);
  // The user says they sent message 3 by hand on Tue 13 Oct (out of order); message 2 was due Thu 15.
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Ana Berg', what: 'sent', touch: 3, date: '2026-10-13', said: 'sent it myself' }] })], '2026-10-13T08:00:00Z');
  assert.match(handListed(H, ana, 2, '2026-10-15T08:00:00Z').stderr, /a later message already went/);
  // Message 2 is never listed (send-list reads the same rule), not only refused at the guard; message 4 counts from
  // its plan (Thu 22 Oct, 3 days after message 3's planned Mon 19), since message 3 went before its day.
  for (const [d, want] of [['2026-10-15', []], ['2026-10-16', []], ['2026-10-22', [4]]]) {
    const { list, went } = sendNow(H, `${d}T08:00:00Z`);
    assert.deepEqual(went, want, d);
    assert.ok(!JSON.parse(readFileSync(list.file, 'utf8')).some((x) => x.touch === 2), `${d}: message 2 isn't listed`);
    assert.ok(list.waiting.some((w) => w.touch === 2 && /a later message already went/.test(w.why)), JSON.stringify(list.waiting));
  }
  assert.equal(followupDay({ followup_gap: [3] }, { time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' }, { prevSent: '2026-10-12', touch: 2, lastSent: '2026-10-13' }).day, '2026-10-16');
  assert.equal(followupDay({ followup_gap: [3] }, { time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' }, { prevSent: '2026-10-12', touch: 2, lastSent: '2026-10-12' }).day, '2026-10-15');
});

test('a re-planned day is the day send-list and the guard use, for each later follow-up (route of four)', () => {
  // Event Mon 19 to Wed 21 Oct, gap 2: planned Wed 14, Fri 16, Mon 19. Message 1 rewritten on Thu 15: follow-up 1 is
  // planned again for Mon 19 (Sat 17 moved), so follow-up 2 for Wed 21 (counted from Mon 19) and follow-up 3 for none.
  const H = ready({ route: ['email', 'email', 'email', 'email'], event: { start_date: '2026-10-19', end_date: '2026-10-21' }, gap: [2], slots: [{ id: 's1', start: '2026-10-21T15:00:00Z', end: '2026-10-21T15:30:00Z' }] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  mkdirSync(join(H.dir, 'work'), { recursive: true });
  writeFileSync(join(H.dir, 'work', 'fb.txt'), 'make it a bit warmer');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', `${ana}:1`, '--feedback-file', join(H.dir, 'work', 'fb.txt')], '2026-10-15T08:00:00Z');
  approveRounds(H, '2026-10-15T08:00:00Z', 'Happy to work around your day.');
  const re = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'replanned');
  assert.deepEqual(re.map((e) => [e.touch, e.planned_due, e.planned_from]), [[3, '2026-10-21', '2026-10-19'], [4, null, '2026-10-21']], 'both later follow-ups, not only the next');
  const went = {};
  for (let k = 0; k < 8; k++) {
    const day = new Date(Date.parse('2026-10-15T08:00:00Z') + k * 864e5).toISOString();
    for (const t of sendNow(H, day).went) (went[day.slice(0, 10)] ||= []).push(t);
  }
  // Follow-up 2 goes on its re-planned day during the event (the plan stands, message before it went on its day);
  // with the old plan it would be counted from another day and not go at all.
  assert.deepEqual(went, { '2026-10-15': [1], '2026-10-19': [2], '2026-10-21': [3] }, JSON.stringify(went));
});

test('mutation guards: the fallback, the on-time check, and what settle gives when the candidate fails', () => {
  const e = { time_zone: 'Europe/Amsterdam', start_date: '2026-10-12', end_date: '2026-10-14' };
  // A candidate that fails (on the send day) gives way to the gap after the real send, not to no day.
  const rule = ruleAfter({ followup_gap: [1] }, { ...e, start_date: '2026-11-10', end_date: '2026-11-12' }, '2026-10-20', 2, true);
  assert.deepEqual(settle({ ...e, end_date: '2026-11-12' }, '2026-10-20', rule, '2026-10-20'), { day: '2026-10-21' });
  // Message 2 planned Fri 9, sent late on Sun 11 (a day before the event): no follow-up starts that close, even though
  // Mon 12 (the plan's Saturday moved to Monday) is a day after that send and a weekday.
  const late = followupDay({ followup_gap: [1] }, e, {
    prevSent: '2026-10-11',
    touch: 3,
    planned_due: '2026-10-12',
    planned_gap: '1',
    planned_from: '2026-10-09',
    prev_planned_due: '2026-10-09',
    prev_planned_gap: '1'
  });
  assert.deepEqual([late.day, late.why], [null, 'last']);
  // A replanned entry with no day left still keeps the sequence off weekends.
  assert.equal(followupDay({ followup_gap: [5] }, { ...e, start_date: '2026-11-10', end_date: '2026-11-12' }, { prevSent: '2026-10-12', touch: 2, planned_due: null, planned_gap: '5' }).day, '2026-10-19');
  // A planned day that isn't a plain date is no plan: never returned as the day.
  for (const odd of ['2026-10-17 ', '2026-10-20T00:00:00Z'])
    assert.notEqual(followupDay({ followup_gap: [3] }, { ...e, start_date: '2026-11-10', end_date: '2026-11-12' }, { prevSent: '2026-10-12', touch: 2, planned_due: odd, planned_gap: '3' }).day, odd);
});
