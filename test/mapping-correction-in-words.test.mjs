// A mapping correction said in words is applied, clause by clause: "Lifecycle is the status column. Customer means
// customer, Open Deal is warm, Prospect means hold, Closed Lost is lost. And there's no opt-out column." sets the
// status column, its four values and no opt-out column. A clause floorboss can't read refuses the whole answer,
// naming it and what was read: a correction is never dropped while the mapping is marked confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';

const LIST = 'Full Name,Job Title,Organisation,Email Address\nLena Vogt,Head of Payments,Cartwise,lena.vogt@cartwise.example\n';
const CRM = [
  'Contact Name,Email,Account,Owner,Lifecycle,Notes',
  ',,Kassenwerk,Ines Moreau,Customer,Account renews in Q1',
  'Lena Vogt,lena.vogt@cartwise.example,Cartwise,Ines Moreau,Open Deal,Asked for pilot pricing',
  'Tomás Rey,tomas@shelfly.example,Shelfly,Ines Moreau,Prospect,',
  'Marco Bellini,marco@pickpack.example,Pickpack,Sam Okafor,Closed Lost,Lost on price March 2026',
].join('\n') + '\n';
const SAID = "Lifecycle is the status column. Customer means customer, Open Deal is warm, Prospect means hold, Closed Lost is lost. And there's no opt-out column.";
const say = (H, text) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', 'map.txt'); writeFileSync(f, text); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'map_columns_crm', '--value-file', f]); };
const saved = (H) => (existsSync(join(H.dir, 'sources')) ? readdirSync(join(H.dir, 'sources')).map((f) => JSON.parse(readFileSync(join(H.dir, 'sources', f), 'utf8'))).find((m) => m.kind === 'crm' && m.confirmed) : null);
const fresh = () => { const H = setup({ attendees: LIST, crm: CRM, settings: { crm_user_name: 'Ines Moreau' } }); assert.ok(!cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']).ERROR); return H; };

test('the simulated tester\'s sentence sets the status column, every value it names, and no opt-out column', () => {
  const H = fresh();
  const r = say(H, SAID);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.confirmed, true);
  assert.ok(r.result.read.includes('"Lifecycle" is the status column'), JSON.stringify(r.result.read));
  const m = saved(H);
  assert.equal(m.columns.Lifecycle.field, 'status');
  assert.deepEqual(m.values.status, { Customer: 'customer', 'Open Deal': 'warm', Prospect: 'hold', 'Closed Lost': 'lost' });
  assert.equal(m.opt_out_none, true);
  assert.match(r.result.opt_out, /you said there is none/);
});

test('a clause floorboss can\'t read refuses the answer, naming it and what was read; nothing is confirmed', () => {
  const H = fresh();
  const r = say(H, 'Lifecycle is the status column. Customer means customer, and the owner column is sometimes out of date.');
  assert.match(r.ERROR || '', /Not saved: floorboss couldn't read "the owner column is sometimes out of date"\. It did read: "Lifecycle" is the status column; "Customer" means customer\..*Nothing was saved\./);
  assert.equal(saved(H), undefined);
});

test('a status value the file doesn\'t have is not read; one the answer leaves out is read and said', () => {
  const H = fresh();
  const bad = say(H, "Lifecycle is the status column. Churned means lost. There's no opt-out column.");
  assert.match(bad.ERROR || '', /couldn't read "Churned means lost".*the status values: Customer, Open Deal, Prospect, Closed Lost/);
  // A column the proposal didn't read as the status ("Tier"): the values the answer doesn't name are floorboss's
  // reading of the word, said back.
  const T = setup({ attendees: LIST, crm: CRM.replace('Lifecycle', 'Tier'), settings: { crm_user_name: 'Ines Moreau' } });
  cli(T, 'crm-triage', ['propose-mapping', '--event', T.slug, '--kind', 'crm']);
  const r = say(T, "Tier is the status column, Prospect means hold. There's no opt-out column.");
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(saved(T).values.status, { Customer: 'customer', 'Open Deal': 'warm', Prospect: 'hold', 'Closed Lost': 'lost' });
  assert.match(r.result.statuses_not_named, /"Customer" read as customer, "Open Deal" read as warm, "Closed Lost" read as lost/);
});

test('words that read as nothing at all get the plain refusal', () => {
  const H = fresh();
  const vague = say(H, 'hmm, not sure about this');
  assert.match(vague.ERROR || '', /the corrected mapping as JSON .* not a path or words; to leave a column out, say "ignore <column>" \(the columns: Contact Name, Email/);
  assert.equal(saved(H), undefined);
});
