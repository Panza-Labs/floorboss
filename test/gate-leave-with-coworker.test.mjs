// The gate takes the wording its own refusal offers: "leave Daniel with Priya" and "hold James Cole" leave
// them with the coworker who holds them, with the user's words kept. A line that can't be read is refused on
// its own: the other lines of the answer are saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, idOf } from './fixtures/harness.mjs';

const CRM = 'Contact Name,Email,Company,Job Title,Deal Stage,Contact Owner,Last Activity,Email Opt Out\nDaniel Novak,d.novak@danubia.example,Danubia 3PL,Warehouse Manager,Lead,Priya Shah,2026-06-10,No\nOlivia Grant,olivia@brightway.example,Brightway Retail,Head of Fulfilment,Proposal,Priya Shah,2026-10-20,No\n';
const LIST = 'Name,Title,Company,Email\nDaniel Novak,Warehouse Manager,Danubia 3PL,d.novak@danubia.example\nJames Cole,Yard Operations Lead,Brightway Retail,james@brightway.example\nFelix Braun,Site Manager,Kessler Distribution,felix@kessler.example\n';

function atGate() {
  const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Sam Rivera', crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Priya Shah'] } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify(load.needs_fit.map((r, i) => ({ id: r.id, segment: 'ops-leaders', reason: r.title, score: 80 - i })))]);
  return H;
}

test('gate: the refusal\'s own wording ("leave Daniel with Priya") is an answer, and "hold James Cole" with no "until" too', () => {
  const H = atGate();
  const refused = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Daniel Novak']);
  assert.match(refused.ERROR, /or "leave Daniel Novak with Priya Shah"/);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'hold James Cole\nleave Daniel with Priya']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.refused, undefined, JSON.stringify(g.refused));
  const view = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const why = (name) => view.left_out.find((x) => x.e_g.some((e) => e.includes(name)))?.why || '';
  assert.match(why('Daniel Novak'), /colleague holds them \(Priya Shah\)/);
  assert.match(why('James Cole'), /colleague holds them \(Priya Shah\)/);
});

test('gate: a line that isn\'t an answer is refused on its own; the other lines are saved', () => {
  const H = atGate();
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'hold James Cole until Priya says yes\nfrobnicate Daniel\nskip Felix Braun because one at Kessler is enough']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.deepEqual(g.refused.map((x) => x.line), ['frobnicate Daniel']);
  assert.match(g.tell_user, /Saved: "hold James Cole until Priya says yes", "skip Felix Braun because one at Kessler is enough"\. Not saved: "frobnicate Daniel": "frobnicate" isn't an answer here/);
  assert.ok(!cli(H, 'crm-triage', ['view', '--event', H.slug]).top.some((x) => /Felix|James/.test(x.name)));
});

test('gate: "leave" is only for someone a coworker holds', () => {
  const H = atGate();
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'leave Felix Braun with Priya']);
  assert.match(g.ERROR, /Felix Braun isn't held by a coworker.*"skip Felix Braun"/);
});
