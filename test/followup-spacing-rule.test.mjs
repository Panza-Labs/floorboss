// The one rule for a follow-up's day, held everywhere: never sooner than its gap after the message before it really
// went, never on a weekend in a sequence planned off weekends, never after the event's last day (dropped, never moved
// closer). Checked over generated plans, late sends and gap changes, and end to end through send-list and the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, idOf, draftApprove, ROOT, NOW } from './fixtures/harness.mjs';
import { parseGap, followupDay, plannedDays, nextDue, dueAfter, gapFor, gapKey, modeFor, modeOn, storedGap } from '../lib/spacing.mjs';
import { effectiveSettings } from '../lib/config.mjs';
import { addDays, daysBetween } from '../lib/tz.mjs';
import { taskItems } from '../skills/event-outreach/scripts/tracking.mjs';

const EV = { name: 'Test Expo', city: 'Rotterdam', time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' };
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const SENDING = { channels: ['email'], followups: 'scheduled', linkedin_ack: false };
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const weekend = (k) => [0, 6].includes(new Date(`${k}T12:00:00Z`).getUTCDay());
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });

function ready(n, { home = null, slug = 'ev', name = 'Test Expo', attendees = LIST } = {}) {
  const H = setup({ attendees, home, event: { slug, name }, settings: { sending: SENDING, route: Array(n).fill('email') } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ ...(existsSync(join(H.HOME, 'config.json')) ? JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')) : {}), connectors: { 'email.send': RECIPE } }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
const say = (H, words, now = NOW) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'gap.json');
  writeFileSync(f, JSON.stringify(words));
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', 'followup_gap', '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
  return r.status !== 0 ? { ERROR: String(r.stderr || r.stdout).slice(0, 800) } : JSON.parse(r.stdout);
};
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
function sendListed(H, now) {
  nobody(H, now);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
  const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
  const sends = [];
  for (const it of items) if (guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0) sends.push({ id: it.id, touch: it.touch, message_id: `m-${it.id}-${it.touch}` });
  if (sends.length) cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })], now);
  return { list, sends: sends.map((s) => [s.id, s.touch]) };
}
// A send list written by hand for one approved message (what a session could write), then the guard on it.
function handListed(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  const it = { id, touch, name: 'x', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, thread_id: null, reply_to_message_id: null, listed_at: now };
  writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify([it]));
  nobody(H, now);
  return guard(H, { to: it.to, subject: it.subject, body: it.body }, now);
}

test('property: over generated plans, late sends and gap changes, no day is sooner than the gap after the real send, on a weekend, or after the event', () => {
  const gaps = [null, [1], [3], [7], [14], [2, 5]];
  let checked = 0;
  for (const start of ['2026-03-30', '2026-11-10', '2027-01-04'])
    for (const dur of [0, 2]) {
      const e = { time_zone: 'Europe/Amsterdam', start_date: start, end_date: addDays(start, dur) };
      for (const planGap of gaps)
        for (const nowGap of gaps) {
          const planS = { followup_gap: planGap }, nowS = { followup_gap: nowGap };
          for (let back = 3; back <= 40; back += 3) {
            const today = addDays(start, -back);
            let prevPlanned = today;
            for (const p of plannedDays(planS, e, today, modeFor(daysBetween(today, start)), 6)) {
              for (let late = 0; late <= 14; late++) {
                const prevSent = addDays(prevPlanned, late);
                if (prevSent > e.end_date) break;
                const r = followupDay(nowS, e, { prevSent, touch: p.touch, planned_due: p.due, planned_gap: gapKey(planS) });
                checked++;
                if (!r.day) continue;
                const g = gapFor(nowS, modeOn(e, prevSent), p.touch);
                const why = JSON.stringify({ e, planGap, nowGap, today, p, prevSent, r });
                assert.ok(g && r.day >= addDays(prevSent, g), `sooner than its gap after the real send: ${why}`);
                assert.ok(!weekend(r.day), `on a weekend: ${why}`);
                assert.ok(r.day <= e.end_date, `after the event: ${why}`);
              }
              prevPlanned = p.due;
            }
          }
        }
    }
  assert.ok(checked > 10000, `checked ${checked}`);
});

test('the parts of the rule: no day after the event, none sooner than the gap after a late send, a gap change keeps off weekends', () => {
  assert.equal(nextDue('2026-11-08', EV, 'short', 7), null, 'a day after the event is no day');
  assert.equal(dueAfter({ followup_gap: [3] }, EV, '2026-11-10', 2), null);
  // B1: approved a week apart (plan 2 Nov), the message before it went late on Fri 6 Nov: 13 Nov is past the event.
  assert.deepEqual(followupDay({ followup_gap: [7] }, EV, { prevSent: '2026-11-06', touch: 4, planned_due: '2026-11-02', planned_gap: '7' }), { day: null, waits: false, planned: '2026-11-02', why: 'end' });
  // A Monday move that lands past the event's last day is no day either (event Fri 20 to Sat 21 Nov, gap 8 from Fri 13).
  const FRI = { ...EV, start_date: '2026-11-20', end_date: '2026-11-21' };
  assert.equal(followupDay({ followup_gap: [8] }, FRI, { prevSent: '2026-11-13', touch: 2, planned_due: '2026-11-20', planned_gap: '8' }).day, null);
  // The same on the table: the gap after that send, not the old planned day.
  assert.equal(followupDay({}, EV, { prevSent: '2026-10-29', touch: 3, planned_due: '2026-10-26' }).day, '2026-11-02');
  // Sent the day before the event starts: no follow-up on the table's last day, whatever the old plan said.
  assert.equal(followupDay({}, EV, { prevSent: '2026-11-09', touch: 3, planned_due: '2026-11-02' }).day, null);
  // B2: planned on the table, then "5 days": Mon 12 + 5 is a Saturday, so Monday 19.
  assert.equal(followupDay({ followup_gap: [5] }, EV, { prevSent: '2026-10-12', touch: 2, planned_due: '2026-10-19', planned_gap: 'table' }).day, '2026-10-19');
  // B6: per-step gaps, route of 4, message 2 went 3 Nov: 8 Nov for every reader (Sunday 8 isn't planned off weekends: no plan).
  assert.equal(followupDay({ followup_gap: [2, 5] }, EV, { prevSent: '2026-11-03', touch: 3 }).day, '2026-11-08');
});

test('words it must not misread are refused, each saying why', () => {
  for (const [w, re] of [
    ['between 3 and 5 days', /isn't a number of whole days/],
    ['twice a week', /not how many go in a week/],
    ['day 3, day 7', /number before the unit/],
    ['-2', /can't be negative/],
    ['your own, like "2 days, then 5"', /asks for your own days/],
    ['1.5 days', /has a part day/],
    ['1,2,3,4,5,6,7,8', /At most 7 gaps/],
    ['3 or 4 days', /isn't a number of whole days/]
  ])
    assert.throws(() => parseGap(w), re, w);
  for (const [w, want] of [['2,5,7', [2, 5, 7]], ['2, 5', [2, 5]], ['3d', [3]], ['1w', [7]], ['3 d', [3]], ['3 days between follow-ups', [3]]]) assert.deepEqual(parseGap(w), want, w);
  // A long paste is read only as far as an answer goes.
  const t0 = Date.now();
  assert.throws(() => parseGap(`(${'('.repeat(50000)}`));
  assert.throws(() => parseGap(`${' '.repeat(50000)}x`));
  assert.ok(Date.now() - t0 < 1000, 'quick on long input');
});

test('a followup_gap written by hand is used only in the shape the flow saves; anything else is ignored with a note', () => {
  for (const bad of [[-5], 3, 'x', [0], [15], [2.5], ['3'], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    const s = effectiveSettings({ followup_gap: bad }, null);
    assert.equal(s.followup_gap, null, JSON.stringify(bad));
    assert.match(s.followup_gap_ignored, /ignored/);
    // The table decides: never a day before the previous send.
    assert.equal(followupDay(s, EV, { prevSent: '2026-10-20', touch: 2 }).day, '2026-10-27');
  }
  assert.deepEqual(effectiveSettings({ followup_gap: [2, 5] }, null).followup_gap, [2, 5]);
  assert.deepEqual(storedGap(null), { gap: null });
});

test('no CRM "send it" task for a follow-up with no room left, or one whose day is still ahead', () => {
  const card = { kind: 'message', channel: 'paste', id: 'c001', touch: 3, name: 'Ana', company: 'Acme', body: 'x', planned_due: '2026-10-26' };
  const items = (c) => taskItems({ cards: [c], created: new Set(), event: {}, byId: {}, crmOf: () => null, today: '2026-10-28' });
  assert.equal(items({ ...card, due_on: null }).length, 0, 'dropped: never a task for today');
  assert.equal(items({ ...card, due_on: '2026-11-02' }).length, 0, 'not before its day');
  assert.equal(items({ ...card, due_on: '2026-10-28' }).length, 1);
  assert.equal(items({ ...card, due_on: null, due_waits: true }).length, 0);
});

test('B1 end to end: back late, the next follow-up goes, the one after it is dropped, not sent the same day', () => {
  const H = ready(4);
  const ana = idOf(H, 'Ana Berg');
  assert.ok(!say(H, 'a week').ERROR);
  draftApprove(H);
  assert.ok(sendListed(H, NOW).sends.some(([i, t]) => i === ana && t === 1));
  assert.ok(sendListed(H, at('2026-10-19')).sends.some(([i, t]) => i === ana && t === 2));
  // Back on Fri 6 Nov: message 3 (planned 26 Oct) goes; message 4 would be 13 Nov, after the event.
  const first = sendListed(H, at('2026-11-06'));
  assert.deepEqual(first.sends.filter(([i]) => i === ana), [[ana, 3]], JSON.stringify(first.list));
  const again = sendListed(H, at('2026-11-06', '08:05'));
  assert.deepEqual(again.sends.filter(([i]) => i === ana), [], 'not the same day');
  assert.ok(again.list.waiting.some((w) => w.id === ana && w.touch === 4 && /no room left/.test(w.why)), JSON.stringify(again.list.waiting));
  for (const d of ['2026-11-09', '2026-11-12']) assert.deepEqual(sendListed(H, at(d)).sends.filter(([i]) => i === ana), [], d);
  const g = handListed(H, ana, 4, at('2026-11-09'));
  assert.equal(g.status, 2, 'a hand-written list gets no further at the guard');
  assert.match(g.stderr, /no room left before the event ends/);
});

test('B2 end to end: after a gap change nothing goes on a weekend; the answer and the guard say the day that will be used', () => {
  const H = ready(3);
  const ana = idOf(H, 'Ana Berg');
  draftApprove(H);
  assert.ok(sendListed(H, NOW).sends.some(([i, t]) => i === ana && t === 1));
  const r = say(H, '5 days');
  assert.ok(!r.ERROR, r.ERROR);
  // Follow-up 1 still goes Mon 19 Oct (Sat 17 moves to the Monday) and follow-up 2 Mon 26 Oct (5 days later is a
  // Saturday too): the answer says the days that will really be used, so no day changes.
  assert.match(r.result.note, /No approved follow-up changes day/);
  assert.match(r.result.say_to_user, /^Saved: follow-ups go 5 days apart\./);
  assert.match(r.result.note, /your setting for every event/);
  for (const d of ['2026-10-16', '2026-10-17', '2026-10-18']) assert.deepEqual(sendListed(H, at(d)).sends, [], d);
  const g = handListed(H, ana, 2, at('2026-10-17'));
  assert.equal(g.status, 2);
  assert.match(g.stderr, /isn't due until Monday 19 October, Rotterdam time/);
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], at('2026-10-17'));
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html.slice(html.indexOf(`data-id="${ana}"`), html.indexOf('</article>', html.indexOf(`data-id="${ana}"`))), /planned for Mon 19 Oct/);
  assert.ok(sendListed(H, at('2026-10-19')).sends.some(([i, t]) => i === ana && t === 2));
});

test('the gap a follow-up was planned with is saved with it, and the answer names moves at other events too', () => {
  const H = ready(3);
  // Other people at the other event: someone written to at one event is held as in touch at the next.
  const other = ready(3, { home: H.HOME, slug: 'ev2', name: 'Other Expo', attendees: 'Name,Title,Company,Email\nCy Ng,COO,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\n' });
  draftApprove(other);
  assert.equal(sendListed(other, NOW).sends.length, 2, 'first messages went there');
  assert.ok(!say(H, '3 days').ERROR);
  draftApprove(H);
  const drafted = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'drafted' && e.touch === 2);
  assert.ok(drafted.length && drafted.every((e) => e.planned_gap === '3'), JSON.stringify(drafted.map((e) => e.planned_gap)));
  const r = say(H, '2 days');
  assert.match(r.result.note, /At Other Expo: \d+ approved follow-ups change day/, r.result.note);
  // Ana's first message hasn't gone: the answer gives the gap after it, not a day.
  assert.match(r.result.note, /Ana Berg follow-up 1: 3 days after message 1 goes → 2 days after message 1 goes/, r.result.note);
});
