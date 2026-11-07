// Suppression: a "no" must reach every exit (todo, gate, outbox, staging, later events), and inputs fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { setup, cli, triage, todoJobs, groups, idOf, draftApprove, outboxHas } from './fixtures/harness.mjs';
import { parseDncReport } from '../skills/crm-triage/scripts/dnc.mjs';
import { normEmail, normPersonName, hasSurname, companyKey } from '../lib/normalize.mjs';

const HEAD = 'Name,Title,Company,Email\n';

test('a re-load that suppresses people reaches todo, the gate, the outbox and staging', () => {
  const crm = 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed\nBo Li,bo@globex.test,Globex Logistics,,Lead,,false\n';
  const H = setup({ attendees: `${HEAD}Jane Doe,VP Operations,Acme Freight,jane@acme.test\nBo Li,VP Operations,Globex Logistics,bo@globex.test\n`, crm, dnc: '# none\n' });
  triage(H);
  draftApprove(H);
  assert.ok(outboxHas(H, 'Jane Doe') && outboxHas(H, 'Bo Li'));
  writeFileSync(`${H.dir}/crm.csv`, crm.replace(',false', ',true'));
  writeFileSync(`${H.dir}/dnc.txt`, 'Acme Freight\n');
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.deepEqual(todoJobs(H).jobs.filter((j) => j.kind === 'message'), []);
  cli(H, 'event-outreach', ['render', '--event', H.slug]);
  assert.ok(!outboxHas(H, 'Jane Doe') && !outboxHas(H, 'Bo Li'), 'blocked cards leave the outbox');
  assert.equal(cli(H, 'event-outreach', ['stage-list', '--event', H.slug]).to_stage, 0);
  const s = cli(H, 'event-outreach', ['summary', '--event', H.slug]);
  assert.equal(s.do_not_send.people.length, 2);
});

test('removed at the triage gate or put on the do-not-contact list after approval leaves the outbox', () => {
  const H = setup({ attendees: `${HEAD}Jane Doe,VP Operations,Acme Freight,jane@acme.test\nCy Ng,VP Operations,Initech,cy@initech.test\nDi Ho,VP Operations,Hooli,di@hooli.test\n` });
  triage(H);
  draftApprove(H);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `remove ${idOf(H, 'Cy Ng')}`]);
  writeFileSync(`${H.dir}/dnc.txt`, 'jane@acme.test\n');
  cli(H, 'crm-triage', ['load', '--event', H.slug, '--dnc', `${H.dir}/dnc.txt`]);
  cli(H, 'event-outreach', ['render', '--event', H.slug]);
  assert.ok(!outboxHas(H, 'Jane Doe') && !outboxHas(H, 'Cy Ng') && outboxHas(H, 'Di Ho'));
});

test('every stop in the ledger reaches later events by email and by name, even after a crash', () => {
  const H = setup({ attendees: `${HEAD}Jane Doe,VP Operations,Acme Freight,jane@acme.test\n` });
  triage(H);
  draftApprove(H);
  const id = idOf(H, 'Jane Doe');
  writeFileSync(`${H.dir}/ledger.jsonl`, `${readFileSync(`${H.dir}/ledger.jsonl`, 'utf8')}${JSON.stringify({ at: '2026-10-12T08:00:00Z', type: 'stop', who: 'user', id, said: 'stop' })}\n`);
  cli(H, 'event-outreach', ['status', '--event', H.slug, '--text', `floorboss-status v1 event=${H.slug} at=2026-10-12T07:59:00Z\n${id} sent=2026-10-12 stop`]);
  // Next event, same address: held.
  const H1 = setup({ home: H.HOME, event: { slug: 'ev1' }, attendees: `${HEAD}Jane Doe,COO,Acme Freight,jane@acme.test\n` });
  cli(H1, 'crm-triage', ['load', '--event', 'ev1']);
  assert.equal(groups(H1)['Jane Doe'], 'suppressed', 'by email');
  // Next event: a new address, same person.
  const H2 = setup({ home: H.HOME, event: { slug: 'ev2' }, attendees: `${HEAD}Jane Doe,COO,Acme Freight,jane.doe@acme-new.test\n` });
  cli(H2, 'crm-triage', ['load', '--event', 'ev2']);
  assert.equal(groups(H2)['Jane Doe'], 'suppressed');
});

test('do-not-contact parsing fails closed', () => {
  const { entries, notes } = parseDncReport('email,date added\njane.doe@acme.test,2024-03-01\nmailto:dan@umbrella.test\n"Stone, Eve",eve@uws.test\nMia Chen <mia@tyrell.test>\n"ned@cyberdyne.test"\nAna,ana@a.test;bo@b.test\n', { today: '2026-10-12' });
  const emails = entries.filter((e) => e.type === 'email').map((e) => e.value);
  assert.deepEqual(emails, ['jane.doe@acme.test', 'dan@umbrella.test', 'eve@uws.test', 'mia@tyrell.test', 'ned@cyberdyne.test', 'ana@a.test', 'bo@b.test']);
  assert.equal(entries[0].until, null, 'a "date added" column is not an expiry');
  assert.match(notes.join(' '), /weren't read as expiry dates/);
  const exp = parseDncReport('email,until\nx@y.test,2025-01-01\n', { today: '2026-10-12' });
  assert.equal(exp.entries[0].until, '2025-01-01');
  assert.match(exp.notes.join(' '), /expired/);
});

test('the big fixture: duplicate CRM records, odd opt-outs, plus-tags, zero-width company, owner unset', () => {
  const att = `${HEAD}Jane Doe,VP Operations,Acme Freight,jane.doe@acme.test
Carla Diaz,VP Operations,Initech Shipping,carla.diaz.example+expo@gmail.com
Gus Hart,VP Operations,Hooli Transport,gus@hooli.test
Hana Ito,VP Operations,Soylent Foods,hana@soylent.test
Ian Wu,VP Operations,Wonka Logistics,ian@wonka.test
Leo Ray,VP Operations,Ac​me Freight,leo@acmefreight.test
Kat Lo,VP Operations,Vandelay,kat@vandelay.test
`;
  const crm = `Name,Email,Company,Owner,Status,Last Contact,Unsubscribed
Gus Hart,gus@hooli.test,Hooli Transport,,Lead,,true
Gus Hart,gus@hooli.test,Hooli Transport,,Lead,,false
Hana Ito,hana@soylent.test,Soylent Foods,,Unsubscribed,,
Ian Wu,ian@wonka.test,Wonka Logistics,,Lead,,Yes - unsubscribed
Kat Lo,kat@vandelay.test,Vandelay,Pat Lo,Lead,,
`;
  const H = setup({ attendees: att, crm, dnc: 'email,date added\njane.doe@acme.test,2024-03-01\ncarla.diaz.example@gmail.com\nacmefreight.test\n', settings: { crm_user_name: null } });
  triage(H);
  const g = groups(H);
  for (const n of ['Jane Doe', 'Carla Diaz', 'Gus Hart', 'Hana Ito', 'Ian Wu', 'Leo Ray']) assert.equal(g[n], 'suppressed', n);
  assert.equal(g['Kat Lo'], 'coordinate', 'an owner with no crm_user_name set counts as a colleague');
});

test('a CRM lookup that answers for only some people holds the rest', () => {
  const H = setup({ attendees: `${HEAD}Jane Doe,VP Operations,Acme Freight,jane@acme.test\nBo Li,VP Operations,Globex,bo@globex.test\n` });
  // A connected CRM: the lookups are what the recipe returned.
  writeFileSync(`${H.HOME}/config.json`, JSON.stringify({ connectors: { 'crm.lookup': { server: 'crm', tool: 'search_contacts', args: { query: '{email}' }, reading: 'x', tool_hash: 'a'.repeat(64), opt_out_source: 'hs_email_optout', probe: { ok: true } } } }));
  const f = `${H.dir}/recs.json`;
  writeFileSync(f, JSON.stringify({ records: [{ name: 'Jane Doe', email: 'jane@acme.test', company: 'Acme Freight', opted_out: false }] }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm-records', f]);
  assert.ok(!load.ERROR, load.ERROR);
  assert.match(load.crm.source, /connector/);
  assert.deepEqual(load.check_these.map((x) => x.id), [idOf(H, 'Bo Li')]);
  assert.match(load.check_these[0].says, /the CRM lookup gave no answer for them/);
  assert.equal(groups(H)['Bo Li'], 'check');
  assert.equal(groups(H)['Jane Doe'], 'open');
  writeFileSync(f, JSON.stringify({ records: [] }));
  const empty = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm-records', f]);
  assert.equal(empty.check_these.length, 2, 'an empty answer checks nobody');
  // Said not found: no longer a question.
  writeFileSync(f, JSON.stringify({ records: [{ query: 'jane@acme.test', found: false }, { query: 'bo@globex.test', found: false }] }));
  const none = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm-records', f]);
  assert.equal(none.crm.not_found, 2);
  assert.deepEqual(none.check_these, []);
});

test('a company website column does not merge colleagues; a "no" on either registration wins', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,Website,Open to meetings\nAnna Berg,COO,Albrecht Antriebe,anna@albrecht.test,https://www.albrecht.test/de,yes\nBen Ott,CFO,Albrecht Antriebe,,https://www.albrecht.test/de,yes\nCy Ng,VP Ops,Initech,cy@initech.test,,yes\nCy Ng,VP Ops,Initech,cy@initech.test,,Nein\n' });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const g = groups(H);
  assert.ok(g['Anna Berg'] && g['Ben Ott'], JSON.stringify(load.counts));
  assert.equal(g['Cy Ng'], 'suppressed');
});


test('accounts off-limits or owned by a colleague cover everyone there, under any spelling', () => {
  const att = `${HEAD}Kim Park,VP Ops,Wayne Shipping,kim@wayne.test
Lee Ma,COO,Wayne Shipping Ltd,lee@wayne.test
Eve Stone,VP Ops,Umbra Web Systems,eve@uws.test
Fay Lim,VP Ops,UWS,fay.lim.example@gmail.com
Ola Berg,COO,Oscorp,ola@oscorp.test
Pia Holm,COO,Umbrella,pia@umbrella-group.test
Ned Fox,COO,Cyberdyne,ned@cyberdyne.test
`;
  const crm = 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed\nZed Wu,zed@wayne.test,Wayne Shipping,Pat Teammate,Customer,2026-09-01,false\n';
  const accounts = 'Account,Domain,Owner,Status\nUmbra,,,Off-limits\nOscorp,,Sam Rivera,Customer\n,umbrella-group.test,Jo Teammate,Open deal\n';
  // Accounts the CRM implies wait for the user's OK: until then, check-these.
  const H0 = setup({ attendees: att, crm, accounts });
  const t0 = triage(H0);
  assert.equal(groups(H0)['Kim Park'], 'check');
  assert.ok(t0.load.accounts.from_crm >= 1, JSON.stringify(t0.load.accounts));
  assert.match(t0.load.accounts.crm_accounts, /^not decided/);
  assert.match(t0.load.check_these.find((x) => x.name === 'Kim Park').says, /Pat Teammate owns the Wayne Shipping account in the CRM/);
  const H = setup({ attendees: att, crm, accounts, dnc: 'company: Cyberdyne\n', settings: { crm_accounts: 'apply' } });
  const t = triage(H);
  const g = groups(H);
  assert.equal(g['Kim Park'], 'coordinate');
  assert.equal(g['Lee Ma'], 'coordinate');
  // Names that only look like an off-limits account are held on check-these, saying why ("Tide" must not
  // silently block Tide Dental).
  assert.equal(g['Eve Stone'], 'check');
  assert.equal(g['Fay Lim'], 'check', 'UWS are the initials of Umbra Web Systems');
  assert.notEqual(g['Ola Berg'], 'coordinate', 'your own account');
  assert.equal(g['Pia Holm'], 'coordinate', 'matched by domain');
  assert.equal(g['Ned Fox'], 'suppressed');
  assert.deepEqual([t.load.accounts.listed, t.load.accounts.crm_accounts], [3, 'apply']);
});

test('a nickname or initial of a CRM opt-out goes to check-these, never cold', () => {
  const crm = 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed\nBob Smith,bob@globex.test,Globex Logistics,,Lead,,true\n';
  const H = setup({ attendees: `${HEAD}Robert Smith,VP Ops,Globex Logistics,robert.smith@globex.test\nR. Jones,VP Ops,Initech,rj@initech.test\n`, crm });
  triage(H);
  assert.equal(groups(H)['Robert Smith'], 'check');
});

test('one cap covers company spellings', () => {
  const H = setup({ attendees: `${HEAD}A One,VP Ops,Oceanic,a@o.test\nB Two,VP Ops,Oceanic Lines,b@o.test\nC Three,VP Ops,Oceanic Lines (UK),c@o.test\n`, settings: { account_cap: 1 } });
  triage(H);
  const g = JSON.parse(readFileSync(`${H.dir}/derived/compat/triage.json`, 'utf8')).final;
  assert.equal(Object.values(g).filter((x) => x.group === 'cold' && !x.over_cap).length, 1);
});

test('a new address for someone removed stays removed; a second row for one person is merged into them', () => {
  const H = setup({ attendees: `${HEAD}Dev Patel,VP Ops,Acme,dev@acme.test\nAna Sousa,COO,Initech,ana@initech.test\n` });
  triage(H);
  const dev = idOf(H, 'Dev Patel'), ana = idOf(H, 'Ana Sousa');
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `remove ${dev}`]);
  writeFileSync(`${H.dir}/attendees.csv`, `${HEAD}Dev Patel,VP Ops,Acme,dev.patel@acme-new.test\nAna Sousa,COO,Initech,ana@initech.test\nAna M. Sousa,COO,Initech,ana.sousa.example@gmail.com\nJon Smith,CTO,Hooli,jon@hooli.test\nJonathan Smith,CTO,Hooli,jsmith@hooli.test\n`);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const all = JSON.parse(readFileSync(`${H.dir}/derived/compat/contacts.json`, 'utf8')).contacts;
  assert.equal(all.length, 3, 'five rows, three people');
  const devNow = all.find((c) => c.name === 'Dev Patel');
  assert.equal(devNow.id, dev);
  assert.equal(devNow.email, 'dev.patel@acme-new.test');
  const g = groups(H);
  assert.equal(g['Dev Patel'], 'suppressed');
  const anaNow = all.find((c) => c.id === ana);
  assert.deepEqual([anaNow.email, anaNow.emails_seen], ['ana@initech.test', ['ana.sousa.example@gmail.com']], 'the work address represents her; the other is kept');
  assert.equal(g[anaNow.name], 'cold', 'the merge keeps her fit and her place');
  const jon = all.find((c) => /Smith/.test(c.name));
  assert.equal(jon.name, 'Jonathan Smith', 'the fullest name');
  assert.deepEqual([...jon.emails_seen, jon.email].sort(), ['jon@hooli.test', 'jsmith@hooli.test']);
  assert.equal(load.duplicates_merged.length, 2);
});

test('normalize: name and company spelling variants', async () => {
  const { normPersonName, sameName, companyRelated, companyKey: k } = await import('../lib/normalize.mjs');
  assert.equal(normPersonName('DOE Jane'), 'jane doe');
  assert.equal(normPersonName('Doe, PMP'), 'doe');
  assert.equal(normPersonName('Li (he/him)'), 'li');
  assert.ok(sameName('Jane Doe-Smith', 'Jane Doe'));
  assert.ok(!sameName('Patrick Lee', 'Patricia Lee'));
  assert.ok(sameName('Bob Smith', 'Robert Smith'));
  assert.ok(companyRelated(k('Acme Frieght'), k('Acme Freight')));
  assert.ok(companyRelated(k('Saint-Verne'), k('St. Verne')));
  assert.ok(companyRelated(k('Acme Freight International'), k('Acme Freight Intl')));
  const { parseDncReport } = await import('../skills/crm-triage/scripts/dnc.mjs');
  assert.ok(parseDncReport('Fox, Di (Hooli)\n').entries.some((e) => e.type === 'name' && e.value === 'di fox'));
});

test('a confirm at the gate keeps the CRM given with --crm (holds and colleagues survive the rerun)', () => {
  const H = setup({ attendees: `${HEAD}Wanda Wall,Head of Cardiology,Salzach Klinik,wanda@salzach.test\nBob Smith,COO,Globex Logistics,robert.smith@globex.test\nKai Ko,COO,Initech,kai@initech.test\n` });
  const crmPath = `${H.dir}/sf.csv`;
  writeFileSync(crmPath, 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed\nWanda Wall,wanda@salzach.test,Salzach Klinik,Markus Teammate,Compliance hold - tender,,false\nRobert Smith,rsmith@globex.test,Globex Logistics,,Lead,,false\n');
  const t = triage(H, ['--crm', crmPath]);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  assert.equal(groups(H)['Wanda Wall'], 'suppressed');
  const bob = idOf(H, 'Bob Smith');
  assert.equal(groups(H)['Bob Smith'], 'check');
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `confirm ${bob}`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(groups(H)['Wanda Wall'], 'suppressed', 'the tender hold survives the confirm');
});

test('a conflicts flag in a second status column covers the firm; "separate" drops an uncertain CRM match', () => {
  const att = `${HEAD}Jasmine Kowalski,Partner,Pell & Granger LLP,jk@pellgranger.test\nMichael Chen,CTO,Hooli,mchen@hooli.test\n`;
  const crm = 'First Name,Last Name,Email,Company Name,Contact owner,Lifecycle Stage,Lead Status,Unsubscribed from all email\nAl Moreno,Whit,amw@pellgranger.test,Pell & Granger LLP,Sam Rivera,Lead,Do not contact - conflicts,false\nMike,Chen,mike.chen@hooli-old.test,Hooli Inc,,Customer,Open,true\n';
  const H = setup({ attendees: att, crm, settings: { crm_accounts: 'apply' } });
  triage(H);
  assert.equal(groups(H)['Jasmine Kowalski'], 'suppressed');
  assert.equal(groups(H)['Michael Chen'], 'check');
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `separate ${idOf(H, 'Michael Chen')}`]);
  assert.equal(JSON.parse(readFileSync(`${H.dir}/derived/compat/triage.json`, 'utf8')).pre[idOf(H, 'Michael Chen')].group, 'open');
});

test('an off-limits firm holds even someone whose own record is yours; a deactivated owner holds nothing', () => {
  const att = `${HEAD}Jasmine Kowalski,Partner,Pell & Granger LLP,jk@pellgranger.test\nGabe Ferraro,GC,Initech,gabe@initech.test\n`;
  const crm = 'Name,Email,Company,Owner,Status,Unsubscribed\nJasmine Kowalski,jk@pellgranger.test,Pell & Granger LLP,Sam Rivera,Customer,false\nAl Whit,amw@pellgranger.test,Pell & Granger LLP,Dana Teammate,Do not contact - conflicts,false\nGabe Ferraro,gabe@initech.test,Initech,Jordan Pike (Deactivated User),Customer,false\n';
  const H = setup({ attendees: att, crm, settings: { crm_accounts: 'apply' } });
  triage(H);
  assert.equal(groups(H)['Jasmine Kowalski'], 'suppressed');
  assert.notEqual(groups(H)['Gabe Ferraro'], 'coordinate');
});

test('shared email domains keep each company for holds; near-identical companies are one person', () => {
  // Most @valecare rows say Valecare Westfield; Dan is at Valecare Eastbrook, which is on the do-not-contact list.
  const H = setup({ attendees: `${HEAD}Ann A,COO,Valecare Westfield,ann@valecare.test\nBen B,COO,Valecare Westfield,ben@valecare.test\nCat C,COO,Valecare Westfield,cat@valecare.test\nDan D,COO,Valecare Eastbrook,dan@valecare.test\n`, dnc: 'company: Valecare Eastbrook\n' });
  triage(H);
  assert.equal(groups(H)['Dan D'], 'suppressed');
  assert.equal(groups(H)['Ann A'], 'cold');
  // One person, two rows, "Acme" and "Acme Freight": one contact, nobody on check-these.
  const H3 = setup({ attendees: `${HEAD}Jane Doe,COO,Acme Freight,jane@acme.test\nJane Doe,COO,Acme,jane.doe.example@gmail.com\n` });
  const load3 = cli(H3, 'crm-triage', ['load', '--event', H3.slug]);
  assert.equal(load3.attendees.people, 1);
  assert.deepEqual(load3.check_these, []);
  assert.match(load3.duplicates_merged[0].why.join(' '), /same name at Acme Freight/);
});
