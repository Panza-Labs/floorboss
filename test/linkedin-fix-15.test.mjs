// Second review of 0.1.7 (item 6): "show me the list" (and the ways people say it), answered through flow answer: the
// saver finds the people due itself and gives their names as the answer's say_to_user, shown to the user as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';

const DUE = '2026-11-05T08:00:00Z';
function mk() {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\nBo Li,VP,Globex,,https://www.linkedin.com/in/bo\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  triage(H);
  assert.ok(!draftApprove(H).gate.ERROR);
  for (const n of ['Ana Berg', 'Bo Li']) append(join(H.dir, 'ledger.jsonl'), { who: 'floorboss', type: 'sent', id: idOf(H, n), touch: 1, date: '2026-10-12', via: 'outbox' }, new Date(NOW));
  return H;
}
const answer = (H, value) => {
  process.env.FLOORBOSS_OUT_OF_TURN = '1';
  try {
    return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'no_reply', '--value', value], DUE);
  } finally {
    delete process.env.FLOORBOSS_OUT_OF_TURN;
  }
};

test('through flow answer, with no step passed in: the names, as the answer\'s say_to_user', () => {
  const H = mk();
  for (const said of ['show me the list', 'show the list', 'list them', 'who', 'which ones?']) {
    const r = answer(H, said);
    assert.ok(!r.ERROR, `${said}: ${r.ERROR}`);
    assert.match(r.say_to_user || '', /Ana Berg, Bo Li/, `${said}: ${JSON.stringify(r)}`);
    assert.match(r.say_to_user, /Due today/);
  }
  assert.equal(cli(H, 'event-outreach', ['linkedin-due', '--event', H.slug], DUE).ask.length, 2, 'nothing recorded: still asked');
});

test('an answer floorboss cannot read names the list option', () => {
  const H = mk();
  const r = answer(H, 'hmm');
  assert.match(r.ERROR || '', /show me the list/);
});
