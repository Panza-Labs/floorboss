// First-time users: free-time phrasing, check-these batches, keep N, fit before CRM, reach before the CRM is
// read, account rules, customers with no deal fields and gate wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, fitAll, idOf, triage } from './fixtures/harness.mjs';
import { parseGate, TRIAGE_ANSWERS } from '../lib/gate.mjs';
import { splitDecisionLines } from '../skills/crm-triage/scripts/decisions.mjs';
import { parseFreeTimes } from '../skills/slot-finder/scripts/freetimes.mjs';

const ledger = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const hours = (t, eventDays) => { const r = parseFreeTimes(t, { eventDays }); return { got: r.ranges.map((x) => `${x.date.slice(5)} ${x.start / 60}-${x.end / 60}`), unparsed: r.unparsed, except: r.except }; };

test('free times: plain phrasing parses; "normal hours" is 9 to 18; exceptions are taken out, never dropped', () => {
  const three = ['2026-11-10', '2026-11-11', '2026-11-12'];
  const a = hours('whole event except opening night, normal hours', three);
  assert.deepEqual(a.got, ['11-10 9-18', '11-11 9-18', '11-12 9-18']);
  assert.deepEqual(a.except, [{ dates: ['2026-11-10'], start: 18 * 60, end: 24 * 60 }], 'opening night is the first evening');
  const b = hours('Jan 10, 11 and 12, 8am to 6pm each day', ['2027-01-10', '2027-01-11', '2027-01-12']);
  assert.deepEqual(b.got, ['01-10 8-18', '01-11 8-18', '01-12 8-18']);
  assert.deepEqual(b.unparsed, []);
  const c = hours('both days 9-18 except 12-13', three.slice(0, 2));
  assert.deepEqual(c.got, ['11-10 9-12', '11-10 13-18', '11-11 9-12', '11-11 13-18']);
  assert.deepEqual(hours('9-18 except lunch', three).unparsed, ['9-18 except lunch'], 'an exception it can\'t read is refused, not dropped');
  assert.ok(hours('Tue and Wed', three).unparsed.length, 'days with no time are said, not dropped');
});

test('free times: build refuses what it can\'t read, and never saves zero typed slots', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const before = readFileSync(join(H.dir, 'slots.json'), 'utf8');
  assert.match(cli(H, 'slot-finder', ['build', '--event', H.slug, '--free', 'Tue 9-12, Wed banana']).ERROR, /Couldn't read.*"Wed banana".*Nothing was saved/s);
  assert.match(cli(H, 'slot-finder', ['build', '--event', H.slug, '--free', 'Tue 20-22']).ERROR, /No meeting slots.*Nothing was saved/s);
  assert.equal(readFileSync(join(H.dir, 'slots.json'), 'utf8'), before);
  const ok = cli(H, 'slot-finder', ['build', '--event', H.slug, '--free', 'both days 9-18 except 12-13']);
  assert.ok(!ok.ERROR, ok.ERROR);
  const ids = JSON.parse(readFileSync(join(H.dir, 'slots.json'), 'utf8')).slots.map((s) => s.id);
  assert.ok(ids.includes('s20261110T1130') && !ids.includes('s20261110T1200') && !ids.includes('s20261110T1230') && ids.includes('s20261110T1300'), ids.join(' '));
  assert.deepEqual(ok.taken_out, ['2026-11-10, 2026-11-11, 2026-11-12 12:00–13:00']);
});

test('check-these: a reason with ; or , stays one line, and a batch is saved whole or not at all', () => {
  assert.deepEqual(splitDecisionLines('c001 reach because she asked; we met in May, at the fair\nc002 skip; c003 same-person crm:4, c004 different-person'),
    ['c001 reach because she asked; we met in May, at the fair', 'c002 skip', 'c003 same-person crm:4', 'c004 different-person']);
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,Head of things,Acme,ana@acme.test\nBo Li,Head of stuff,Globex,bo@globex.test\n' });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const a = idOf(H, 'Ana Berg'), b = idOf(H, 'Bo Li');
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: a, unsure: true, reason: 'vague title' }, { id: b, unsure: true, reason: 'vague title' }])]);
  const decides = () => ledger(H).filter((e) => e.type === 'decide');
  assert.match(cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${a} reach because she asked; we met\n${b} maybe`]).ERROR, /"c\d+ maybe" isn't a decision.*Nothing was saved/s);
  assert.equal(decides().length, 0, 'one bad line saves nothing');
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${a} reach because she asked; we met in May, at the fair\n${b} skip because not now`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.decided, 2);
  assert.equal(decides().find((e) => e.id === a).because, 'she asked; we met in May, at the fair');
  assert.equal(decides().find((e) => e.id === b).group, 'skip');
});

test('keep N: N is the whole shortlist, must-meet and warm people included', () => {
  const rows = ['Ana Berg', 'Bo Li', 'Cy Ng', 'Di Fox', 'Ed Oak', 'Fay Wu'].map((n, i) => `${n},COO,Co${i},p${i}@co${i}.test`).join('\n');
  const H = setup({ attendees: `Name,Title,Company,Email\n${rows}\n`, settings: { must_meet: ['Ana Berg'] } });
  fitAll(H, cli(H, 'crm-triage', ['load', '--event', H.slug]));
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'warm Bo Li; keep 3']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.equal(g.shortlisted, 3, JSON.stringify(g.left_out));
  assert.equal(g.kept, '3 kept (keep 3)');
  const one = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'keep 1']);
  assert.equal(one.shortlisted, 2, 'the must-meet and the warm pick are never cut');
  assert.match(one.kept, /^1 kept \+ 1 must-meet or chosen by you/);
});

test('fit first: a CRM record never shortlists someone the fit calls off-target; the card says you know them', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nTed Bank,Branch Manager,Acme,ted@acme.test\nMia Ads,Marketing Analyst,Globex,mia@globex.test\nOla Buyer,COO,Initech,ola@initech.test\n',
    crm: 'Name,Email,Company,Owner,Status\nTed Bank,ted@acme.test,Acme,Sam Rivera,Opportunity\nMia Ads,mia@globex.test,Globex,Sam Rivera,Customer\nOla Buyer,ola@initech.test,Initech,Sam Rivera,Opportunity\n',
    settings: { status_map: { Opportunity: 'warm', Customer: 'customer' } },
  });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const ted = idOf(H, 'Ted Bank'), mia = idOf(H, 'Mia Ads'), ola = idOf(H, 'Ola Buyer');
  const v = cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([
    { id: ted, segment: null, reason: 'branch staff, not a buyer' }, { id: mia, segment: null, reason: 'not a buyer' }, { id: ola, segment: 'ops-leaders', reason: 'COO', score: 80 }])]);
  assert.ok(!v.ERROR, v.ERROR);
  assert.deepEqual(v.top.map((x) => x.id), [ola], 'only the one who fits is shortlisted');
  assert.deepEqual(v.known_off_target.people.map((x) => x.id).sort(), [ted, mia].sort());
  assert.match(v.known_off_target.line, /You know them, but they're off-target/);
  assert.ok(v.left_out.some((x) => /you know them, but they're off-target/.test(x.why) && x.count === 2), JSON.stringify(v.left_out));
  // The user's own word still counts: "warm Ted" puts him back.
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'warm Ted Bank']);
  assert.ok(g.top.some((x) => x.id === ted));
});

test('a reach said before the CRM was read never covers a coworker\'s record, an opt-out or a stop note found later', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAl Ade,Chief Digital Officer,Acme,al@acme.test\nBea Cole,Chief Digital Officer,Globex,bea@globex.test\nCal Dunn,Chief Digital Officer,Initech,cal@initech.test\nDot Eng,Chief Digital Officer,Hooli,dot@hooli.test\n' });
  fitAll(H, cli(H, 'crm-triage', ['load', '--event', H.slug]));
  const ids = ['Al Ade', 'Bea Cole', 'Cal Dunn', 'Dot Eng'].map((n) => idOf(H, n));
  // "Chief Digital Officers: reach", before any CRM.
  assert.ok(!cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ids.join(','), '--group', 'reach', '--because', 'Chief Digital Officers: reach']).ERROR);
  const crm = join(H.dir, 'later-crm.csv');
  writeFileSync(crm, 'Name,Email,Company,Owner,Status,Email Opt Out,Notes\nAl Ade,al@acme.test,Acme,Alex Seller,Closed Won,false,\nBea Cole,bea@globex.test,Globex,,Lead,true,\nCal Dunn,cal@initech.test,Initech,,Lead,false,asked us to stop emailing\nDot Eng,dot@hooli.test,Hooli,Sam Rivera,Lead,false,\n');
  const v = cli(H, 'crm-triage', ['load', '--event', H.slug, '--crm', crm]);
  assert.ok(!v.ERROR, v.ERROR);
  const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  assert.equal(r[ids[1]].group, 'skip', r[ids[1]].says);
  assert.equal(r[ids[0]].group, 'colleague', `a coworker's record goes back to the coworker rule: ${r[ids[0]].says}`);
  assert.match(r[ids[0]].says, /Alex Seller.*new since you said reach/);
  assert.equal(r[ids[2]].group, 'skip', r[ids[2]].says);
  assert.equal(r[ids[3]].group, 'reach', 'the user\'s own record: the reach stands');
  const short = JSON.parse(readFileSync(join(H.dir, 'derived', 'shortlist.json'), 'utf8')).ranked;
  assert.ok(!short.includes(ids[0]) && !short.includes(ids[2]), short.join(' '));
  // Said again after seeing the owner, the user's word stands.
  cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ids[0], '--group', 'reach', '--because', 'Alex said I can']);
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.equal(JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[ids[0]].group, 'reach');
});

test('crm_accounts answered: the "wait for your OK" line goes on the next view, for "off" as for "apply"', () => {
  const att = 'Name,Title,Company,Email\nKim Park,COO,Wayne Shipping,kim@wayne.test\n';
  const crm = 'Name,Email,Company,Owner,Status,Last Contact,Unsubscribed\nZed Wu,zed@wayne.test,Wayne Shipping,Pat Teammate,Customer,2026-09-01,false\n';
  const says = (H) => { cli(H, 'crm-triage', ['view', '--event', H.slug]); return JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(H, 'Kim Park')]; };
  const H = setup({ attendees: att, crm });
  triage(H);
  assert.match(says(H).says, /Account rules from the CRM wait for your OK/);
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify({ ...ev, settings: { ...ev.settings, crm_accounts: 'off' } }));
  const off = says(H);
  assert.doesNotMatch(JSON.stringify(off), /wait for your OK/);
  assert.equal(off.group, 'reach', 'off: a colleague\'s records elsewhere at the company don\'t cover her');
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify({ ...ev, settings: { ...ev.settings, crm_accounts: 'apply' } }));
  const on = says(H);
  assert.doesNotMatch(JSON.stringify(on), /wait for your OK/);
  assert.equal(on.group, 'colleague');
});

test('a CRM with no deal fields: "at a customer", and nothing about a won deal', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nIke Else,COO,Acme,ike@acme.test\n', crm: 'Name,Email,Company,Owner,Status\nIke Else,ike@acme.test,Acme,Sam Rivera,Customer\n',
    settings: { status_map: { Customer: 'customer' }, customer_rule: { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' } } });
  const { load } = triage(H);
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const says = v.check_these.find((x) => x.name === 'Ike Else')?.says || '';
  assert.match(says, /^at a customer: contact them\?/, JSON.stringify(v.check_these));
  assert.doesNotMatch(JSON.stringify({ load, v }), /won deal/);
});

test('gate: the wording the question offers is wording the parser takes, with names as well as ids', () => {
  const people = [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }, { id: 'c003', name: 'Zoé Marchetti' }, { id: 'c004', name: 'Dan Ruiz' }];
  const g = parseGate('skip Ana Berg because she left, rejoined a rival; warm Bo, reach c003, Dan Ruiz is my own contact', { kind: 'triage', people });
  assert.deepEqual(g.actions, [
    { verb: 'remove', ids: ['c001'], because: 'she left, rejoined a rival' },
    { verb: 'warm', ids: ['c002'] },
    { verb: 'reach', ids: ['c003'] },
    { verb: 'mine', ids: ['c004'] },
  ]);
  assert.deepEqual(parseGate('hold Zoé until Dana Fox says yes', { kind: 'triage', people }).actions, [{ verb: 'hold', ids: ['c003'], until: 'Dana Fox' }]);
  assert.deepEqual(parseGate('c002 is mine', { kind: 'triage', people }).actions, [{ verb: 'mine', ids: ['c002'] }]);
  assert.throws(() => parseGate('skip Zed because no', { kind: 'triage', people }), /"zed" isn't an ID like c014 or the name/);
  // Every example the card offers parses (placeholders filled in).
  for (const ex of TRIAGE_ANSWERS) {
    const filled = ex.replace(/\s*\([^)]*\)$/, '').replace('<name or id>', 'Bo Li').replace('<id>', 'c002').replace('<why>', 'met already').replace('<owner>', 'Dana').replace('<slug>', 'ops-leaders').replace('<company-slug> <n|all>', 'acme 2');
    assert.doesNotThrow(() => parseGate(filled, { kind: 'triage', people }), filled);
  }
});

test('gate: skip, warm, hold and "is mine" save what they say through the triage CLI', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\nCy Ng,COO,Initech,cy@initech.test\nDee Ho,COO,Hooli,dee@hooli.test\n' });
  fitAll(H, cli(H, 'crm-triage', ['load', '--event', H.slug]));
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'skip Ana Berg because she moved on; warm Bo; hold Cy until Dana says yes; Dee Ho is mine']);
  assert.ok(!g.ERROR, g.ERROR);
  const led = ledger(H);
  const dec = (name) => led.filter((e) => e.type === 'decide' && e.id === idOf(H, name)).pop();
  assert.equal(dec('Ana Berg').group, 'skip');
  assert.equal(dec('Ana Berg').because, 'she moved on');
  assert.equal(dec('Bo Li').group, 'warm');
  assert.equal(dec('Cy Ng').group, 'skip');
  assert.match(dec('Cy Ng').because, /on hold until Dana says yes/);
  assert.equal(dec('Dee Ho').group, 'warm');
  assert.ok(led.some((e) => e.type === 'note' && e.id === idOf(H, 'Dee Ho') && e.known));
  assert.equal(g.answer_with, TRIAGE_ANSWERS.join(' · '));
});
