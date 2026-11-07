// Before the agenda's news searches, the user hears which companies go to the web, as for company research,
// and can leave some out: a company left out gets no search, and the agenda goes on without its news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, cli, ROOT } from './sims/lib/driver.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';

test('agenda news: one heads-up naming the companies; "skip Acme" searches nothing for Acme', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  const persona = simplePersona({ asks: { setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), research_scale: 'none' } });
  const { slug } = drive(H, persona, { maxSteps: 200 });
  const f = join(H.HOME, 'work', 'booked.json');
  writeFileSync(f, JSON.stringify({ items: [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tuesday at ten works' }] }));
  assert.ok(!cli(H, 'event-outreach', ['record', '--event', slug, '--file', f]).ERROR);
  const s = cli(H, 'flow', ['next', '--event', slug, '--agenda']);
  assert.equal(s.step, 'agenda_news_ok', JSON.stringify(s).slice(0, 300));
  assert.equal(s.ask.question, 'For the agenda, 1 company to look up on the web for news (a few searches each): Acme. Go, or skip some?');
  assert.ok(!s.agents, 'no researcher before the answer');
  const a = join(H.HOME, 'work', 'agenda-news.txt');
  writeFileSync(a, 'skip Acme');
  const r = cli(H, 'flow', ['answer', '--event', slug, '--ask', 'agenda_news', '--value-file', a]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.result.skipped, ['Acme']);
  const after = cli(H, 'flow', ['next', '--event', slug, '--agenda']);
  assert.equal(after.step, 'agenda', JSON.stringify(after).slice(0, 300));
  const news = readdirSync(join(H.HOME, 'events', slug, 'companies')).filter((x) => /^acme-news-/.test(x));
  assert.equal(news.length, 1);
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'events', slug, 'companies', news[0]), 'utf8')).skipped, true);
});
