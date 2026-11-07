// "Where do you keep your contacts?" answered with the export's path: the file is saved as the CRM export
// there and then, and the export question isn't asked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { onboardingState } from '../skills/event-context/scripts/onboarding-state.mjs';

test('crm_where with an existing file in it: saved as the export, crm_export is done', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\n' });
  mkdirSync(join(H.HOME, 'Downloads'), { recursive: true });
  const csv = join(H.HOME, 'Downloads', 'hubspot-export.csv');
  writeFileSync(csv, 'Name,Email,Company,Owner,Status,Opted Out\nOla Ops,ola@acme.test,Acme,Pat Teammate,Lead,no\n');
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'crm_where.txt');
  writeFileSync(f, `HubSpot, not connected. I exported it to ${csv}`);
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_where', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.export_saved, csv);
  assert.ok(existsSync(join(H.dir, 'inputs', 'crm.csv')), 'the export is on the event');
  process.env.FLOORBOSS_HOME = H.HOME;
  const s = onboardingState(H.slug);
  assert.equal(s.ans.crm_choice, 'other');
  assert.ok(NODES.find((n) => n.id === 'crm_export').done(s), 'the export question is answered');
});

test('crm_where naming a file that isn\'t there: only the choice is saved, and the export is asked for', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\n' });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'crm_where.txt');
  writeFileSync(f, 'a spreadsheet, I can export it to ~/nowhere/contacts.csv later');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'crm_where', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.export_saved, undefined);
  process.env.FLOORBOSS_HOME = H.HOME;
  const s = onboardingState(H.slug);
  assert.equal(s.ans.crm_choice, 'spreadsheet');
  assert.ok(!NODES.find((n) => n.id === 'crm_export').done(s));
});
