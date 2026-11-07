// The customers question says who it is about, as the coworker question does: with the simulated tester's CRM, "4 people
// on the list at 2 customers: Kassenwerk (Felix Braun, Daniel Kurz); Basketry (Mira Holt, Noor Aziz)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilStep } from './fixtures/flow-until.mjs';
import { ftu6Flow } from './fixtures/ftu6.mjs';

test('the customers question names the people on the list at the user\'s customers, with the counts', () => {
  const { H, persona } = ftu6Flow();
  const at = untilStep(H, persona, (s) => s.ask?.id === 'customers');
  assert.match(at.last.ask.question, /The count: 4 people on the list at 2 customers: Kassenwerk \(Felix Braun, Daniel Kurz\); Basketry \(Mira Holt, Noor Aziz\)\./);
});
