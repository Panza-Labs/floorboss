// Unclear answers never settle a send, a fuzzy match is settled before anyone is reached, a bounce isn't an
// unclear send, and the readers of free text hold the person when unsure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf } from './fixtures/harness.mjs';
import { fold, readLedger } from '../lib/ledger.mjs';
import { parseScale, bandOf } from '../skills/crm-triage/scripts/sizes.mjs';
import { propose, STOP_WORDS, defaultStatusMeaning } from '../skills/crm-triage/scripts/sources.mjs';
import { followupsModeOf } from '../skills/flow/scripts/steps.mjs';
import { ownerIsUserFor } from '../skills/crm-triage/scripts/resolve.mjs';

const answer = (H, ask, value) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', `${ask}.json`); writeFileSync(f, JSON.stringify(value)); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]); };
const ledgerOf = (H) => fold(readLedger(join(H.dir, 'ledger.jsonl')).entries);

test('an unclear send is settled only by a clear answer, for the person the step is about', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' } } });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  appendFileSync(join(H.dir, 'ledger.jsonl'), [{ type: 'send_released', who: 'guard', id: ana, touch: 1, hash: 'x', via: 'email.send', to: 'ana@acme.test' }, { type: 'send_unclear', who: 'floorboss', id: ana, touch: 1, error: 'timed out' }].map((e) => JSON.stringify({ at: '2026-10-12T08:00:00Z', ...e })).join('\n') + '\n');
  for (const unsure of [{ went: 'not sure', said: 'I cannot tell' }, { went: 'unknown' }, 'maybe?']) assert.match(answer(H, 'send_outcome', unsure).ERROR || '', /Ask again/, JSON.stringify(unsure));
  assert.equal(ledgerOf(H).people[ana].touches[1].release_cleared, false, 'still unsettled');
  assert.equal(answer(H, 'send_outcome', 'it did not go').ERROR, undefined);
  assert.equal(ledgerOf(H).people[ana].touches[1].release_cleared, true);
});

test('a bounce is settled, not an unclear send', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  appendFileSync(join(H.dir, 'ledger.jsonl'), [{ type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Berg', email: 'ana@acme.test' }, { type: 'send_released', who: 'guard', id: 'c001', touch: 1, hash: 'x', via: 'email.send', to: 'ana@acme.test' }, { type: 'sent', who: 'floorboss', id: 'c001', touch: 1, date: '2026-10-12', via: 'floorboss', message_id: 'm1' }, { type: 'bounced', who: 'mailbox', id: 'c001', touch: 1 }].map((e) => JSON.stringify({ at: '2026-10-12T08:00:00Z', ...e })).join('\n') + '\n');
  const x = ledgerOf(H).people.c001.touches[1];
  assert.equal(x.released, false);
  assert.equal(x.sent, null);
});

test('check-these: a fuzzy match is settled before anyone is reached; the record\'s opt-out is shown', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', crm: 'Name,Company,Email,Owner,Status,Opted Out\nAnna Berg,Acme,a.berg@acme-group.test,Sam Rivera,Lead,yes\n', settings: { crm_user_name: 'Sam Rivera' } });
  triage(H);
  const res = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8')).c001;
  assert.equal(res.rung, 'fuzzy');
  assert.ok(res.alternatives.some((a) => /opted out/.test(a.would_be)), JSON.stringify(res.alternatives));
  assert.match(answer(H, 'check_these', 'c001 reach because I know her').ERROR || '', /uncertain match/);
  assert.equal(answer(H, 'check_these', 'c001 same-person crm:0').ERROR, undefined);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8')).c001.group, 'skip', 'the same person, who opted out');
});

test('check-these: a bare "<id> different-person" settles the match, as the gate\'s "separate <id>" does', () => {
  const crm = 'Name,Company,Email,Owner,Status,Opted Out\nAnna Berg,Acme,a.berg@acme-group.test,Sam Rivera,Lead,yes\n';
  const people = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n';
  const H = setup({ attendees: people, crm, settings: { crm_user_name: 'Sam Rivera' } });
  triage(H);
  const r = answer(H, 'check_these', 'c001 different-person');
  assert.equal(r.ERROR, undefined, r.ERROR);
  const res = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8')).c001;
  assert.notEqual(res.group, 'check', JSON.stringify(res));
  assert.notEqual(res.rung, 'fuzzy');
  // The same answer through the gate's word gives the same result.
  const G = setup({ attendees: people, crm, settings: { crm_user_name: 'Sam Rivera' } });
  triage(G, [], 'separate c001');
  assert.equal(JSON.parse(readFileSync(join(G.dir, 'derived', 'resolved.json'), 'utf8')).c001.group, res.group);
  // A bare "same-person" with one uncertain CRM row settles on that row; the forms offered are the ones accepted.
  const S = setup({ attendees: people, crm, settings: { crm_user_name: 'Sam Rivera' } });
  triage(S);
  const view = cli(S, 'crm-triage', ['view', '--event', S.slug]);
  assert.ok((view.check_these || []).length, JSON.stringify(view).slice(0, 300));
  for (const x of view.check_these) assert.doesNotMatch(x.answer_with, /--ref/);
  assert.equal(answer(S, 'check_these', 'c001 same-person').ERROR, undefined);
  assert.equal(JSON.parse(readFileSync(join(S.dir, 'derived', 'resolved.json'), 'utf8')).c001.group, 'skip', 'the same person, who opted out');
});

test('free-text readers: scales, sizes, ratings, follow-up modes, owners, columns and stop words', () => {
  assert.deepEqual(parseScale('1 at small firms, 2 at mid-size, 4 at large ones'), { micro: 1, small: 1, mid: 2, large: 4, enterprise: 5, unknown: 2 });
  assert.equal(parseScale('one per company, but 3 at enterprises').enterprise, 3);
  assert.equal(parseScale('one per company, but 3 at enterprises').large, 1);
  assert.equal(parseScale('small 1 mid 2'), null, 'no commas: too easy to misread');
  assert.equal(bandOf('2.5k'), 'large');
  assert.equal(bandOf('ca. 40 Mitarbeiter (2019)'), 'small');
  assert.equal(bandOf('1.000'), 'large');
  for (const t of ['ask me before each follow-up goes', 'let me approve them first', 'manual', 'I approve each round; never on its day automatically']) assert.equal(followupsModeOf(t), 'each_round', t);
  assert.equal(followupsModeOf('whatever'), null);
  assert.equal(ownerIsUserFor({ crm_user_name: 'Sam Lee' }, ['Sam', 'Sam Park'])('Sam'), false, 'a CRM owner "Sam Park" makes a bare "Sam" ambiguous');
  const cols = (h) => Object.fromEntries(Object.entries(propose(h, [], 'crm').columns).map(([k, c]) => [k, c.field]));
  assert.equal(cols(['Name', 'Firma', 'Zuständiger Mitarbeiter'])['Zuständiger Mitarbeiter'], 'owner');
  assert.equal(cols(['Full Name', 'Account', 'Do Not Email (Y/N)'])['Do Not Email (Y/N)'], 'opted_out');
  assert.equal(cols(['Name', 'Company', 'Staff'])['Staff'], 'ignore');
  for (const t of ['Bitte keine Mails mehr', 'Kontakt unerwünscht', 'wünscht keinen Kontakt', 'Darse de baja', 'Ne souhaite plus être contacté']) assert.ok(STOP_WORDS.test(t), t);
  for (const v of ['Kontakt unerwünscht', 'Do Not Email']) assert.equal(defaultStatusMeaning(v), 'do_not_contact', v);
});

test('ratings: ranges and ambiguous lines are listed back, two on a line are both read', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Ng,Head of Ops,Initech,cy@initech.test\nDee Park,Director of Logistics,Umbrella,dee@umbrella.test\n' });
  triage(H);
  draftApprove(H);
  cli(H, 'event-outreach', ['rate-set', '--event', H.slug, '--n', '4']);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'r.txt');
  writeFileSync(f, '1-3: 7\n1: 6, 2: 7\n3. 2 sentences too long, 6\n');
  const r = cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text-file', f]);
  assert.equal(r.rated, 2, JSON.stringify(r));
  assert.equal(r.not_read.length, 2, JSON.stringify(r.not_read));
  assert.deepEqual(r.sent_back, []);
});
