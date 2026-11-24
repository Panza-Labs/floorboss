// Standard and full setup say which companies go to web search before the first researcher starts, and can
// leave some out; the per-person offer is sized to the shortlist ("the top 20" of 3 people is no offer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { throughHeadsUp, say } from './fixtures/heads-up.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n';

test('company research: one heads-up naming the companies; "skip Globex" researches the rest', { timeout: 300000 }, () => {
  // (Updated 2026-11-21: the heads-up is the company_briefs step in both hosts, with no question and no per-person offer;
  // the same words are said there. What it checks is the same: every company is named first, an unclear skip is asked
  // again, a plain one leaves the company unresearched and the rest are looked up, and the people count is the shortlist's.)
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  const persona = simplePersona({ asks: { setup_level: 'standard', attendee_list: join(H.HOME, 'inputs', 'attendees.csv') } });
  let said;
  const run = throughHeadsUp(H, persona, (up) => {
    said = up;
    // Run 6, round 3: "the rest" beside a company makes a skip answer unclear, so it's asked again; the plain one reads.
    assert.match(say(H, up, 'skip Globex, the rest is fine').ERROR || '', /Name the companies/);
    // (A lone company is decided at once only with "only" or "just": audit run 7.)
    assert.ok(!say(H, up, 'skip only Globex').ERROR);
  });
  assert.match(said.tell_user, /^Looking up the 3 shortlisted companies on the web now \((Acme|Globex|Initech), (Acme|Globex|Initech), (Acme|Globex|Initech)\)/, 'every company named first');
  assert.ok(run.trail.indexOf('company_briefs') >= 0 && !said.ask, 'a heads-up before any researcher, not a question');
  assert.deepEqual(run.companiesResearched.sort(), ['Acme', 'Initech']);
  const brief = readFileSync(join(H.HOME, 'events', run.slug, 'companies', 'globex.md'), 'utf8');
  assert.match(brief, /Not researched/);
  // Three people on the shortlist: said as 3, never "top 20".
  assert.match(said.tell_user, /then the 3 shortlisted people\./);
  assert.doesNotMatch(said.tell_user, /top 20/);
});
