// The eight generated sellers (test/sims/varied/specs.mjs): different data shapes, company sizes, answer
// styles and connected tools, some with tools that fail part way. Each must finish, and the checks that
// hold for everyone must hold: nobody to leave alone is shortlisted or written to, nothing a colleague holds
// gets a message, every send asked and went once, every follow-up in its thread. Slow: run with npm run sims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS } from './varied/specs.mjs';
import { runPersona } from './lib/generated.mjs';

for (const spec of SPECS) {
  test(`${spec.id}: ${spec.about}`, { timeout: 1800000 }, () => {
    const r = runPersona(spec);
    for (const s of r.stages) assert.ok(s.ok, `${s.name}: ${s.error}`);
    assert.deepEqual(r.check.problems, [], `in ${r.home}`);
  });
}
