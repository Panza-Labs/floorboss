// The column-mapping question answered in plain words: "ignore <column>" is applied, and anything else gets a
// plain refusal that says what the answer should hold, never a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';

const LIST = 'Full Name,Position,Organisation,E-mail,Badge Type,Comments\nRachel Kim,Director of Facilities,Lakeshore Health System,rachel@lakeshore.test,VIP,Speaking on a panel\n';
const say = (H, ask, text) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', `${ask}.txt`); writeFileSync(f, text); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]); };

test('mapping: "Badge Type means nothing for me, ignore it" ignores that column; other words are refused plainly', () => {
  const H = setup({ attendees: LIST });
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'attendees', '--file', join(H.dir, 'attendees.csv')]);
  const p = cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']);
  assert.ok(!p.ERROR, p.ERROR);
  const vague = say(H, 'map_columns_attendees', 'hmm, that looks a bit off to me');
  assert.match(vague.ERROR || '', /the corrected mapping as JSON .* not a path or words; to leave a column out, say "ignore <column>" \(the columns: Full Name, Position/);
  assert.doesNotMatch(vague.ERROR, /Cannot read properties/);
  // The command itself, given words where a file should be: the same plain refusal.
  const direct = cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'attendees', '--file', 'Badge Type means nothing']);
  assert.match(direct.ERROR || '', /not a path or words\. To leave a column out, say "ignore <column>"/);
  const r = say(H, 'map_columns_attendees', 'Badge Type means nothing for me, ignore it');
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.confirmed, true);
  const src = readdirSync(join(H.dir, 'sources')).map((f) => JSON.parse(readFileSync(join(H.dir, 'sources', f), 'utf8'))).find((m) => m.kind === 'attendees');
  assert.equal(src.columns['Badge Type'].field, 'ignore');
  assert.equal(src.columns['Full Name'].field, 'name');
});

test('mapping: a JSON answer with "ignore": [...] leaves those columns out', () => {
  const H = setup({ attendees: LIST });
  cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'attendees', '--file', join(H.dir, 'attendees.csv')]);
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']);
  const r = say(H, 'map_columns_attendees', JSON.stringify({ ignore: ['Badge Type', 'Comments'] }));
  assert.ok(!r.ERROR, r.ERROR);
  const src = readdirSync(join(H.dir, 'sources')).map((f) => JSON.parse(readFileSync(join(H.dir, 'sources', f), 'utf8'))).find((m) => m.kind === 'attendees');
  assert.equal(src.columns.Comments.field, 'ignore');
  assert.equal(src.ignore, undefined);
});
