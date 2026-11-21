// How many emails each person gets (first included): suggested by lead time, at most 7, and spacing plans fewer
// (never an error) when the days run out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSettings, suggestedTouches, TOUCHES_MAX } from '../lib/config.mjs';
import { touchesThatFit, modeFor } from '../lib/spacing.mjs';
import { personRoute, routeLength } from '../lib/route.mjs';

test('the default follows the lead time: under 10 days 3, 10-20 4, 21-34 5, 35+ 6', () => {
  for (const [d, n] of [[0, 3], [9, 3], [10, 4], [20, 4], [21, 5], [34, 5], [35, 6], [200, 6]]) assert.equal(suggestedTouches(d), n, `${d} days`);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const ev = (n) => ({ start_date: day(n), end_date: day(n + 2), time_zone: 'UTC' });
  assert.equal(effectiveSettings({}, ev(5)).touches, 3);
  assert.equal(effectiveSettings({}, ev(15)).touches, 4);
  assert.equal(effectiveSettings({}, ev(28)).touches, 5);
  assert.equal(effectiveSettings({}, ev(60)).touches, 6);
});

test('a number the user set is kept, up to 7', () => {
  const ev = { start_date: '2099-01-01', end_date: '2099-01-02', time_zone: 'UTC' };
  assert.equal(effectiveSettings({ touches: 5 }, ev).touches, 5);
  assert.equal(effectiveSettings({ touches: 12 }, ev).touches, TOUCHES_MAX);
});

test('auto-send uses the message count when a saved event has no route', () => {
  const event = { autosend: true };
  const contact = { email: 'ana@example.com' };
  const defaults = effectiveSettings({}, event);
  assert.equal(routeLength(defaults), 3);
  assert.equal(personRoute(contact, event, defaults), null, 'use all three messages on one channel');
  assert.equal(routeLength(effectiveSettings({ touches: 2 }, event)), 2);
  const route = ['email', 'email'];
  const routed = effectiveSettings({ route }, event);
  assert.equal(routeLength(routed), 2);
  assert.equal(routed.touches, 2, 'readback uses the explicit route length');
  assert.deepEqual(personRoute(contact, event, routed), route);
});

test('spacing: 7 fit with room, and fewer when the days run out', () => {
  const event = { end_date: '2026-12-31' };
  assert.equal(touchesThatFit('2026-11-01', event, modeFor(60), 7), 7);
  assert.ok(touchesThatFit('2026-12-26', event, modeFor(5), 7) < 7);
});
