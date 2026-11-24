// Second review of 0.1.7 (item 3): "This page is from <day>" compares days in the event's time zone, not the browser's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 1, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [] };
const html = renderOutbox({ event: { slug: 'ev', name: 'X', time_zone: 'Pacific/Auckland' }, today: '2026-10-27', cards: [card], counts: {}, slots: [] });

test('the line carries the event zone', () => {
  assert.match(html, /id="dueStale" data-day="2026-10-27" data-zone="Pacific\/Auckland"/);
});

test("the page's day is today in the event's zone", () => {
  const src = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html)[1];
  const m = /function zoneDay\(zone\)\{[\s\S]*?\n  \}/.exec(src);
  assert.ok(m, 'a zoneDay function');
  const zoneDay = vm.runInNewContext(`(${m[0].replace('function zoneDay', 'function')})`, { Intl, Date });
  const want = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  assert.equal(zoneDay('Pacific/Auckland'), want);
  assert.match(src, /zoneDay\(dueStale\.dataset\.zone\) > dueStale\.dataset\.day/);
});
