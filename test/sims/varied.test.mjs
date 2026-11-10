// The eight generated sellers (test/sims/varied/specs.mjs): different data shapes, company sizes, answer
// styles and connected tools, some with tools that fail part way. Each must finish, and the checks that
// hold for everyone must hold: nobody to leave alone is shortlisted or written to, nothing a colleague holds
// gets a message, every send asked and went once, every follow-up in its thread. Slow: run with npm run sims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS } from './varied/specs.mjs';
import { runPersona } from './lib/generated.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Every "no reply" the runs saved came through the real answer path, where the step names the channel it asked about.
const words = [];
const wordsIn = (home) =>
  readdirSync(join(home, 'events')).flatMap((ev) => {
    const f = join(home, 'events', ev, 'ledger.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"no_reply_said"')).map((l) => JSON.parse(l)) : [];
  });

for (const spec of SPECS) {
  test(`${spec.id}: ${spec.about}`, { timeout: 1800000 }, () => {
    const r = runPersona(spec);
    for (const s of r.stages) assert.ok(s.ok, `${s.name}: ${s.error}`);
    assert.deepEqual(r.check.problems, [], `in ${r.home}`);
    words.push(...wordsIn(r.home));
  });
}

test('every no-reply answer in the runs names the channel the step asked about', () => {
  assert.ok(words.length > 0, 'no run reached a no-reply question');
  assert.deepEqual(words.filter((w) => !['email', 'app', 'linkedin'].includes(w.channel)), []);
});
