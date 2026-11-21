// Every reader gives the guard's answer, with its reason, and never throws, on an event file or a ledger edited by hand:
// odd or missing dates and zones with a sequence under way (the outbox page, send-list, task-list, todo, the stage list,
// the flow, the gap answer), a start after the end, a day that doesn't exist, a send recorded with no date or a bad one;
// a sent step gets no draft; and the gap parser refuses an answer cut off after a connector. Then: a day the clock
// can't make (month 13, day 00), setup refusing one, the disclaimer first, the flow asking about a stopped guard's send,
// and odd person lines at the event itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, idOf, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { eventStateAt, MARKER_LIVE_MS } from '../lib/sendcheck.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';
import { parseGap } from '../lib/gap-words.mjs';
import { followupDay, noDayWhy, UNREADABLE_DATES, isDateKey } from '../lib/spacing.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const D14 = at('2026-10-14', '09:00');
const DATES = /can't read this event's dates/;
const file = (H, data) => {
  const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const guard = (H, input, now, tool = 'mcp__gmail__send_email') =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: tool, tool_input: input, session_id: 's1' }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);

function ready({ sending = true } = {}) {
  const H = setup({ attendees: PEOPLE, settings: { ...(sending ? { sending: { channels: ['email'], followups: 'scheduled' } } : {}), route: ['email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, stage_draft: STAGE }, followup_gap: [1], disclaimer_ack: true }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
function approveRounds(H, now = NOW) {
  for (let i = 0; i < 6; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => x.kind === 'message' && !x.waits_for_previous)) {
      const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x, no research profile', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], now);
      cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
function itemFor(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  return { id, touch, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now };
}
const writeList = (H, items) => writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify(items));
function hook(H, id, touch, now) {
  nobody(H, now);
  const it = itemFor(H, id, touch, now);
  writeList(H, [it]);
  return guard(H, { to: it.to, subject: it.subject, body: it.body }, now);
}
// Gap 1, three emails: message 1 went on Mon 12 Oct (through the hook, with its receipt); follow-ups approved.
function started() {
  const H = ready();
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.equal(hook(H, ana, 1, NOW).status, 0);
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id: ana, touch: 1, message_id: 'm1' }] })], NOW);
  return { H, ana, good: JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')) };
}
const setEvent = (H, ev) => writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
const gapAnswer = (H, words, now) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'gap.json');
  writeFileSync(f, JSON.stringify(words));
  return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'followup_gap', '--value-file', f], now);
};
const NO_THROW = /isn't a date like|Invalid time zone|Invalid time value|Cannot read properties/;
// Every reader of an event under way: none throws, and each one that names message 2 gives `reason`.
function readersSay(H, ana, reason, label) {
  nobody(H, D14);
  const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], D14);
  assert.doesNotMatch(sl.ERROR || '', NO_THROW, `${label} send-list`);
  assert.equal(sl.to_send, 0, `${label} send-list lists nothing`);
  const w2 = (sl.waiting || []).find((w) => w.id === ana && w.touch === 2);
  assert.match(w2?.why || '', reason, `${label} send-list: ${w2?.why}`);
  for (const cmd of ['task-list', 'todo', 'summary', 'stage-list']) {
    const r = cli(H, 'event-outreach', [cmd, '--event', H.slug], D14);
    assert.ok(!r.ERROR, `${label} ${cmd}: ${r.ERROR}`);
    // Where the event's own dates are the reason, each list says so.
    if (reason === DATES) assert.match(r.note || '', DATES, `${label} ${cmd} says why`);
  }
  const o = cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], D14);
  assert.ok(!o.ERROR, `${label} page: ${o.ERROR}`);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.doesNotMatch(html, /the event is over|no room left before the event ends/, `${label}: the card names the dates, not "over"`);
  const g = hook(H, ana, 2, D14);
  assert.equal(g.status, 2, label);
  assert.match(g.stderr, reason, label);
}

test('C1, C2, C3, C5: odd, missing or out-of-order event dates with a sequence under way: every reader runs and gives the dates reason, as the guard does', () => {
  const { H, ana, good } = started();
  const cases = [
    ['start 12/11/2026', { ...good, start_date: '12/11/2026' }],
    ['start a time stamp', { ...good, start_date: '2026-11-10T00:00:00Z' }],
    ['end missing', (({ end_date, ...rest }) => rest)(good)],
    ['end null', { ...good, end_date: null }],
    ['end ""', { ...good, end_date: '' }],
    ['end a number', { ...good, end_date: 20261112 }],
    ['start after end', { ...good, start_date: '2026-11-12', end_date: '2026-11-10' }],
    ['a day that does not exist', { ...good, end_date: '2026-11-31' }],
    ['a month that does not exist', { ...good, start_date: '2026-13-01', end_date: '2026-13-02' }],
    ['day 00', { ...good, start_date: '2026-11-00' }]
  ];
  for (const [label, ev] of cases) {
    setEvent(H, ev);
    assert.equal(eventStateAt(H.dir, Date.parse(D14)).state, 'unreadable', label);
    readersSay(H, ana, DATES, label);
  }
  // The gap answer runs too, and says this event can't be planned now.
  const r = gapAnswer(H, '2 days', D14);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(JSON.stringify(r), /can't be planned now/);
});

test('C4: an unreadable zone: the flow stops with the dates reason after the disclaimer, todo gives no job and says why, the gap answer runs', () => {
  const H = ready();
  approveRounds(H);
  const good = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  for (const zone of ['Mars/Olympus', '', 123, ' Europe/Amsterdam']) {
    setEvent(H, { ...good, time_zone: zone });
    const f = cli(H, 'flow', ['next', '--event', H.slug], D14);
    assert.ok(!f.ERROR, `${zone}: ${f.ERROR}`);
    assert.equal(f.step, 'done', JSON.stringify(f).slice(0, 200));
    assert.match(f.why, DATES);
    const t = cli(H, 'event-outreach', ['todo', '--event', H.slug], D14);
    assert.ok(!t.ERROR, t.ERROR);
    assert.match(t.note || '', DATES, JSON.stringify(t).slice(0, 200));
    const g = gapAnswer(H, '2 days', D14);
    assert.ok(!g.ERROR, `${zone}: ${g.ERROR}`);
  }
});

test('C5, M12, M15: an event whose dates can\'t be read gets no draft staged: the stage list lists none, the stage check refuses a first message and a follow-up', () => {
  const H = ready({ sending: false });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  const good = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], NOW);
  assert.equal(sl.to_stage, 1, 'listed while the dates can be read');
  const [it] = JSON.parse(readFileSync(sl.file, 'utf8'));
  for (const [label, ev] of [['start 12/11/2026', { ...good, start_date: '12/11/2026' }], ['zone Mars', { ...good, time_zone: 'Mars/Olympus' }], ['end ""', { ...good, end_date: '' }], ['start after end', { ...good, start_date: '2026-11-12', end_date: '2026-11-10' }]]) {
    setEvent(H, ev);
    assert.equal(cli(H, 'event-outreach', ['stage-list', '--event', H.slug], NOW).to_stage, 0, `${label}: stage-list`);
    // The list made while they could be read: the real hook refuses its first message, with the reason.
    writeFileSync(join(H.dir, 'stage-list.json'), JSON.stringify([{ ...it, listed_at: NOW }]));
    const g = guard(H, { to: it.to, subject: it.subject, body: it.body }, at('2026-10-12', '08:05'), 'mcp__gmail__create_draft');
    assert.equal(g.status, 2, `${label}: create_draft`);
    assert.match(g.stderr, DATES, label);
    process.env.FLOORBOSS_HOME = H.HOME;
    assert.match(stageRefusal(H.dir, { id: ana, touch: 2, to: 'ana@acme.test', listed_at: NOW }, Date.parse(NOW)) || '', DATES, `${label}: a follow-up`);
  }
});

test('C6: a send date that isn\'t a date: the gap answer saves instead of throwing, and gives the step after it no day', () => {
  const { H, ana } = started();
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: at('2026-10-13'), type: 'sent', who: 'user', id: ana, touch: 2, date: 'tomorrow' })}\n`);
  const r = gapAnswer(H, '2 days', D14);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.saved, 'followup_gap');
  // Message 3 counts from that date before and after the change alike, so no day of it is said to move.
  assert.match(r.say_to_user, /No approved follow-up changes day/);
});

test('C7: a send date for a day that doesn\'t exist (2026-02-30) is not a date: the next step waits with the note at send-list and the guard', () => {
  const { H, ana } = started();
  const lines = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const e of lines) if (e.type === 'sent' && e.id === ana && e.touch === 1) e.date = '2026-02-30';
  writeFileSync(join(H.dir, 'ledger.jsonl'), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
  readersSay(H, ana, /\("2026-02-30"\) isn't a date floorboss can read/, '2026-02-30');
});

test('C8: a send recorded with no date still went: that step is never listed or sent again, and the next one waits with a note', () => {
  const { H, ana } = started();
  const keep = readFileSync(join(H.dir, 'ledger.jsonl'));
  for (const date of ['', null, undefined, 0, false]) {
    writeFileSync(join(H.dir, 'ledger.jsonl'), keep);
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: at('2026-10-13'), type: 'sent', who: 'user', id: ana, touch: 2, ...(date === undefined ? {} : { date }) })}\n`);
    nobody(H, D14);
    const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], D14);
    const listed = existsSync(sl.file || '') ? JSON.parse(readFileSync(sl.file, 'utf8')) : [];
    assert.ok(!listed.some((x) => x.id === ana && x.touch === 2), `${JSON.stringify(date)}: message 2 isn't listed again`);
    assert.match((sl.waiting || []).find((w) => w.id === ana && w.touch === 3)?.why || '', /recorded as sent with no date/, JSON.stringify(date));
    const g = hook(H, ana, 2, D14);
    assert.equal(g.status, 2, JSON.stringify(date));
    assert.match(g.stderr, /already sent/);
    const g3 = hook(H, ana, 3, D14);
    assert.equal(g3.status, 2);
    assert.match(g3.stderr, /recorded as sent with no date/);
  }
});

test('C10: a step recorded as sent gets no draft: the stage check refuses one listed by hand, as the stage list does', () => {
  const H = ready({ sending: false });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items: [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'I sent it from my phone' }] })], at('2026-10-12', '09:00'));
  const now = at('2026-10-12', '09:05');
  assert.equal(cli(H, 'event-outreach', ['stage-list', '--event', H.slug], now).to_stage, 0);
  const it = itemFor(H, ana, 1, now);
  writeFileSync(join(H.dir, 'stage-list.json'), JSON.stringify([{ ...it, touch: 1, listed_at: now }]));
  const g = guard(H, { to: it.to, subject: it.subject, body: it.body }, now, 'mcp__gmail__create_draft');
  assert.equal(g.status, 2);
  assert.match(g.stderr, /it was already sent/);
});

test('C9: an answer cut off after a connector or a word that needs more is refused, never saved as what came before', () => {
  for (const s of ['3 days, then', '3 days and', '3 días, luego', '3 días, y', '3 jours, puis', '3 days, dann', '3 days, after that', '3 days followed by', '3 days, 5 days, then', 'a week, then', '3 days, the', '3 days, every', '3 days, then every', '3 days, of'])
    assert.throws(() => parseGap(s), /isn't a number of whole days floorboss can read whole/, s);
  // "After that" at the end is cut off only with nothing before it in its part.
  for (const s of ['3 days, then after that', '3 days and after that', 'after that', '3 days; after that'])
    assert.throws(() => parseGap(s), /isn't a number of whole days floorboss can read whole/, s);
  for (const [s, v] of [['3 days, then 5 days after that', [3, 5]], ['a week, then two weeks after that', [7, 14]], ['2 days and then 4 days after that', [2, 4]], ['3 days, and 5 after that', [3, 5]], ['a week after that', [7]], ['3 days, then a week after that', [3, 7]]])
    assert.deepEqual(parseGap(s), v, s);
  for (const [s, v] of [['3 days', [3]], ['3 days, then 5', [3, 5]], ['3 days each', [3]], ['every 3 days', [3]], ['3 days, please', [3]], ['3 days, thanks', [3]], ['2 days, then 5 days', [2, 5]], ['3 days apart', [3]], ['3 days in between', [3]], ['3 days between each', [3]]])
    assert.deepEqual(parseGap(s), v, s);
});

test('C1: the one rule for a follow-up\'s day gives no day, with the dates reason, for dates it can\'t read, whoever asks it', () => {
  for (const ev of [{ start_date: '12/11/2026', end_date: '2026-11-12' }, { start_date: '2026-11-10', end_date: '' }, { start_date: '2026-11-10' }, { start_date: '2026-11-12', end_date: '2026-11-10' }, { start_date: '2026-11-10', end_date: '2026-11-31' }]) {
    const r = followupDay({ followup_gap: [1] }, { time_zone: 'UTC', ...ev }, { prevSent: '2026-10-12', touch: 2, today: '2026-10-14' });
    assert.equal(r.day, null, JSON.stringify(ev));
    assert.equal(noDayWhy(r), UNREADABLE_DATES, JSON.stringify(ev));
  }
});

// ---- Round 8, second pass.
test('A-F1: a day the clock can\'t make (month 13, day 32, day 00) is no date, never a thrown "Invalid time value": as a send date, the step after it waits with the note, at every reader and the guard', () => {
  for (const k of ['2026-13-45', '2026-12-32', '2026-11-00', '2026-02-30', '2026-13-01']) assert.equal(isDateKey(k), false, k);
  for (const k of ['2026-11-12', '2028-02-29']) assert.equal(isDateKey(k), true, k);
  const { H, ana } = started();
  const lines = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const e of lines) if (e.type === 'sent' && e.id === ana && e.touch === 1) e.date = '2026-13-45';
  writeFileSync(join(H.dir, 'ledger.jsonl'), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
  readersSay(H, ana, /\("2026-13-45"\) isn't a date floorboss can read/, '2026-13-45');
  const r = gapAnswer(H, '2 days', D14);
  assert.ok(!r.ERROR, r.ERROR);
});

test('A-F5: event setup refuses a day that doesn\'t exist', () => {
  const H = ready();
  for (const [start, end] of [['2026-13-01', '2026-13-02'], ['2026-11-00', '2026-11-02'], ['2026-11-31', '2026-12-01'], ['2026-02-30', '2026-03-01']]) {
    const r = cli(H, 'slot-finder', ['create', '--name', 'Typo Expo', '--city', 'Lisbon', '--zone', 'Europe/Lisbon', '--start', start, '--end', end]);
    assert.match(r.ERROR || '', /Dates must be days that exist, like 2026-10-27/, `${start} ${end}: ${JSON.stringify(r).slice(0, 120)}`);
  }
  assert.ok(!cli(H, 'slot-finder', ['create', '--name', 'Good Expo', '--city', 'Lisbon', '--zone', 'Europe/Lisbon', '--start', '2026-11-30', '--end', '2026-12-01']).ERROR);
});

test('the flow asks for the disclaimer first, even for an event whose dates can\'t be read', () => {
  const H = ready();
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  delete cfg.disclaimer_ack;
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(cfg));
  const good = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  setEvent(H, { ...good, time_zone: 'Mars/Olympus' });
  const f = cli(H, 'flow', ['next', '--event', H.slug], D14);
  assert.ok(!f.ERROR, f.ERROR);
  assert.equal(f.step, 'disclaimer', JSON.stringify(f).slice(0, 200));
});

test('C-R8-7: the flow asks about a follow-up whose guard stopped between its marker and its release, once no live guard can hold it', async () => {
  const { H, ana } = started();
  mkdirSync(join(H.dir, 'released'), { recursive: true });
  const mark = join(H.dir, 'released', `${ana}-2-0`);
  writeFileSync(mark, '');
  const old = new Date(Date.now() - 2 * MARKER_LIVE_MS);
  utimesSync(mark, old, old);
  nobody(H, D14);
  const keep = { home: process.env.FLOORBOSS_HOME, now: process.env.FLOORBOSS_NOW };
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = D14;
  try {
    const { context } = await import('../skills/flow/scripts/context.mjs');
    const { sendSteps } = await import('../skills/flow/scripts/steps/sending.mjs');
    const c = context(H.slug, { now: D14 });
    const s = sendSteps({ c, cfg: c.cfg, mock: false, e: c.event, mailOk: true });
    assert.equal(s?.step, 'send_outcome', JSON.stringify(s).slice(0, 200));
    assert.equal(s.ask?.person?.touch, 2);
  } finally {
    process.env.FLOORBOSS_HOME = keep.home;
    if (keep.now === undefined) delete process.env.FLOORBOSS_NOW;
    else process.env.FLOORBOSS_NOW = keep.now;
  }
});

test('an event\'s own readers on odd person lines (lines: 5, keys: 7, the id __proto__ or constructor, no id at all) never throw; a line naming no person floorboss can have holds everyone with its line number', () => {
  const { H, ana } = started();
  const keep = readFileSync(join(H.dir, 'ledger.jsonl'));
  for (const [label, line, held] of [
    ['lines: 5', { type: 'person', who: 'floorboss', id: ana, email: 'ana@acme.test', name: 'Ana Berg', lines: 5 }, false],
    ['keys: 7', { type: 'person', who: 'floorboss', id: ana, email: 'ana@acme.test', name: 'Ana Berg', keys: 7 }, false],
    ['__proto__', { type: 'person', who: 'floorboss', id: '__proto__', email: 'zed@other.test', name: 'Zed' }, true],
    ['constructor', { type: 'person', who: 'floorboss', id: 'constructor', email: 'zed@other.test', name: 'Zed' }, true],
    ['no id', { type: 'person', who: 'floorboss', email: 'zed@other.test', name: 'Zed' }, true]
  ]) {
    writeFileSync(join(H.dir, 'ledger.jsonl'), keep);
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: at('2026-10-13'), ...line })}\n`);
    nobody(H, D14);
    const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], D14);
    assert.ok(!sl.ERROR, `${label} send-list: ${sl.ERROR}`);
    for (const cmd of ['task-list', 'todo', 'summary', 'stage-list']) assert.ok(!cli(H, 'event-outreach', [cmd, '--event', H.slug], D14).ERROR, `${label} ${cmd}`);
    assert.ok(!cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], D14).ERROR, `${label} page`);
    const w2 = (sl.waiting || []).find((w) => w.id === ana && w.touch === 2);
    if (held) assert.match(w2?.why || '', /line \d+ of the ledger is damaged|the ledger has a damaged line \(line \d+\)/, `${label}: ${JSON.stringify(sl).slice(0, 300)}`);
    else assert.ok(JSON.parse(readFileSync(sl.file, 'utf8')).some((x) => x.id === ana && x.touch === 2), `${label}: message 2 is listed`);
  }
  // A line that is JSON but no entry at all ("null", a list): damaged, never read as an entry or thrown on.
  for (const raw of ['null', '[]', '7']) {
    writeFileSync(join(H.dir, 'ledger.jsonl'), keep);
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${raw}\n`);
    for (const cmd of ['summary', 'todo', 'task-list']) assert.ok(!cli(H, 'event-outreach', [cmd, '--event', H.slug], D14).ERROR, `${raw} ${cmd}`);
    nobody(H, D14);
    const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], D14);
    assert.ok(!sl.ERROR, `${raw}: ${sl.ERROR}`);
    assert.match((sl.waiting || []).find((w) => w.id === ana && w.touch === 2)?.why || '', /line \d+ of the ledger is damaged|the ledger has a damaged line \(line \d+\)/, raw);
  }
});

test('S2: an answer cut off at its end by a mark that leads to more (",", ";", ":", a dash, "...") is asked again, never saved as what came before it', () => {
  for (const s of ['3 days: after that', '3 days : after that', '3 days:after that', '3 days:', '3 days,', '3 days;', '3 days -', '3 days –', '3 days —', '3 days...', '3 days..', '3 days…', '3 days, 5 days,', '3 days, 5...', '3 days, then 5:', '3,', '3...', '3 days,,', 'the default:', 'default...', '3 days, .', '3 days...!'])
    assert.throws(() => parseGap(s), /isn't a number of whole days floorboss can read whole/, s);
  // A trailing "and" or "then", in any language floorboss reads, was already cut off.
  for (const s of ['3 days and', '3 days, then', '3 days and then', '3 days then:', '3 días, y', '3 jours, puis'])
    assert.throws(() => parseGap(s), /isn't a number of whole days floorboss can read whole/, s);
  // The same mark before an approving emoji or the option label, and dots written with spaces between them.
  for (const s of ['3 days, 👍', '3 days: 👍', '3 days... 👍', '3 days, (recommended)', '3 days... (recommended)', '3 days, 👍.', '3 days. .', '3 days . .', '3 days . . .', 'default, 👍'])
    assert.throws(() => parseGap(s), /isn't a number of whole days floorboss can read whole/, s);
  // Whole answers with the same marks inside them, or one full stop or "!" at the end, still read.
  for (const [s, v] of [['3 days.', [3]], ['3 days!', [3]], ['3 days!!', [3]], ['Default.', null], ['gap: 3 days', [3]], ['weeks: 2', [14]], ['days: 3, 5', [3, 5]], ['3 days: then 5', [3, 5]], ['3 days; then 5.', [3, 5]], ['3 days after that', [3]], ['3 days, then 5 days after that', [3, 5]], ['3 days 👍', [3]], ['3 days. 👍', [3]], ['3 days 👍.', [3]], ['3 days (recommended).', [3]], ['Default (recommended)', null], ['3 days, 5 days 👍', [3, 5]]])
    assert.deepEqual(parseGap(s), v, s);
});
