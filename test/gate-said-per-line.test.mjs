// A shortlist answer of several lines keeps, for each person, only the line about them as "you said".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf } from './fixtures/harness.mjs';
import { parseGate } from '../lib/gate.mjs';

test('parseGate: every action carries the line it came from', () => {
  const g = parseGate('reach c002\nkeep 10\nnotes on; skip c003 because she left, sadly', { kind: 'triage' });
  assert.deepEqual(g.actions.map((a) => a.line), ['reach c002', 'keep 10', 'notes on', 'skip c003 because she left, sadly']);
});

test('"reach Ana Berg / keep 10 / notes on": Ana\'s reason is her own line, not the whole answer', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,Office manager,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\n' });
  triage(H);
  const ana = idOf(H, 'Ana Berg');
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Ana Berg\nkeep 10\nnotes on']);
  assert.ok(!g.ERROR, g.ERROR);
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const d = led.filter((e) => e.type === 'decide' && e.id === ana).pop();
  assert.equal(d.because, 'reach Ana Berg');
  assert.equal(d.said, 'reach Ana Berg');
  assert.equal(led.filter((e) => e.type === 'keep').pop().said, 'keep 10');
  const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[ana];
  assert.equal(r.says, 'you said: reach (reach Ana Berg)');
});
