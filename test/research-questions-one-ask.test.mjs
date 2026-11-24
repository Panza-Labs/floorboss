// Company and people research start with one heads-up (company_briefs), not two questions. An answer that covers both
// ("skip all research", "skip company research, and people: none") stops both; an answer about the companies only
// leaves the people research running.
// (Updated 2026-11-21 for the unified research: the heads-up replaced the company_research and research_scale asks, so the
// same words are said at the heads-up step and "no research starts" is read from the steps that follow.)
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ftu6Flow } from './fixtures/ftu6.mjs';
import { throughHeadsUp, say } from './fixtures/heads-up.mjs';

for (const said of ['skip all research', 'skip company research, and people: none']) {
  test(`"${said}" answers both research questions`, { timeout: 600000 }, () => {
    const { H, persona } = ftu6Flow();
    const r = throughHeadsUp(H, persona, (up) => {
      assert.match(up.tell_user, /Looking up the 7 shortlisted companies.*then the 10 shortlisted people.*Say "skip"/s);
      const a = say(H, up, said);
      assert.ok(!a.ERROR, a.ERROR);
      assert.equal(a.result.research_scale, 'none');
    });
    assert.deepEqual(r.ran, [], `no researcher of either kind starts: ${JSON.stringify(r.ran).slice(0, 200)}`);
    assert.ok(!r.trail.includes('research_batch') && !r.trail.includes('company_briefs'), r.trail.join(' '));
    assert.match(readFileSync(join(H.HOME, 'events', r.slug, 'ledger.jsonl'), 'utf8'), /"ask":"company_research","value":"skip"/);
  });
}

test('an answer about the companies only leaves the people research running', { timeout: 600000 }, () => {
  const { H, persona } = ftu6Flow();
  const r = throughHeadsUp(H, persona, (up) => {
    const a = say(H, up, 'skip company research');
    assert.ok(!a.ERROR, a.ERROR);
    assert.equal(a.result.research_scale, undefined, 'the people were not answered');
  });
  assert.deepEqual(r.companiesResearched, []);
  assert.ok(r.trail.includes('research_batch'), `the people are still researched: ${r.trail.join(' ')}`);
  assert.equal(r.peopleResearched.length, 10);
});
