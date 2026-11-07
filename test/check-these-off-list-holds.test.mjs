// A check-these answer about someone floorboss didn't ask about is decided as at the gate: a coworker's
// contact is refused with the gate's choices (the other lines are saved), "anyway" writes to them, and anything
// else is saved and said ("not in this check: applied anyway").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, idOf } from './fixtures/harness.mjs';

const CRM = 'Contact Name,Email,Company,Job Title,Deal Stage,Contact Owner,Last Activity,Email Opt Out\nOlivia Grant,olivia@brightway.example,Brightway Retail,Head of Fulfilment,Proposal,Priya Shah,2026-10-20,No\n';
const LIST = 'Name,Title,Company,Email\nJames Cole,Yard Operations Lead,Brightway Retail,james@brightway.example\nSofia Lindqvist,Logistics Director,Nordkap Home,sofia@nordkap.example\nPia Holm,Head of Operations,Fjordvik,pia@fjordvik.example\n';

function atCheck() {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Sam Rivera', crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Priya Shah'] } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const id = (n) => idOf(H, n);
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: id('James Cole'), segment: 'ops-leaders', reason: 'yard lead', score: 80 }, { id: id('Sofia Lindqvist'), unsure: true, reason: 'logistics director', score: 70 }, { id: id('Pia Holm'), segment: 'ops-leaders', reason: 'ops head', score: 60 }])]);
  return { H, id };
}
const groupOf = (H, id) => cli(H, 'crm-triage', ['view', '--event', H.slug]).top.find((x) => x.id === id)?.group || null;

test('check-these: a reach on a coworker\'s contact not in the check is refused with the gate\'s choices; the other lines are saved', () => {
  const { H, id } = atCheck();
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${id('Sofia Lindqvist')} reach because she runs the docks\n${id('James Cole')} reach because James asked me about yard checks on a webinar`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /James Cole \(c\d+\) is at Priya Shah's account .*Say "c\d+ reach anyway because <why>"/);
  assert.match(r.tell_user, /Not saved: "c\d+ reach because James asked me/);
  assert.equal(groupOf(H, id('Sofia Lindqvist')), 'reach', 'the other line is saved');
  assert.equal(cli(H, 'crm-triage', ['view', '--event', H.slug]).top.some((x) => x.id === id('James Cole')), false, 'James stays with Priya');
});

test('check-these: "anyway" writes to the coworker\'s contact; a line on someone else not asked about is applied and said', () => {
  const { H, id } = atCheck();
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${id('Sofia Lindqvist')} reach because she runs the docks\n${id('James Cole')} reach anyway because he asked me on a webinar\n${id('Pia Holm')} skip because she left`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.refused, undefined);
  assert.deepEqual(r.not_in_check.sort(), [id('James Cole'), id('Pia Holm')].sort());
  assert.match(r.tell_user, /^Not in this check: applied anyway: /);
  assert.equal(groupOf(H, id('James Cole')), 'reach');
});

test('check-these: every line refused saves nothing and says why', () => {
  const { H, id } = atCheck();
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${id('James Cole')} warm because we met`]);
  assert.match(r.ERROR, /at Priya Shah's account.*Nothing was saved/s);
});
