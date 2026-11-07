import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFreeTimes, FreeTimeError } from '../skills/slot-finder/scripts/freetimes.mjs';
import { buildSlots, slotLabel, removeSlots } from '../skills/slot-finder/scripts/slots.mjs';
import { assignSlots, holdersBySlot } from '../skills/slot-finder/scripts/assign.mjs';

const EV = ['2027-10-12', '2027-10-13'];
const NOW = new Date('2027-09-30T00:00:00Z');

test('freetimes: formats, meridiems, own-length ranges, unparsed returned', () => {
  const { ranges, unparsed } = parseFreeTimes('Tue 9–11, 14h-17h; Wed 9:30-12, 2pm-4pm; Wed 19:30–22:00 dinner 150; Thu 9-10; Tue banana', { eventDays: EV });
  assert.deepEqual(ranges.map((r) => [r.date, r.start, r.end]), [
    ['2027-10-12', 540, 660], ['2027-10-12', 840, 1020], ['2027-10-13', 570, 720], ['2027-10-13', 840, 960], ['2027-10-13', 1170, 1320],
  ]);
  assert.equal(ranges[4].minutes, 150);
  assert.equal(ranges[4].label, 'dinner');
  assert.deepEqual(unparsed, ['Thu 9-10', 'Tue banana']);
});

test('freetimes: "after 3", "1-3" read as afternoon; dates and "every day"', () => {
  const r = parseFreeTimes('13 Oct after 3; Tue 1-3; every day 9-10', { eventDays: EV }).ranges;
  assert.deepEqual(r.map((x) => [x.date, x.start / 60, x.end / 60]), [['2027-10-13', 15, 18], ['2027-10-12', 13, 15], ['2027-10-12', 9, 10], ['2027-10-13', 9, 10]]);
});

test('freetimes: ambiguous weekday on a long event asks for a date', () => {
  const days = Array.from({ length: 9 }, (_, i) => `2027-10-${String(11 + i).padStart(2, '0')}`);
  assert.throws(() => parseFreeTimes('Mon 9-10', { eventDays: days }), FreeTimeError);
});

test('slots: cut to meeting length in event zone, ids and labels', () => {
  const { ranges } = parseFreeTimes('Tue 9-10:15', { eventDays: EV });
  const { slots } = buildSlots(ranges, { eventZone: 'Europe/Lisbon', now: NOW });
  assert.deepEqual(slots.map((s) => s.id), ['s20271012T0900', 's20271012T0930']);
  assert.equal(slots[0].start, '2027-10-12T08:00:00.000Z');
  assert.equal(slotLabel(slots[0], 'Europe/Lisbon', 'America/New_York'), 'Tue 12 Oct, 09:00 Lisbon time (04:00 New York time)');
});

test('slots: free times typed in home zone convert to event zone', () => {
  const { ranges } = parseFreeTimes('Tue 4-5am', { eventDays: EV });
  const { slots } = buildSlots(ranges, { eventZone: 'Europe/Lisbon', sourceZone: 'America/New_York', now: NOW });
  assert.equal(slots[0].id, 's20271012T0900');
});

test('slots: overlaps merged, outside hours shown not silently dropped, own-length exempt', () => {
  const { ranges } = parseFreeTimes('Tue 7-9, 8:30-9:30; Wed 19:30-22:00 dinner 150', { eventDays: EV });
  const out = buildSlots(ranges, { eventZone: 'Europe/Lisbon', now: NOW });
  assert.deepEqual(out.slots.map((s) => s.id), ['s20271012T0800', 's20271012T0830', 's20271012T0900', 's20271013T1930']);
  assert.equal(out.outside.length, 1);
  assert.equal(out.slots[3].minutes, 150);
  const kept = buildSlots(ranges, { eventZone: 'Europe/Lisbon', now: NOW, keepOutside: true });
  assert.ok(kept.slots.some((s) => s.id === 's20271012T0700'));
});

test('slots: past slots cut by UTC now regardless of machine TZ', () => {
  const { ranges } = parseFreeTimes('Tue 9-11', { eventDays: EV });
  const now = new Date('2027-10-12T09:15:00Z'); // 10:15 Lisbon
  const { slots } = buildSlots(ranges, { eventZone: 'Europe/Lisbon', now });
  assert.deepEqual(slots.map((s) => s.id), ['s20271012T1030']);
  assert.deepEqual(removeSlots(slots, ['s20271012T1030']), []);
});

function makeSlots(spec) {
  const { ranges } = parseFreeTimes(spec, { eventDays: EV });
  return buildSlots(ranges, { eventZone: 'Europe/Lisbon', now: NOW }).slots;
}

test('assign: two days each, no slot over capacity, ranks first, open ask when full', () => {
  const slots = makeSlots('Tue 9-10:30; Wed 9-10:30'); // 3 + 3 slots
  const ranked = Array.from({ length: 10 }, (_, i) => ({ id: `c${String(i + 1).padStart(3, '0')}` }));
  const { assignments, openAsk, offers } = assignSlots(ranked, slots, { max_offers: 3 });
  for (const ids of Object.values(assignments)) {
    assert.equal(ids.length, 2);
    assert.notEqual(slots.find((s) => s.id === ids[0]).day, slots.find((s) => s.id === ids[1]).day);
  }
  assert.ok(Object.values(offers).every((n) => n <= 3));
  assert.equal(Object.keys(assignments).length, 9);
  assert.deepEqual(openAsk, ['c010']);
});

test('assign: one-day event falls back to same day two hours apart, then one slot', () => {
  const slots = makeSlots('Tue 9-10, 13-13:30');
  const { assignments } = assignSlots([{ id: 'c001' }], slots, { max_offers: 1 });
  assert.deepEqual(assignments.c001, ['s20271012T0900', 's20271012T1300']);
  const morning = makeSlots('Tue 9-10');
  assert.deepEqual(assignSlots([{ id: 'c001' }], morning, { max_offers: 3 }).assignments.c001, ['s20271012T0900']);
});

test('assign: per_slot multiplies capacity; existing assignments count; holders', () => {
  const slots = makeSlots('Tue 9-9:30; Wed 9-9:30');
  const ranked = Array.from({ length: 9 }, (_, i) => ({ id: `c${100 + i}` }));
  assert.equal(Object.keys(assignSlots(ranked, slots, { max_offers: 3, per_slot: 3 }).assignments).length, 9);
  const withExisting = assignSlots([{ id: 'c001' }, { id: 'c002' }], slots, { max_offers: 1, existing: { c900: ['s20271012T0900', 's20271013T0900'] } });
  assert.deepEqual(withExisting.openAsk, ['c001', 'c002']);
  assert.deepEqual(holdersBySlot({ c1: ['a', 'b'], c2: ['a'] }), { a: ['c1', 'c2'], b: ['c1'] });
});

test('review: home label carries its own date when it differs; event label uses the event city', () => {
  const { ranges } = parseFreeTimes('Tue 9-9:30', { eventDays: EV });
  const { slots } = buildSlots(ranges, { eventZone: 'Asia/Tokyo', now: NOW });
  assert.equal(slotLabel(slots[0], 'Asia/Tokyo', 'America/New_York'), 'Tue 12 Oct, 09:00 Tokyo time (Mon 11 Oct, 20:00 New York time)');
  const m = buildSlots(ranges, { eventZone: 'Europe/Madrid', now: NOW }).slots[0];
  assert.equal(slotLabel(m, 'Europe/Madrid', null, 'Barcelona'), 'Tue 12 Oct, 09:00 Barcelona time');
});

test('assign: labelled slots (a dinner) are never auto-assigned', () => {
  const slots = makeSlots('Tue 9-9:30; Wed 19:30-22:00 dinner 150');
  const { assignments } = assignSlots([{ id: 'c001' }], slots, { max_offers: 3 });
  assert.deepEqual(assignments.c001, ['s20271012T0900']);
});
