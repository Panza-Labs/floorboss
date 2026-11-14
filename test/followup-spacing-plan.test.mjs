// What floorboss plans and says is what it then does: with every message sent on its planned day, every planned
// follow-up goes on its planned day (the plan and the rule are one function). Answers are read whole or refused. And
// the gap answer's count of moved and dropped follow-ups matches what then happens, against a home that never heard it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, idOf, draftApprove, ROOT, NOW } from './fixtures/harness.mjs';
import { parseGap, followupDay, plannedDays, nextDue, offWeekend, gapFor, gapKey, modeFor, touchesThatFit } from '../lib/spacing.mjs';
import { FILLER } from '../lib/gap-words.mjs';
import { addDays, daysBetween } from '../lib/tz.mjs';

// The chain as it was planned before the rule checked it (the released code's plan): today's lead time throughout.
function chain(s, e, today, mode, wanted) {
  const fit = touchesThatFit(today, e, mode, wanted, (t) => gapFor(s, mode, t));
  const out = [];
  let due = today;
  for (let t = 2; t <= fit; t++) {
    due = offWeekend(nextDue(due, e, mode, gapFor(s, mode, t)));
    if (!due || due > e.end_date) break;
    out.push({ touch: t, due });
  }
  return out;
}

test('every message on its planned day: no planned follow-up is dropped, each goes on its planned day, and the default plan is the released one', () => {
  let plans = 0,
    followups = 0,
    cut = 0;
  for (const zone of ['Europe/Amsterdam', 'Pacific/Auckland', 'America/Los_Angeles'])
    for (const start of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'])
      for (let len = 1; len <= 4; len++) {
        const e = { name: 'Expo', time_zone: zone, start_date: start, end_date: addDays(start, len - 1) };
        for (const gap of [null, [1], [2], [3], [5], [7]]) {
          const s = { followup_gap: gap };
          for (let out = 2; out <= 40; out++)
            for (let route = 2; route <= 5; route++) {
              const today = addDays(start, -out);
              const mode = modeFor(daysBetween(today, start));
              const plan = plannedDays(s, e, today, mode, route);
              plans++;
              const released = chain(s, e, today, mode, route);
              // In every zone the plan is exactly the released chain (the lead time is read on the event's own date).
              assert.deepEqual(plan.map(({ touch, due }) => ({ touch, due })), released, JSON.stringify({ zone, e, gap, today, route }));
              cut += released.length - plan.length;
              let prev = today,
                prevPlanned;
              for (const p of plan) {
                const r = followupDay(s, e, { prevSent: prev, touch: p.touch, planned_due: p.due, planned_gap: gapKey(s), planned_from: p.from, prev_planned_due: prevPlanned, prev_planned_gap: gapKey(s) });
                followups++;
                assert.equal(r.day, p.due, JSON.stringify({ e, gap, today, route, p, r }));
                prev = prevPlanned = p.due;
              }
            }
        }
      }
  assert.ok(plans > 50000 && followups > 50000, `${plans} plans, ${followups} follow-ups`);
  assert.equal(cut, 0, 'no planned follow-up is left out, Auckland included');
});

test('the reported case: three emails, event Wed 14 to Fri 16 Oct, approved Mon 12: message 3 goes Fri 16 as planned', () => {
  const e = { name: 'Expo', time_zone: 'Europe/Amsterdam', start_date: '2026-10-14', end_date: '2026-10-16' };
  const plan = plannedDays({}, e, '2026-10-12', modeFor(2), 3);
  assert.deepEqual(plan, [{ touch: 2, due: '2026-10-14', from: '2026-10-12' }, { touch: 3, due: '2026-10-16', from: '2026-10-14' }]);
  assert.equal(followupDay({}, e, { prevSent: '2026-10-14', touch: 3, planned_due: '2026-10-16', planned_gap: 'table', prev_planned_due: '2026-10-14', prev_planned_gap: 'table' }).day, '2026-10-16');
  // Message 2 went late (Thu 15): no follow-up starts that close, and the reason says so (not "no room").
  const late = followupDay({}, e, { prevSent: '2026-10-15', touch: 3, planned_due: '2026-10-16', planned_gap: 'table', prev_planned_due: '2026-10-14', prev_planned_gap: 'table' });
  assert.deepEqual([late.day, late.why], [null, 'last']);
});

// [what a person types, what they mean: a list, null (the default), or 'R' (asked again, told what to type)].
const PHRASES = [
  ['3 days', [3]], ['three days', [3]], ['every 3 days', [3]], ['3', [3]], ['3 days between follow-ups', [3]], ['wait 3 days between follow-ups', [3]],
  ['a week', [7]], ['a week apart', [7]], ['one week', [7]], ['2 weeks', [14]], ['two weeks', [14]], ['a fortnight', [14]],
  ['2 days, then 5', [2, 5]], ['2 then 5', [2, 5]], ['2, 5, 7', [2, 5, 7]], ['2,5,7', [2, 5, 7]], ['2 days then 5 days then a week', [2, 5, 7]], ['3 days, then a week', [3, 7]],
  ['first 2 days, then 4 days', 'R'], ['2 and 5', [2, 5]], ['3 days and then every week', [3, 7]], ['3 days, then a fortnight', [3, 14]],
  ['first 3 days, after that weekly', 'R'], ['3\n5', [3, 5]], ['7d then 3d', [7, 3]], ['1w', [7]], ['3days', [3]], ['3-day gap', [3]], ['a 3 day gap', [3]],
  ['the default', null], ['default', null], ['back to the default', null], ['the usual', null], ['reset', null], ['go back to normal', null],
  ['the default: set by how far off the event is (recommended)', null], ['let the event date decide', null], ['not the default, 3 days', 'R'], ['3 days (the default is fine too)', 'R'],
  ['daily', [1]], ['every day', [1]], ['a day', [1]], ['weekly', [7]], ['every week', [7]], ['once a week', [7]],
  ['every other day', [2]], ['every second day', [2]], ['every other week', [14]], ['every 3rd day', [3]], ['every third day', [3]],
  ['48 hours', [2]], ['72h', [3]], ['a couple of days', [2]], ['couple days', [2]], ['about 3 days', [3]], ['at least 3 days', 'R'], ['in 3 days', [3]],
  ['5 days after the first, then 3', 'R'], ['3 days after the first email and 5 after the second', 'R'], ['3 days for the first follow-up, 2 for the rest', 'R'],
  ['wait a week before the first follow-up then 3 days', 'R'], ['3 days is fine', [3]], ['sure, 3 days', [3]], ['give it a week', [7]], ['lets say 4 days', [4]],
  ['quince días', [14]], ['par défaut', null], ['alle 3 Tage', [3]], ['jeden Tag', [1]], ['onze jours', [11]], ['in 2 weeks', [14]],
  ['the default but slower', 'R'], ['not the usual', 'R'], ['never the default', 'R'], ["don't reset", 'R'], ['longer than the default', 'R'],
  ['double the default', 'R'], ['anything but the default', 'R'], ['standard, except LinkedIn', 'R'], ['reset my route', 'R'],
  ['a week and 2 days', 'R'], ['1 week, 2 days', 'R'], ['two weeks and a day', 'R'], ['a week, then 2 days', [7, 2]],
  ['3 emails', 'R'], ['every 3 emails', 'R'], ['email 3', 'R'], ['1/2 day', 'R'], ['2/5/7', 'R'], ['the second after 5 days', 'R'], ['for the second 5', 'R'], ['make it 4', [4]], ['4 please', [4]], ['3 days!', [3]], ['  7  ', [7]],
  ['3 días', [3]], ['tres días', [3]], ['cada 3 días', [3]], ['una semana', [7]], ['dos semanas', [14]], ['3 días, luego una semana', [3, 7]], ['2 días, luego 5', [2, 5]],
  ['por defecto', null], ['el valor por defecto', null], ['predeterminado', null], ['3 Tage', [3]], ['une semaine', [7]], ['3 jours', [3]],
  ['twice a week', 'R'], ['3x a week', 'R'], ['two per week', 'R'], ['2 emails a week', 'R'], ['between 3 and 5 days', 'R'], ['3 to 4', 'R'], ['3-4 days', 'R'], ['3 or 4 days', 'R'],
  ['day 3, day 7', 'R'], ['on day 3 and day 7', 'R'], ['-2', 'R'], ['- 2 days', 'R'], ['1.5 days', 'R'], ['1,5 days', 'R'], ['1,5', 'R'], ['2,5', 'R'], ['2,5 días', 'R'],
  ['a day and a half', 'R'], ['half a week', 'R'], ['a few days', 'R'], ['3 days or so', 'R'], ['3ish', 'R'], ['3 business days', 'R'], ['3 working days', 'R'],
  ['2 follow-ups, 3 days apart', 'R'], ['3 days for email, 5 for linkedin', 'R'], ['3 days and then whenever', 'R'], ['3 days, then something else', 'R'],
  ['none', 'R'], ['no follow-ups', 'R'], ['no', 'R'], ['yes', 'R'], ['ok', 'R'], ['skip', 'R'], ['asap', 'R'], ['whatever you think', 'R'], ['same as before', 'R'],
  ['tomorrow', 'R'], ['next week', 'R'], ['0', 'R'], ['zero days', 'R'], ['15 days', 'R'], ['3 weeks', 'R'], ['a month', 'R'], ['1,2,3,4,5,6,7,8', 'R'],
  ['1 week 2 days', 'R'], ['3 days 5 days', 'R'], ['default, 3 days', 'R'], ['no more than 5 days', 'R'], ['up to 5 days', 'R'], ['max 5', 'R'], ['2nd', 'R'],
  ['3 days?', 'R'], ['III', 'R'], ['a', 'R'], ['', 'R'], ['７ days', 'R'], ['your own, like "2 days, then 5"', 'R']
];

// The closed list of words an answer may hold besides numbers and units, as reviewed: a word added to lib/gap-words.mjs
// fails here until it is reviewed too (it must not be able to change what the numbers mean).
const REVIEWED_FILLER = [
  'a', 'an', 'the', 'of', 'in', 'every', 'each', 'apart', 'between', 'follow-up', 'follow-ups', 'followup', 'followups',
  'message', 'messages', 'gap', 'gaps', 'wait', 'please', 'thanks', 'thank', 'you', 'ok', 'okay', 'sure', 'about', 'around',
  'roughly', 'it', 'give', 'make', 'lets', "let's", 'say', 'is', 'fine', 'just'
];
test('the filler words are a reviewed, closed list: no negation, comparison, exception, ordinal, channel or question word', () => {
  assert.deepEqual([...FILLER].sort(), [...REVIEWED_FILLER].sort());
  for (const w of ['not', 'never', 'no', 'but', 'except', 'unless', 'more', 'less', 'longer', 'shorter', 'double', 'half', 'first', 'second', 'last', 'next', 'email', 'linkedin', 'app', 'what', 'why', 'how', 'when'])
    assert.ok(!FILLER.includes(w), w);
});

test('every refusal tells the model what it may send for the user, and to say back what was saved', () => {
  for (const said of ['soon', 'the default but slower', '1,5', 'none', 'a week and 2 days', 'for the second 5'])
    assert.throws(() => parseGap(said), /answer again in that form \("N days", "N, M days" or "default"\), then say back exactly what was saved/, said);
});

test('every answer is read whole or refused with what to type: never half an answer', () => {
  for (const [said, want] of PHRASES) {
    let got,
      err = null;
    try {
      got = parseGap(said);
    } catch (e) {
      err = e.message;
    }
    if (want === 'R') {
      assert.ok(err, `${JSON.stringify(said)} was saved as ${JSON.stringify(got)}`);
      assert.match(err, /Say how many whole days|say them, for example/, `${JSON.stringify(said)}: ${err}`);
    } else assert.deepEqual(err ? `refused: ${err}` : got, want, JSON.stringify(said));
  }
  assert.match((() => { try { parseGap('none'); } catch (e) { return e.message; } })(), /route has to be one message long/);
  assert.match((() => { try { parseGap('1,5'); } catch (e) { return e.message; } })(), /part day, or one gap then another/);
});

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
function ready(home, slug, name, attendees) {
  const H = setup({ attendees, home, event: { slug, name }, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  draftApprove(H);
  return H;
}
function sendListed(H, now) {
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], now);
  const items = existsSync(list.file || '') ? JSON.parse(readFileSync(list.file, 'utf8')) : [];
  const sends = [];
  for (const it of items) if (guard(H, { to: it.to, subject: it.subject, body: it.body }, now).status === 0) sends.push({ id: it.id, touch: it.touch, message_id: `m-${it.id}-${it.touch}` });
  if (sends.length) cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends })], now);
  return sends.map((x) => `${x.id}:${x.touch}`);
}

test('the gap answer counts moved and dropped follow-ups as they then happen, at this event and another, against a home that never heard it', () => {
  const homes = [mkdtempSync(join(tmpdir(), 'fb-gap-')), mkdtempSync(join(tmpdir(), 'fb-ctl-'))];
  const ev = homes.map((h) => [
    ready(h, 'ev', 'Test Expo', 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n'),
    ready(h, 'ev2', 'Other Expo', 'Name,Title,Company,Email\nCy Ng,COO,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\n')
  ]);
  for (const pair of ev) for (const H of pair) assert.equal(sendListed(H, NOW).length, 2, 'first messages went');
  // Only the first home hears "two weeks", on Wed 14 Oct.
  const H = ev[0][0];
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(join(H.HOME, 'work', 'gap.json'), JSON.stringify('two weeks'));
  const r = spawnSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', 'ev', '--ask', 'followup_gap', '--value-file', join(H.HOME, 'work', 'gap.json')], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: at('2026-10-14') }, encoding: 'utf8' });
  const note = JSON.parse(r.stdout).result.note;
  // Every day a follow-up could go, in both homes: what was sent, and when.
  const went = ev.map((pair) => pair.map(() => ({})));
  for (const day of ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-12'])
    ev.forEach((pair, i) => pair.forEach((Hx, j) => { for (const k of sendListed(Hx, at(day))) went[i][j][k] = day; }));
  const counts = (j) => {
    const a = went[0][j], ctl = went[1][j];
    return { moved: Object.keys(a).filter((k) => ctl[k] && ctl[k] !== a[k]).length, dropped: Object.keys(ctl).filter((k) => !a[k]).length };
  };
  const other = counts(1);
  assert.deepEqual(other, { moved: 4, dropped: 2 }, JSON.stringify(went));
  assert.match(note, new RegExp(`At Other Expo: ${other.moved} approved follow-ups change day and ${other.dropped} are dropped`), note);
  const here = counts(0);
  assert.deepEqual(here, { moved: 4, dropped: 2 });
  const ana = idOf(H, 'Ana Berg');
  assert.ok(!went[0][0][`${ana}:4`] && went[1][0][`${ana}:4`] === '2026-11-02');
  assert.match(note, /Ana Berg follow-up 3: \d+ days after message 3 goes → dropped/, note);
  assert.match(note, /Ana Berg follow-up 1: Mon 19 Oct → Mon 26 Oct/, note);
});
