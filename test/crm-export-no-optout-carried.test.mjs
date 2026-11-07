// "There's no opt-out column in it, we never added one", said with the CRM export, carries into the mapping: the
// mapping question says it is known and doesn't ask it (and has no double full stop), and a plain "ok" confirms
// the mapping with no opt-out column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { untilStep } from './fixtures/flow-until.mjs';
import { ftu6Flow } from './fixtures/ftu6.mjs';
import { cli, file } from './sims/lib/driver.mjs';

test('the export\'s "no opt-out column" is not asked again at the mapping, and "ok" is enough', () => {
  const { H, persona } = ftu6Flow();
  const at = untilStep(H, persona, (s) => s.ask?.id === 'map_columns_crm');
  assert.equal(at.step, 'map_columns_crm');
  const q = at.last.ask.question;
  assert.match(q, /Opt-outs: no opt-out column \(you said so with the export; not asked again\)/);
  assert.doesNotMatch(q, /say "there's no opt-out column"/);
  assert.doesNotMatch(q, /\.\./);
  const r = cli(H, 'flow', ['answer', '--event', at.last.event, '--ask', 'map_columns_crm', '--value-file', file(H, 'map.txt', 'ok')]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.result.opt_out, /no opt-out column/);
  const dir = join(H.HOME, 'events', at.last.event, 'sources');
  assert.ok(readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).some((m) => m.kind === 'crm' && m.confirmed && m.opt_out_none));
});
