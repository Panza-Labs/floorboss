// An automatic step that keeps coming back: with floorboss's clock ahead of the real one (FLOORBOSS_NOW), the
// load ran again and again (the view's file time was compared with the ledger's clock) and the user got only
// "floorboss kept re-running the same automatic step". Now the load goes by a count it writes, and a stalled step
// says which step it was and the one command to run by hand; --new-run tries it afresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { cli } from './sims/lib/driver.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { ftu6Flow } from './fixtures/ftu6.mjs';

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
// The clock a week ahead of the real one, and the event after that, whatever day the test runs.
function ahead() {
  const real = Date.now();
  const event = { name: 'Test Expo', city: 'Rotterdam', start: day(real + 20 * 864e5), end: day(real + 21 * 864e5), zone: 'Europe/Amsterdam' };
  const { H, persona } = ftu6Flow({ event });
  H.now = new Date(real + 7 * 864e5).toISOString();
  H.env.FLOORBOSS_NOW = H.now;
  return { H, persona };
}

test('the clock ahead of the real one: the load runs once and the flow goes on to the fits', { timeout: 300000 }, () => {
  const { H, persona } = ahead();
  const r = untilStep(H, persona, (s) => s.step === 'fit' || s.step === 'stalled');
  assert.equal(r.step, 'fit', JSON.stringify(r.last).slice(0, 600));
  assert.equal((r.last.ran || []).filter((x) => x.step === 'load').length, 1, JSON.stringify(r.last.ran));
});

test('a step that stalls says which, and the command to run by hand; the next try stops at once; --new-run starts afresh', { timeout: 300000 }, () => {
  const { H, persona } = ahead();
  const r = untilStep(H, persona, 'fit');
  const slug = r.last.event;
  // An attendee list whose file time is in the future: the load can never catch up with it.
  const list = join(H.HOME, 'events', slug, 'inputs', 'attendees.csv');
  const later = new Date(Date.now() + 365 * 864e5);
  utimesSync(list, later, later);
  const s1 = cli(H, 'flow', ['next', '--event', slug]);
  assert.equal(s1.step, 'stalled', JSON.stringify(s1).slice(0, 400));
  assert.equal(s1.stalled_step, 'load');
  assert.match(s1.run_by_hand, /skills\/crm-triage\/scripts\/cli\.mjs load --event /);
  assert.match(s1.tell_user, /stuck on its "load" step/);
  assert.ok(s1.tell_user.includes(s1.run_by_hand), s1.tell_user);
  assert.ok(s1.ran.filter((x) => x.step === 'load').length <= 4, 'stopped after a few repeats, not 40');
  // Remembered: the next try runs it once more, then stops, and says how many times.
  const s2 = cli(H, 'flow', ['next', '--event', slug]);
  assert.equal(s2.step, 'stalled');
  assert.ok(s2.ran.filter((x) => x.step === 'load').length <= 2, JSON.stringify(s2.ran));
  assert.match(s2.tell_user, /2 times now/);
  // A new run clears the count.
  const s3 = cli(H, 'flow', ['next', '--event', slug, '--new-run']);
  assert.equal(s3.step, 'stalled');
  assert.doesNotMatch(s3.tell_user, /times now/);
  // Fixed (the file's time put back): the flow goes on, and the stall is forgotten.
  utimesSync(list, new Date(), new Date(Date.now() - 864e5));
  const s4 = cli(H, 'flow', ['next', '--event', slug]);
  assert.notEqual(s4.step, 'stalled', JSON.stringify(s4).slice(0, 300));
});
