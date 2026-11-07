// The meeting agenda: facts per booked meeting, news per company, talking points checked against the facts,
// and the page, the short version and the calendar file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf } from './fixtures/harness.mjs';

test('agenda: a booked meeting gets its facts, the company news, checked talking points, and a page, notes and calendar file', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const rec = join(H.dir, 'rec.json');
  writeFileSync(rec, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Ana said Tuesday at ten works' }] }));
  const r = cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', rec]);
  assert.ok(!r.ERROR, r.ERROR);
  const d = cli(H, 'event-outreach', ['agenda-data', '--event', H.slug]);
  assert.equal(d.meetings, 1, JSON.stringify(d));
  assert.deepEqual(d.no_news_yet, ['Acme']);
  const nf = join(H.dir, 'news.json');
  writeFileSync(nf, JSON.stringify({ news: [{ text: 'Acme opened a Rotterdam hub', url: 'https://example.test/acme', date: '2026-10', about: 'company' }, { text: 'no source' }] }));
  assert.equal(cli(H, 'event-outreach', ['agenda-news', '--event', H.slug, '--company', 'Acme', '--json-file', nf]).news, 1, 'an item without a source is dropped');
  cli(H, 'event-outreach', ['agenda-data', '--event', H.slug]);
  const pf = join(H.dir, 'points.json');
  writeFileSync(pf, JSON.stringify({ meetings: [{ id: ana, points: [{ text: 'The Rotterdam hub and what it means for carrier checks', from: 'news' }, { text: 'Their research on profile', from: 'profile' }], ask: 'What changes first at the new hub?' }] }));
  assert.match(cli(H, 'event-outreach', ['agenda-save', '--event', H.slug, '--file', pf]).ERROR || '', /no research on them/, 'a point can\'t cite research that isn\'t there');
  writeFileSync(pf, JSON.stringify({ meetings: [{ id: ana, points: [{ text: 'The Rotterdam hub and what it means for carrier checks', from: 'news' }, { text: 'What they want from the event', from: 'goal' }], ask: 'What changes first at the new hub?', avoid: null }] }));
  const s = cli(H, 'event-outreach', ['agenda-save', '--event', H.slug, '--file', pf]);
  assert.ok(!s.ERROR, s.ERROR);
  const html = readFileSync(s.page, 'utf8');
  assert.match(html, /Ana Berg/);
  assert.match(html, /Rotterdam hub/);
  assert.match(readFileSync(s.calendar, 'utf8'), /BEGIN:VEVENT[\s\S]*DTSTART:20261110T090000Z[\s\S]*Ask: What changes first/);
  assert.ok(existsSync(s.short));
});
