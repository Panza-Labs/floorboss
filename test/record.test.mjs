// Recording what the user says happened (outreach record) and the prompt hook that reminds Claude to.
// Sends, off-grid bookings, cuts and additions the user tells Claude in words must reach floorboss's log, or the
// next run would write to everyone again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, todoJobs, groups, ROOT, NOW } from './fixtures/harness.mjs';
import { reminder, liveEvents } from '../hooks/remind.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nSam Lee,COO,Initech,sam@initech.test\nSam Lee,VP Ops,Hooli,sam@hooli.test\nEve Moss,COO,Umbrella,eve@umbrella.test\n';

function ready() {
  const H = setup({ attendees: ATT });
  // Eve wasn't picked (she didn't fit): the user adds her later. The shortlist is a view of the ledger, so
  // she is left off through her fit, not by editing shortlist.json.
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: r.name === 'Eve Moss' ? null : 'ops-leaders', reason: `${r.title} at ${r.company}`, score: r.name === 'Eve Moss' ? 10 : 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  assert.ok(!JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).approved.includes(idOf(H, 'Eve Moss')), 'Eve starts off the shortlist');
  draftApprove(H);
  return H;
}
const rec = (H, items, extra = []) => { const f = join(H.dir, `report-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ items })); return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f, ...extra]); };
const log = (H) => readLedger(join(H.dir, 'ledger.jsonl')).entries;
const state = (H) => { const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl')); return fold(entries, damaged); };
// The floorboss slots taken by a booking, from the ledger (slots.json no longer carries them).
const booked = (H) => [...new Set(Object.values(state(H).people).flatMap((p) => (p.booked ? p.booked_blocks || [p.booked] : [])))].sort();

test('record: sends, an off-grid booking, a cut and an addition reach the log, and the next run respects them', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg'), bo = idOf(H, 'Bo Li'), eve = idOf(H, 'Eve Moss');
  const r = rec(H, [
    { who: 'Ana Berg', what: 'sent', date: '2026-10-12', channel: 'Brella', text: 'Hey Ana, edited by hand.' },
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:40', said: 'she moved it to 10:40' },
    { who: 'Bo Li', what: 'cut', reason: 'not a fit after all' },
    { who: 'Eve Moss', company: 'Umbrella', what: 'sent', channel: 'Brella' },
  ]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.recorded.length, 4);
  assert.match(r.recorded[1], /booked: Ana Berg \(Acme\).*not one of your slots/);
  assert.match(r.recorded[3], /added to the shortlist/);
  const L = log(H);
  assert.ok(L.some((e) => e.type === 'sent' && e.id === ana && e.text === 'Hey Ana, edited by hand.' && e.who === 'user'));
  assert.ok(L.some((e) => e.type === 'booked' && e.id === ana && e.start === '2026-11-10T09:40:00.000Z' && e.said));
  assert.ok(L.some((e) => e.type === 'decide' && e.group === 'skip' && e.id === bo));
  const S = state(H);
  assert.equal(S.people[ana].touches[1].sent.text, 'Hey Ana, edited by hand.');
  assert.equal(S.people[bo].decision.group, 'skip');
  assert.equal(S.people[eve].decision.group, 'reach');
  assert.ok(JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'shortlist.json'), 'utf8')).approved.includes(eve));
  // The 10:40 meeting overlaps the 11:00 slot (10:00Z): nobody else is offered it.
  assert.deepEqual(booked(H), ['s20261110T1100']);
  const { jobs } = todoJobs(H);
  assert.ok(!jobs.some((j) => j.id === ana && j.kind === 'message'), 'Ana is booked: no first message again');
  assert.ok(!jobs.some((j) => j.id === bo), 'Bo was cut');
  assert.ok(!jobs.some((j) => j.id === eve && j.touch === 1), 'Eve was already sent her first message');
  assert.ok(!jobs.some((j) => (j.slot_ids || []).includes('s20261110T1100')), 'the booked time goes to nobody else');
});

test('record: a moved meeting frees its old time; a cancelled one frees it too', () => {
  const H = ready();
  rec(H, [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }]);
  assert.deepEqual(booked(H), ['s20261110T1000']);
  const m = rec(H, [{ who: 'Ana Berg', what: 'moved', time: '2026-11-10 13:00' }]);
  assert.match(m.recorded[0], /moved: Ana Berg/);
  assert.deepEqual(booked(H), ['s20261110T1300']);
  // The old time is offered to others again.
  const freed = todoJobs(H).jobs.filter((j) => j.id !== idOf(H, 'Ana Berg'));
  assert.ok(!freed.some((j) => (j.slot_ids || []).includes('s20261110T1300')), 'the new time goes to nobody else');
  rec(H, [{ who: 'Ana Berg', what: 'cancelled' }]);
  assert.deepEqual(booked(H), []);
});

test('record: all or nothing; an ambiguous or unknown name records nothing and says which', () => {
  const H = ready();
  const before = log(H).length;
  const amb = rec(H, [{ who: 'Ana Berg', what: 'sent' }, { who: 'Sam Lee', what: 'sent' }]);
  assert.match(amb.ERROR, /Nothing was recorded.*"Sam Lee" matches 2 people.*Initech.*Hooli/s);
  assert.match(rec(H, [{ who: 'Zed Nobody', what: 'replied' }]).ERROR, /nobody called "Zed Nobody"/);
  assert.match(rec(H, [{ who: 'Ana Berg', what: 'booked', time: 'monday 3:40' }]).ERROR, /YYYY-MM-DD HH:MM/);
  assert.match(rec(H, [{ who: 'Ana Berg', what: 'emailed' }]).ERROR, /"what" must be one of/);
  assert.equal(log(H).length, before, 'nothing written');
  assert.equal(rec(H, [{ who: 'Sam Lee', company: 'Hooli', what: 'sent' }]).applied, true, 'the company settles it');
});

test('record: --check writes nothing; the same send reported twice is recorded once; a clash is refused', () => {
  const H = ready();
  const before = log(H).length;
  const chk = rec(H, [{ who: 'Ana Berg', what: 'sent' }], ['--check']);
  assert.equal(chk.applied, false);
  assert.match(chk.would_record[0], /sent to Ana Berg/);
  assert.equal(log(H).length, before);
  rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }]);
  const again = rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12', touch: 1 }]);
  assert.equal(again.already_recorded, 1);
  assert.equal(log(H).filter((e) => e.type === 'sent').length, 1);
  rec(H, [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00' }]);
  assert.match(rec(H, [{ who: 'Bo Li', what: 'booked', time: '2026-11-10 10:15' }]).ERROR, /overlaps a meeting already booked with Ana Berg/);
});

test('record: a stop goes on the do-not-contact list for every event', () => {
  const H = ready();
  const bo = idOf(H, 'Bo Li');
  rec(H, [{ who: 'Bo Li', what: 'stop', said: 'he asked me not to message again' }]);
  assert.equal(state(H).people[bo].stopped, true);
  // A second event in the same home with Bo on its list: he is held there after its load.
  const H2 = setup({ home: H.HOME, attendees: 'Name,Title,Company,Email\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,COO,Initech,cy@initech.test\n', event: { slug: 'ev2', name: 'Second Expo' } });
  triage(H2);
  const g = groups(H2);
  assert.equal(g['Bo Li'], 'suppressed', JSON.stringify(g));
  assert.notEqual(g['Cy Ng'], 'suppressed');
  assert.ok(!todoJobs(H2).jobs.some((j) => j.contact?.name === 'Bo Li'), 'nothing is drafted to Bo at the second event');
});

test('remind hook: an outreach report during a live event reminds Claude to record it; anything else is left alone', () => {
  const ev = [{ slug: 'harbour-expo', name: 'Harbour Expo' }];
  assert.match(reminder('i sent ana ruiz, bo li, cy ng', ev), /record --event <slug>/);
  assert.match(reminder('he rescheduled it to 3:40pm', ev), /floorboss is tracking "Harbour Expo"/);
  assert.match(reminder('ok i sent all but Di + Ed', ev), /record/);
  assert.equal(reminder('what does the weather look like in rotterdam', ev), null);
  assert.equal(reminder('i sent ana the note', []), null, 'no live event, no reminder');
  // Live: has a shortlist and ended no more than 14 days ago.
  const H = ready();
  const now = Date.parse(NOW);
  assert.deepEqual(liveEvents(join(H.HOME, 'events'), now).map((e) => e.slug), [H.slug]);
  assert.deepEqual(liveEvents(join(H.HOME, 'events'), Date.parse('2026-12-01T00:00:00Z')), [], 'two weeks after the event');
  // As a hook: JSON context on stdout, exit 0, and silence on junk input.
  const run = (input) => spawnSync('node', [join(ROOT, 'hooks/remind.mjs')], { input, env: { ...process.env, FLOORBOSS_HOME: H.HOME }, encoding: 'utf8' });
  const out = run(JSON.stringify({ prompt: 'tomas booked monday' }));
  assert.equal(out.status, 0);
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /Test Expo/);
  const junk = run('{not json');
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout, '');
  mkdirSync(join(H.HOME, 'events', 'broken'), { recursive: true });
  writeFileSync(join(H.HOME, 'events', 'broken', 'event.json'), '{bad');
  assert.equal(run(JSON.stringify({ prompt: 'sent it' })).status, 0, 'a broken event file never blocks a prompt');
});

test('record: a report in Claude\'s scratchpad under /tmp is readable (macOS tmpdir is /var/folders)', () => {
  const H = ready();
  const dir = join('/tmp', `fb-scratch-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'report.json');
  writeFileSync(f, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'replied' }] }));
  assert.equal(cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]).applied, true);
});
