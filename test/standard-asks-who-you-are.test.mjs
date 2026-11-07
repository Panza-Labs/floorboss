// Standard setup asks who the sender is (one line, saved as what-you-bring's "About me", which the critic
// reads) and, when what-you-bring has no "what you know" table, says so and asks for one to three insights or
// "none". A what-you-bring written with no insights has no empty table heading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { bringMd, setAbout, addInsights } from '../skills/flow/scripts/profile-write.mjs';
import { parseInsights } from '../skills/event-context/scripts/context-check.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n';

test('what-you-bring: no insights, no table heading; About me and insight rows go in where they belong', () => {
  const md = bringMd({ one_sentence: 'Dock scheduling for 3PLs' });
  assert.doesNotMatch(md, /What you know/);
  const with2 = addInsights(setAbout(md, 'founder of Lanecraft'), [{ insight: 'Most dock delay is on Mondays', basis: 'across our 40 customers', segments: ['ops-leaders'] }]);
  assert.match(with2, /^# What you bring\n\n\*\*About me:\*\* founder of Lanecraft$/m);
  assert.equal(parseInsights(with2).length, 1);
  assert.ok(with2.indexOf('What you know') < with2.indexOf('**Never say:**'), 'the table goes before the never-say line');
  assert.equal(parseInsights(addInsights(with2, [{ insight: 'Second one', basis: 'internal' }])).length, 2);
  assert.match(setAbout(with2, 'CEO of Lanecraft'), /\*\*About me:\*\* CEO of Lanecraft/);
});

test('standard setup: who you are and what you know are asked, saved, and the critic reads the About me line', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  // A profile with no "what you know" rows.
  const wyb = join(H.HOME, 'context', 'buyers', 'what-you-bring', 'SKILL.md');
  writeFileSync(wyb, readFileSync(wyb, 'utf8').replace(/\*\*What you know that they don't\*\*[\s\S]*?(?=\n\*\*[A-Z])/, ''));
  assert.equal(parseInsights(readFileSync(wyb, 'utf8')).length, 0);
  const asked = {};
  const persona = simplePersona({ asks: {
    setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'),
    about: (s) => { asked.about = s.ask; return 'Sam Rivera, founder of Lanecraft'; },
    insights: (s) => { asked.insights = s.ask; return { insights: [{ insight: 'Most dock delay at 3PLs lands on Monday mornings', basis: 'across our 40 customers' }] }; },
  } });
  const critic = [];
  const { trail } = drive(H, persona, { maxSteps: 200, onStep: (s) => { if (s.step === 'critic') critic.push(...s.agents.map((a) => readFileSync(a.input_file, 'utf8'))); } });
  assert.ok(asked.about, `about was never asked: ${trail.join(' ')}`);
  assert.match(asked.about.question, /who are you to the people you write to/);
  assert.ok(asked.insights, `insights were never asked: ${trail.join(' ')}`);
  assert.match(asked.insights.question, /^what-you-bring has no "what you know that they don't" table/);
  const now = readFileSync(wyb, 'utf8');
  assert.match(now, /\*\*About me:\*\* Sam Rivera, founder of Lanecraft/);
  const rows = parseInsights(now);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].segments.length, 'tagged for the segments');
  // The critic's facts carry the About me line.
  assert.ok(critic.length, trail.join(' '));
  assert.ok(critic.every((t) => t.includes('About me:** Sam Rivera, founder of Lanecraft')), critic[0].slice(0, 400));
});
