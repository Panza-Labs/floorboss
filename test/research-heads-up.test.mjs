// Standard and full setup say which companies go to web search before the first researcher starts, and can
// leave some out; the per-person offer is sized to the shortlist ("the top 20" of 3 people is no offer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, ROOT, cli as simCli } from './sims/lib/driver.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n';

test('company research: one heads-up naming the companies; "skip Globex" researches the rest', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  const asked = {};
  const researched = [];
  const persona = simplePersona({ asks: {
    setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv'),
    // Run 6, round 3: "the rest" beside a company makes a skip answer unclear, so it's asked again; the plain one reads.
    company_research: (s) => {
      asked.company_research = s.ask;
      const f = join(H.HOME, 'work', 'cr.txt');
      writeFileSync(f, 'skip Globex, the rest is fine');
      assert.match(simCli(H, 'flow', ['answer', '--event', s.event, '--ask', 'company_research', '--value-file', f]).ERROR || '', /Name the companies/);
      // (A lone company is decided at once only with "only" or "just": audit run 7.)
      return 'skip only Globex';
    },
    research_scale: (s) => { asked.research_scale = s.ask; return 'none'; },
  } });
  const { trail, slug } = drive(H, persona, { onStep: (s) => { if (s.step === 'company_briefs') researched.push(...s.agents.map((a) => a.input.company)); } });
  const q = asked.company_research;
  assert.ok(q, trail.join(' '));
  assert.match(q.question, /^3 companies to look up on the web: (Acme|Globex|Initech), (Acme|Globex|Initech), (Acme|Globex|Initech)\. Go, or skip some\? And the 3 shortlisted people: research all 3, the top 2, or none\?$/, 'the people question in the same ask');
  assert.ok(trail.indexOf('company_research') < trail.indexOf('company_briefs'), 'asked before any researcher');
  assert.deepEqual(researched.sort(), ['Acme', 'Initech']);
  const brief = readFileSync(join(H.HOME, 'events', slug, 'companies', 'globex.md'), 'utf8');
  assert.match(brief, /Not researched/);
  // Three people on the shortlist: no "top 20".
  assert.match(asked.research_scale.question, /Research the 3 shortlisted people on the web before drafting\? All 3, the top 2, or none\?/);
  assert.deepEqual(asked.research_scale.options, ['all 3', 'top 2', 'none']);
});
