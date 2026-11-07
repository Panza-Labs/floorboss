// Recording a coordinate note as passed on marks the note done and touches nothing about the person: no
// message to them, no place on the shortlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email\nDiane Woo,Chief Sustainability Officer,Meridian Office REIT,diane.woo@meridianreit.test\nAna Berg,COO,Acme,ana@acme.test\n';
const CRM = 'Name,Email,Company,Owner,Status,Opted Out\nDiane Woo,diane.woo@meridianreit.test,Meridian Office REIT,Jordan Fisk,Lead,no\n';

test('note_passed (or sent to:"colleague") marks the coordinate note done; a plain sent asks which it was', () => {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Jordan Fisk'], colleague_notes: true } });
  triage(H);
  const diane = idOf(H, 'Diane Woo');
  const d = draftApprove(H);
  assert.ok(d.jobs.some((j) => j.id === diane && j.kind === 'coordinate'), 'a note to Jordan was drafted');
  assert.equal(cli(H, 'event-outreach', ['tracker', '--event', H.slug]).counts['Note to colleague ready'], 1);
  const rec = (items) => { const f = join(H.dir, 'report.json'); writeFileSync(f, JSON.stringify({ items })); return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]); };
  const plain = rec([{ who: diane, what: 'sent', channel: 'slack' }]);
  assert.match(plain.ERROR || '', /held by Jordan Fisk\. If you passed the note on to Jordan Fisk, record \{"who":"c\d+","what":"note_passed"\}/);
  const ok = rec([{ who: diane, what: 'sent', to: 'colleague', channel: 'slack' }]);
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.match(ok.recorded[0], /note to Jordan Fisk about Diane Woo .* passed on via slack; nothing went to Diane Woo/);
  const again = rec([{ who: diane, what: 'note_passed' }]);
  assert.match(again.notes[0], /already recorded as passed on/);
  const tr = cli(H, 'event-outreach', ['tracker', '--event', H.slug]);
  assert.equal(tr.counts['Note to colleague ready'], undefined, JSON.stringify(tr.counts));
  assert.equal(tr.counts['Colleague told'], 1);
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.id === diane);
  assert.ok(!led.some((e) => e.type === 'sent' || e.type === 'decide'), 'nothing recorded about Diane herself');
  assert.equal(led.filter((e) => e.type === 'note_passed').length, 1);
  const res = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[diane];
  assert.equal(res.group, 'colleague', 'still left to Jordan');
  // Someone nobody holds has no note to pass on.
  const none = rec([{ who: idOf(H, 'Ana Berg'), what: 'note_passed' }]);
  assert.match(none.ERROR || '', /has no note to a colleague/);
});
