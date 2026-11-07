// Someone held through a coworker's account, with nothing for the user to answer, shows the account note on the
// card's left-out line (Henrik Stahl: Sam Okafor's Pickpack account, "Closed Lost, Lost on price March 2026"), and
// a lost deal with no date on the record but a month in its note says "date in the note", in triage.csv too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, idOf } from './fixtures/harness.mjs';
import { ftu6 } from './fixtures/ftu6.mjs';

test('the left-out line carries the account note; no date on the record, a month in the note: "date in the note"', () => {
  const H = ftu6();
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug, '--what', 'left_out']);
  assert.ok(!v.ERROR, v.ERROR);
  const henrik = idOf(H, 'Henrik Stahl');
  const line = v.left_out.flatMap((x) => x.e_g).find((x) => x.startsWith(`${henrik} `));
  assert.ok(line, JSON.stringify(v.left_out));
  assert.match(line, /Henrik Stahl \(CEO, Pickpack\): at Sam Okafor's account Pickpack \(Closed Lost, Lost on price March 2026\)/);
  const csv = readFileSync(join(H.dir, 'derived', 'triage.csv'), 'utf8').split('\n').find((l) => l.startsWith(`${henrik},`));
  assert.match(csv, /date in the note: March 2026/);
  assert.doesNotMatch(csv, /a lost deal with no date;/);
});
