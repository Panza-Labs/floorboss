// Meeting outcomes (held, no-show, cancelled, rescheduled), walk-ups, the agenda's view of them, and the after-show
// report's page and CSV (skills/event-outreach/scripts/report.mjs, record.mjs, agenda.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, NOW } from './fixtures/harness.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { buildReport, renderReport } from '../skills/event-outreach/scripts/report.mjs';
import { renderHtml, renderMarkdown } from '../skills/event-outreach/scripts/agenda.mjs';

const LIST =
  'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\nDee Moss,Ops Lead,Umbrella,dee@umbrella.test\n';
// The fixture event: 10 to 12 Nov 2026, Europe/Amsterdam (UTC+1 then).
const DAY1_NOON = '2026-11-10T11:30:00Z';
const DAY2_EVENING = '2026-11-11T18:00:00Z';
const rec = (H, items, now = NOW, extra = []) => {
  const f = join(H.dir, `report-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ items }));
  return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f, ...extra], now);
};
const report = (H, now) => cli(H, 'event-outreach', ['report', '--event', H.slug], now);
function event() {
  const H = setup({ attendees: LIST });
  triage(H);
  return H;
}

test('held and no-show: recorded once the meeting time has come, in the ledger and the report', () => {
  const H = event();
  const b = rec(H, [
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Ana: Tue 10:00' },
    { who: 'Bo Li', what: 'booked', time: '2026-11-10 11:00', said: 'Bo: Tue 11:00' }
  ]);
  assert.equal(b.applied, true, JSON.stringify(b));
  // Before the meeting: refused, nothing written.
  const early = rec(H, [{ who: 'Ana Berg', what: 'held', said: 'it went well' }]);
  assert.match(early.ERROR || '', /still to come/);
  // --check says it back and writes nothing.
  const before = readLedger(join(H.dir, 'ledger.jsonl')).entries.length;
  const chk = rec(H, [{ who: 'Ana Berg', what: 'held', said: 'it happened' }], DAY1_NOON, ['--check']);
  assert.equal(chk.applied, false);
  assert.match(chk.would_record.join(' '), /Ana Berg \(Acme\): the meeting at .* happened/);
  assert.equal(readLedger(join(H.dir, 'ledger.jsonl')).entries.length, before);
  const r = rec(
    H,
    [
      { who: 'Ana Berg', what: 'held', said: 'it happened' },
      { who: 'Bo Li', what: 'no_show', said: "Bo didn't come" }
    ],
    DAY1_NOON
  );
  assert.equal(r.applied, true, JSON.stringify(r));
  const L = readLedger(join(H.dir, 'ledger.jsonl')).entries;
  assert.ok(L.some((e) => e.type === 'meeting_outcome' && e.id === idOf(H, 'Ana Berg') && e.outcome === 'held' && e.start === '2026-11-10T09:00:00.000Z' && e.said));
  assert.ok(L.some((e) => e.type === 'meeting_outcome' && e.id === idOf(H, 'Bo Li') && e.outcome === 'no_show'));
  // The same word again is said, not recorded twice; another word changes it, and says so.
  const again = rec(H, [{ who: 'Ana Berg', what: 'held', said: 'yes it happened' }], DAY1_NOON);
  assert.match(again.notes.join(' '), /already marked held/);
  const out = report(H, DAY1_NOON);
  assert.deepEqual([out.counts.booked, out.counts.held, out.counts.no_show, out.counts.cancelled, out.counts.rescheduled], [2, 1, 1, 0, 0]);
  // Someone with no booking can't be marked.
  assert.match(rec(H, [{ who: 'Cy Ruiz', what: 'held', said: 'x' }], DAY1_NOON).ERROR || '', /no booked meeting/);
});

test('cancelled, and rescheduled then held: one meeting each, counted the right way', () => {
  const H = event();
  rec(H, [
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tue 10' },
    { who: 'Cy Ruiz', what: 'booked', time: '2026-11-10 12:00', said: 'Tue 12' }
  ]);
  const mv = rec(H, [{ who: 'Ana Berg', what: 'rescheduled', time: '2026-11-11 11:00', said: 'Ana moved to Wed 11:00' }]);
  assert.equal(mv.applied, true, JSON.stringify(mv));
  assert.match(mv.recorded[0], /moved: Ana Berg/);
  const cx = rec(H, [{ who: 'Cy Ruiz', what: 'cancelled', said: 'Cy cancelled' }]);
  assert.equal(cx.applied, true);
  // Rescheduling someone with no meeting is refused.
  assert.match(rec(H, [{ who: 'Bo Li', what: 'rescheduled', time: '2026-11-11 11:30', said: 'x' }]).ERROR || '', /no booked meeting to reschedule/);
  // Marked held at the new time.
  assert.equal(rec(H, [{ who: 'Ana Berg', what: 'held', said: 'good meeting' }], DAY2_EVENING).applied, true);
  const out = report(H, DAY2_EVENING);
  assert.deepEqual([out.counts.booked, out.counts.held, out.counts.cancelled, out.counts.rescheduled, out.counts.not_marked], [2, 1, 1, 1, 0]);
  const csv = readFileSync(out.csv, 'utf8');
  const ana = csv.split('\n').find((l) => l.includes('Ana Berg'));
  assert.match(ana, /held/);
  assert.match(ana, /Tue 10 Nov.*10:00/, 'the time it moved from');
  assert.match(csv.split('\n').find((l) => l.includes('Cy Ruiz')), /cancelled/);
});

test('a meeting with no outcome: "not marked yet" once it has ended, "still to come" before, and on the agenda', () => {
  const H = event();
  rec(H, [
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tue 10' },
    { who: 'Bo Li', what: 'booked', time: '2026-11-10 14:00', said: 'Tue 14' }
  ]);
  const out = report(H, DAY1_NOON);
  assert.equal(out.counts.not_marked, 1);
  assert.equal(out.counts.upcoming, 1);
  assert.match(out.not_marked.join(' '), /Ana Berg/);
  const page = readFileSync(out.page, 'utf8');
  assert.match(page, /not marked yet/);
  assert.ok(!page.includes('<script'), 'the page runs no script');
  // The day's agenda lists the ended meeting with nothing recorded, and not the one still to come.
  cli(H, 'event-outreach', ['agenda-data', '--event', H.slug, '--day', '2026-11-10'], DAY1_NOON);
  const data = JSON.parse(readFileSync(join(H.dir, 'derived', 'agenda-data.json'), 'utf8'));
  assert.deepEqual(data.unmarked.map((u) => u.name), ['Ana Berg']);
  assert.match(renderHtml(data, new Map()), /Not marked yet: .*Ana Berg/);
  assert.match(renderMarkdown(data, new Map()), /Not marked yet: .*Ana Berg/);
  // Once marked, the agenda shows the outcome and the list is gone.
  rec(H, [{ who: 'Ana Berg', what: 'held', said: 'it went fine' }], DAY1_NOON);
  cli(H, 'event-outreach', ['agenda-data', '--event', H.slug, '--day', '2026-11-10'], DAY1_NOON);
  const d2 = JSON.parse(readFileSync(join(H.dir, 'derived', 'agenda-data.json'), 'utf8'));
  assert.equal(d2.unmarked, undefined);
  assert.equal(d2.meetings.find((m) => m.person.name === 'Ana Berg').outcome, 'held');
  assert.equal(d2.meetings.find((m) => m.person.name === 'Bo Li').outcome, undefined, 'no outcome key until one is recorded');
  assert.match(renderHtml(d2, new Map()), /class="outcome held">held</);
  assert.match(renderMarkdown(d2, new Map()), /Outcome: held/);
  // Before any meeting has ended, the agenda's data is as it was: no unmarked key, no outcome key.
  cli(H, 'event-outreach', ['agenda-data', '--event', H.slug, '--day', '2026-11-11'], DAY1_NOON);
  const d3 = JSON.parse(readFileSync(join(H.dir, 'derived', 'agenda-data.json'), 'utf8'));
  assert.equal(d3.unmarked, undefined);
});

test('walk-ups: someone on the list counts as met; someone off it is kept by name and company, apart', () => {
  const H = event();
  const r = rec(
    H,
    [
      { who: 'Dee Moss', what: 'walkup', date: '2026-10-12', said: 'Dee stopped by the booth' },
      { who: 'Tom Field', company: 'Harbor Two', what: 'walkup', said: 'Tom from Harbor Two came by' }
    ],
    NOW
  );
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.match(r.recorded.join(' '), /walk-up: Dee Moss \(Umbrella\)/);
  assert.match(r.recorded.join(' '), /walk-up: Tom Field \(Harbor Two\).*not on this event's list/);
  const L = readLedger(join(H.dir, 'ledger.jsonl')).entries;
  assert.ok(L.some((e) => e.type === 'replied' && e.id === idOf(H, 'Dee Moss') && e.outcome === 'met in person'), 'in touch now');
  assert.ok(L.some((e) => e.type === 'walkup' && !e.id && e.name === 'Tom Field' && e.company === 'Harbor Two'));
  // One word and no company isn't enough for someone off the list; a day still to come is refused.
  assert.match(rec(H, [{ who: 'Zed', what: 'walkup', said: 'x' }]).ERROR || '', /full name and company/);
  assert.match(rec(H, [{ who: 'Dee Moss', what: 'walkup', date: '2026-12-01', said: 'x' }]).ERROR || '', /on or before today/);
  const out = report(H, NOW);
  assert.equal(out.counts.walkups, 2);
  assert.equal(out.counts.booked, 0, 'walk-ups are listed apart from meetings');
  const csv = readFileSync(out.csv, 'utf8');
  assert.match(csv, /walk-up,Tom Field,Harbor Two,.*not on your list/);
  assert.match(csv, /walk-up,Dee Moss,Umbrella,.*on your list/);
});

test('first contact: the channel and day of the first send recorded, an undone send left out', () => {
  const H = event();
  rec(H, [
    { who: 'Ana Berg', what: 'sent', date: '2026-10-12', channel: 'email', said: 'sent Ana' },
    { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tue 10' },
    { who: 'Bo Li', what: 'sent', date: '2026-10-12', channel: 'Grip', said: 'sent Bo in the app' }
  ]);
  rec(H, [{ who: 'Bo Li', what: 'unsent', said: 'that was a mistake' }]);
  rec(H, [{ who: 'Bo Li', what: 'booked', time: '2026-11-10 11:00', said: 'Bo booked' }]);
  const out = report(H, DAY1_NOON);
  const csv = readFileSync(out.csv, 'utf8').split('\n');
  assert.match(csv.find((l) => l.includes('Ana Berg')), /email,2026-10-12$/);
  assert.match(csv.find((l) => l.includes('Bo Li')), /,,$/, 'no send recorded for Bo once it was undone');
  assert.ok(existsSync(join(H.dir, 'report.html')));
});

test('the report page and CSV: list text is escaped and can\'t run as a formula', () => {
  const byId = { c001: { id: 'c001', name: '<script>alert(1)</script>', company: '=HYPERLINK("http://x")' } };
  const entries = [
    { at: '2026-10-12T08:00:00Z', type: 'booked', id: 'c001', slot: 's1', start: '2026-11-10T09:00:00.000Z' },
    { at: '2026-11-10T12:00:00Z', type: 'meeting_outcome', id: 'c001', outcome: 'no_show', start: '2026-11-10T09:00:00.000Z' },
    { at: '2026-11-10T12:00:00Z', type: 'walkup', name: '"><img src=x>', company: '+cmd', date: '2026-11-10' }
  ];
  const r = buildReport(entries, { byId, zone: 'Europe/Amsterdam', now: new Date('2026-11-10T13:00:00Z') });
  assert.equal(r.counts.no_show, 1);
  const html = renderReport(r, { event: { name: 'Expo <b>' } });
  assert.ok(!html.includes('<script>alert') && !html.includes('<img src=x>') && !html.includes('Expo <b>'));
  assert.match(html, /default-src 'none'/);
  // An outcome for an earlier booking time doesn't count for a later one.
  const moved = buildReport(
    [
      { at: 'a', type: 'booked', id: 'c001', slot: 's1', start: '2026-11-10T09:00:00.000Z' },
      { at: 'b', type: 'unbooked', id: 'c001', slot: 's1' },
      { at: 'b', type: 'booked', id: 'c001', slot: 's2', start: '2026-11-11T10:00:00.000Z' },
      { at: 'c', type: 'meeting_outcome', id: 'c001', outcome: 'held', start: '2026-11-10T09:00:00.000Z' }
    ],
    { byId, zone: 'Europe/Amsterdam', now: new Date('2026-11-12T13:00:00Z') }
  );
  assert.equal(moved.counts.held, 0);
  assert.equal(moved.counts.not_marked, 1);
  assert.equal(moved.counts.rescheduled, 1);
});
