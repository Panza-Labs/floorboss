// Company and people research are asked in one question while both are open, and an answer that covers both
// ("skip all research", "go, and people: none") saves both: the people question doesn't follow on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilStep } from './fixtures/flow-until.mjs';
import { ftu6Flow } from './fixtures/ftu6.mjs';
import { cli, file } from './sims/lib/driver.mjs';

for (const said of ['skip all research', 'skip company research, and people: none']) {
  test(`"${said}" answers both research questions`, () => {
    const { H, persona } = ftu6Flow();
    const at = untilStep(H, persona, (s) => s.ask?.id === 'company_research');
    assert.match(at.last.ask.question, /Go, or skip some\? And the 10 shortlisted people: research all 10, the top 5, or none\?/);
    const r = cli(H, 'flow', ['answer', '--event', at.last.event, '--ask', 'company_research', '--value-file', file(H, 'cr.txt', said)]);
    assert.ok(!r.ERROR, r.ERROR);
    assert.equal(r.result.research_scale, 'none');
    const next = cli(H, 'flow', ['next', '--event', at.last.event]);
    assert.notEqual(next.ask?.id, 'research_scale', JSON.stringify(next).slice(0, 300));
  });
}

test('an answer about the companies only leaves the people question, which says it is the other half', () => {
  const { H, persona } = ftu6Flow();
  const at = untilStep(H, persona, (s) => s.ask?.id === 'research_scale');
  assert.match(at.last.ask.question, /^Your answer covered the companies; the people were the other half of that question\. Research the 10 shortlisted people/);
});
