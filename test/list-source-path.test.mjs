// "Where's the attendee list?" answered with the path inside a sentence: the file is taken as the list, as
// crm_where takes an export, and the question isn't asked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atListSource } from './fixtures/harness.mjs';
import { cli } from './sims/lib/driver.mjs';

test('list_source: "it\'s at ~/…/x.csv, the organiser sent it" loads that file', { timeout: 300000 }, () => {
  const H = atListSource();
  mkdirSync(join(H.HOME, 'Downloads'), { recursive: true });
  const csv = join(H.HOME, 'Downloads', 'ledgerline-attendees.csv');
  writeFileSync(csv, 'Full Name,Job Title,Organisation,Email\nPriya Raman,Head of Finance Operations,Northpeak Bank,priya.raman@northpeak.example\n');
  const f = join(H.HOME, 'work', 'list_source.txt');
  writeFileSync(f, `it's at ${csv}, the organiser sent it`);
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'list_source', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(existsSync(join(H.dir, 'inputs', 'attendees.csv')), JSON.stringify(r).slice(0, 400));
  const s = cli(H, 'flow', ['next', '--event', H.slug]);
  assert.notEqual(s.ask?.id, 'list_source', 'the path is not asked for again');
  assert.notEqual(s.ask?.id, 'attendee_list');
});
