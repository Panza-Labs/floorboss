// One message a day to one person, enforced by the guard on its own (back to back, or two calls at once), steps
// recorded out of order passing over the earlier ones, nothing staged or offered after the event, and staging on the
// follow-up's own day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setup, cli, idOf, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { followupDay, settle, ruleAfter } from '../lib/spacing.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';
import { addDays } from '../lib/tz.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const hookArgs = (H, input, now) => [['node', [join(ROOT, 'hooks/guard.mjs')]], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' }];
const guard = (H, input, now) => { const [[c, a], o] = hookArgs(H, input, now); return spawnSync(c, a, o); };
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';

function ready({ route, event = {}, gap = null, settings = {}, sending = true, attendees = PEOPLE } = {}) {
  const H = setup({ attendees, event, settings: { ...(sending ? { sending: { channels: ['email'], followups: 'scheduled' } } : {}), route, ...settings } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, ...(gap ? { followup_gap: gap } : {}) }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
function approveRounds(H, now = NOW) {
  for (let i = 0; i < 6; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => (x.kind === 'message' || x.kind === 'confirmation') && !x.waits_for_previous)) {
      const d = j.kind === 'confirmation' ? { subject: 'Re: Test Expo', body: `Hi Ana, confirming ${(j.slot_labels || []).join('')}. See you at Test Expo.\n\nBest, Sam` } : draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x, no research profile', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], now);
      if (j.kind !== 'confirmation') cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
// The approved email for a step, as a session could list it by hand, written into send-list.json with others.
function itemFor(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  return { id, touch, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now };
}
const writeList = (H, items) => writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify(items));
const record = (H, items, now) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })], now);
const sentReceipt = (H, id, touch, now) => cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id, touch, message_id: `m${touch}` }] })], now);
// The guard on every approved unsent step at once (one list, back to back, no receipt saved between the calls).
function guardAll(H, id, touches, now) {
  nobody(H, now);
  const items = touches.map((t) => itemFor(H, id, t, now));
  writeList(H, items);
  return items.filter((it) => guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0).map((it) => it.touch);
}

test('F1 a: back to back, with no receipt saved between the calls, the guard lets one message a day through to one person', () => {
  const H = ready({ route: ['email', 'email', 'email', 'email'] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  nobody(H, NOW);
  writeList(H, [itemFor(H, ana, 1, NOW)]);
  assert.equal(guard(H, { to: 'ana@acme.test', subject: itemFor(H, ana, 1, NOW).subject, body: itemFor(H, ana, 1, NOW).body }, NOW).status, 0);
  sentReceipt(H, ana, 1, NOW);
  // The user records message 3 as sent by hand on Tue 27 Oct; on Mon 2 Nov messages 2 and 4 both look due.
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 3, date: '2026-10-27', said: 'I sent it myself' }], at('2026-10-27'));
  const day = at('2026-11-02');
  nobody(H, day);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], day);
  const listed = JSON.parse(readFileSync(list.file, 'utf8')).filter((x) => x.id === ana).map((x) => x.touch);
  assert.deepEqual(listed, [4], 'message 2 is passed over: a later message already went');
  assert.ok(list.waiting.some((w) => w.touch === 2 && /a later message already went/.test(w.why)), JSON.stringify(list.waiting));
  assert.deepEqual(guardAll(H, ana, [2, 4], day), [4]);
  // And with both listed by hand and no receipt between the calls, still one: the second call is refused.
  const H2 = ready({ route: ['email', 'email', 'email', 'email'], event: { slug: 'two' } });
  approveRounds(H2);
  const a2 = idOf(H2, 'Ana Berg');
  assert.deepEqual(guardAll(H2, a2, [1], NOW), [1]);
  sentReceipt(H2, a2, 1, NOW);
  assert.deepEqual(guardAll(H2, a2, [2], at('2026-10-19')), [2], 'message 2 on its day');
  // Same day, no receipt for message 2 saved: message 3 is refused (a send in progress counts).
  const g = (() => {
    nobody(H2, at('2026-10-19', '08:01'));
    const it = itemFor(H2, a2, 3, at('2026-10-19', '08:01'));
    writeList(H2, [it]);
    return guard(H2, { to: it.to, subject: it.subject, body: it.body }, at('2026-10-19', '08:01'));
  })();
  assert.equal(g.status, 2);
  assert.match(g.stderr, /another message to .*Ana Berg.* already went or is going today|isn't due until/);
});

test('F1 variants: gap 2 with message 3 recorded early, and a LinkedIn step reported by hand, never give two in a day', () => {
  const H = ready({ route: ['email', 'email', 'email', 'email'], gap: [2] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.deepEqual(guardAll(H, ana, [1], NOW), [1]);
  sentReceipt(H, ana, 1, NOW);
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 3, date: '2026-10-17', said: 'I sent it myself' }], at('2026-10-17'));
  const day = at('2026-10-19');
  nobody(H, day);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], day);
  assert.deepEqual(JSON.parse(readFileSync(list.file, 'utf8')).map((x) => x.touch), [4]);
  assert.deepEqual(guardAll(H, ana, [2, 4], day), [4]);
  // The gap answer passes over the earlier step instead of announcing two for one day.
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(join(H.HOME, 'work', 'gap.json'), JSON.stringify('3 days'));
  const r = JSON.parse(spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', 'followup_gap', '--value-file', join(H.HOME, 'work', 'gap.json')], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: at('2026-10-18') }, encoding: 'utf8' }).stdout);
  assert.doesNotMatch(r.result.note, /Ana Berg follow-up 1: [^;]*→ (?!passed over)\w+ \d+ \w+/, r.result.note);
  // A LinkedIn step reported sent today: the email after it can't go the same day.
  const L = ready({ route: ['email', 'linkedin', 'email'], event: { slug: 'li' }, gap: [1] });
  const la = idOf(L, 'Ana Berg');
  approveRounds(L);
  assert.deepEqual(guardAll(L, la, [1], NOW), [1]);
  sentReceipt(L, la, 1, NOW);
  record(L, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-13', said: 'sent the LinkedIn note' }], at('2026-10-13'));
  const now = at('2026-10-13', '09:00');
  nobody(L, now);
  const it = itemFor(L, la, 3, now);
  writeList(L, [it]);
  const g = guard(L, { to: it.to, subject: it.subject, body: it.body }, now);
  assert.equal(g.status, 2, 'not the same day as the LinkedIn note');
  assert.match(g.stderr, /another message to .*Ana Berg.* already went or is going today/);
});

test('F1 a: two guard calls at the same moment for one person: exactly one is let through; the day marker holds on its own', async () => {
  const H = ready({ route: ['email', 'email', 'email'], gap: [1] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.deepEqual(guardAll(H, ana, [1], NOW), [1]);
  sentReceipt(H, ana, 1, NOW);
  const day = at('2026-10-13');
  nobody(H, day);
  const items = [itemFor(H, ana, 2, day), itemFor(H, ana, 3, day), itemFor(H, ana, 2, day)];
  writeList(H, items);
  const run = (it) =>
    new Promise((res) => {
      const [[c, a], o] = hookArgs(H, { to: it.to, subject: it.subject, body: it.body }, day);
      const p = spawn(c, a, { env: o.env });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res({ code, err }));
      p.stdin.end(o.input);
    });
  const out = await Promise.all(items.map(run));
  assert.equal(out.filter((x) => x.code === 0).length, 1, JSON.stringify(out));
  // The per-person, per-day marker refuses by itself, whatever the ledger says: one taken by another step today.
  const K = ready({ route: ['email', 'email', 'email'], gap: [1], event: { slug: 'mark' } });
  const ka = idOf(K, 'Ana Berg');
  approveRounds(K);
  assert.deepEqual(guardAll(K, ka, [1], NOW), [1]);
  sentReceipt(K, ka, 1, NOW);
  mkdirSync(join(K.dir, 'released'), { recursive: true });
  writeFileSync(join(K.dir, 'released', `${ka}-day-2026-10-13`), '3:0');
  nobody(K, day);
  const it = itemFor(K, ka, 2, day);
  writeList(K, [it]);
  const g = guard(K, { to: it.to, subject: it.subject, body: it.body }, day);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /another message to .* already went or is going today/);
});

test('F1 property: generated out-of-order records never give two listed or allowed for one person on one day', () => {
  let x = 5;
  const r = (n) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
  for (let s = 0; s < 4; s++) {
    const n = 3 + r(3);
    const gap = [null, [1], [2], [3]][r(4)];
    const H = ready({ route: Array(n).fill('email'), gap, event: { slug: `p${s}` } });
    const ana = idOf(H, 'Ana Berg');
    approveRounds(H);
    assert.deepEqual(guardAll(H, ana, [1], NOW), [1]);
    sentReceipt(H, ana, 1, NOW);
    // One later step recorded by hand, out of order, on a random day.
    const late = 3 + r(n - 2);
    const recDay = addDays('2026-10-12', 1 + r(8));
    if (late <= n) record(H, [{ who: 'Ana Berg', what: 'sent', touch: late, date: recDay, said: 'sent by hand' }], at(recDay));
    for (let k = 1; k <= 14; k++) {
      const day = addDays('2026-10-12', k);
      const now = at(day);
      nobody(H, now);
      const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
      const listed = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')).filter((y) => y.id === ana) : [];
      assert.ok(listed.length <= 1, `${s} ${day}: listed ${JSON.stringify(listed.map((y) => y.touch))}`);
      const open = Array.from({ length: n - 1 }, (_, i) => i + 2);
      const allowed = guardAll(H, ana, open, now);
      assert.ok(allowed.length <= 1, `${s} ${day}: allowed ${allowed}`);
      for (const t of allowed) sentReceipt(H, ana, t, now);
    }
  }
});

test('F2 and F4: nothing is staged or offered after the event, and a follow-up is staged only on its day', () => {
  // Sending off: messages are staged in the mailbox for the user. Gap 2, then "7 days" once follow-up 1 was approved.
  const H = ready({ route: ['email', 'email', 'email'], gap: [2], sending: false });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent' }], NOW);
  approveRounds(H, at('2026-10-14'));
  const due = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], at('2026-10-14'));
  assert.ok(JSON.parse(readFileSync(due.file, 'utf8')).some((x) => x.id === ana && x.touch === 2), 'on its day');
  cli(H, 'event-context', ['config', '--set', JSON.stringify({ followup_gap: [7] })]);
  const moved = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], at('2026-10-14'));
  assert.ok(!JSON.parse(readFileSync(moved.file, 'utf8')).some((x) => x.id === ana && x.touch === 2), 'now due Mon 19 Oct: not staged on the 14th');
  const it = { ...itemFor(H, ana, 2, at('2026-10-14')), listed_at: at('2026-10-14') };
  assert.match(stageRefusal(H.dir, it, Date.parse(at('2026-10-14'))) || '', /isn't due until Monday 19 October/);
  // After the event (Thu 12 Nov): nothing to stage, nothing due or waiting in the summary, and the page offers nothing.
  for (const d of ['2026-11-13', '2026-11-15']) {
    const s = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], at(d));
    assert.equal(s.to_stage, 0, d);
    assert.match(stageRefusal(H.dir, { ...it, listed_at: at(d) }, Date.parse(at(d))) || '', /the event is over/);
    const sm = cli(H, 'event-outreach', ['summary', '--event', H.slug], at(d));
    assert.equal(sm.in_outbox_to_send, undefined, d);
    assert.deepEqual(sm.follow_ups_due, []);
  }
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], at('2026-11-13'));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  const card = html.slice(html.indexOf(`data-id="${ana}"`), html.indexOf('</article>', html.indexOf(`data-id="${ana}"`)));
  assert.match(card, /Not going: the event is over/);
  assert.doesNotMatch(card, /class="copy"/);
});

test('F3: after the event the guard refuses a first message and a confirmation, through the hook, in the event\'s own zone', () => {
  // Kiritimati (UTC+14): its last day, Thu 12 Nov, ends at 10:00 UTC that day.
  const event = { time_zone: 'Pacific/Kiritimati', start_date: '2026-11-10', end_date: '2026-11-12' };
  const H = ready({ route: ['email', 'email'], event });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  record(H, [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tuesday at ten works' }], NOW);
  approveRounds(H);
  for (const t of [1, 0]) {
    const it = itemFor(H, ana, t, '2026-11-12T10:01:00Z');
    nobody(H, '2026-11-12T10:01:00Z');
    writeList(H, [it]);
    const g = guard(H, { to: it.to, subject: it.subject, body: it.body }, '2026-11-12T10:01:00Z');
    assert.equal(g.status, 2, `touch ${t}: the UTC date is still the 12th, the event's is the 13th`);
    assert.match(g.stderr, /the event is over/);
  }
  // At 23:59 on the last day there (09:59 UTC), the confirmation still goes.
  nobody(H, '2026-11-12T09:59:00Z');
  const it = itemFor(H, ana, 0, '2026-11-12T09:59:00Z');
  writeList(H, [it]);
  assert.equal(guard(H, { to: it.to, subject: it.subject, body: it.body }, '2026-11-12T09:59:00Z').status, 0);
});

test('F3: each "over" check in the rule stands on its own, and a malformed send date never breaks the readers', () => {
  const e = { time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' };
  // Before the message before it went: the planned day, but none once the event is over.
  assert.equal(followupDay({}, e, { prevSent: null, touch: 2, planned_due: '2026-11-11', planned_gap: 'table', today: '2026-11-13' }).day, null);
  // After it went: settle refuses once the event is over.
  assert.deepEqual(settle(e, '2026-11-09', ruleAfter({ followup_gap: [1] }, e, '2026-11-09', 2, false), '2026-11-10', '2026-11-13'), { day: null, why: 'over' });
  assert.deepEqual(settle(e, '2026-11-09', ruleAfter({ followup_gap: [1] }, e, '2026-11-09', 2, false), '2026-11-10', '2026-11-12'), { day: '2026-11-10' });
  // A malformed send date is left out of the latest-send search.
  assert.equal(followupDay({ followup_gap: [3] }, e, { prevSent: '2026-10-12', touch: 2, lastSent: 'yesterday' }).day, '2026-10-15');
});
