// A reply the user reported in words ("Tue 10 works") is in the agenda's thread as received, with its channel and
// day, and the agenda's "They wrote" line quotes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf, draftApprove } from './fixtures/harness.mjs';
import { renderMarkdown } from '../skills/event-outreach/scripts/agenda.mjs';

const ATT = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const LATER = '2026-10-20T08:00:00Z';
const rec = (H, items, now = LATER) => { const f = join(H.dir, `report-${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ items })); return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f], now); };

test('a recorded reply is received in the agenda thread, and the agenda quotes it', () => {
  const H = setup({ attendees: ATT });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: `${r.title} at ${r.company}`, score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  draftApprove(H);
  assert.equal(rec(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12', said: 'sent Ana' }]).applied, true);
  const r = rec(H, [{ who: 'Ana Berg', what: 'replied', said: 'Tue 10 works', date: '2026-10-19', channel: 'email' }, { who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'booked her' }]);
  assert.equal(r.applied, true, JSON.stringify(r));
  const a = cli(H, 'event-outreach', ['agenda-data', '--event', H.slug], LATER);
  assert.ok(!a.ERROR, a.ERROR);
  const data = JSON.parse(readFileSync(a.file, 'utf8'));
  const m = data.meetings.find((x) => x.id === idOf(H, 'Ana Berg'));
  assert.deepEqual(m.thread.received.map((x) => [x.at, x.text, x.channel]), [['2026-10-19', 'Tue 10 works', 'email']]);
  assert.match(renderMarkdown(data, new Map()), /They wrote: "Tue 10 works"/);
  // A reply's day can't be in the future.
  assert.match(rec(H, [{ who: 'Bo Li', what: 'replied', said: 'sure', date: '2026-12-01' }]).ERROR, /on or before today/);
});
