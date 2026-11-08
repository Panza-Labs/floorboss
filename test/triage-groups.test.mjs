// Triage: keep N, check-these in groups, the coworker list, times before free time, fit for people with no
// email, and account rules for coworkers' deals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, idOf } from './fixtures/harness.mjs';
import { splitDecisionLines, parseDecisionLines, matchGroups } from '../skills/crm-triage/scripts/decisions.mjs';

const ledger = (H) => readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const fits = (H, list) => { const r = cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify(list)]); assert.ok(!r.ERROR, r.ERROR); return r; };

test('keep N: people you know rank above strangers you said reach on check-these, and a cut is named', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nCara Cust,COO,Acme,cara@acme.test\nOli Opp,COO,Globex,oli@globex.test\nSid Sql,COO,Initech,sid@initech.test\n'
      + 'Ann One,Head of things,S1,ann@s1.test\nBen Two,Head of things,S2,ben@s2.test\nCat Three,Head of things,S3,cat@s3.test\nDan Four,Head of things,S4,dan@s4.test\n',
    crm: 'Name,Email,Company,Owner,Status\nCara Cust,cara@acme.test,Acme,Sam Rivera,Customer\nOli Opp,oli@globex.test,Globex,Sam Rivera,Opportunity\nSid Sql,sid@initech.test,Initech,Sam Rivera,SQL\n',
    settings: { status_map: { Customer: 'customer', Opportunity: 'warm', SQL: 'ignore' } },
  });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const known = ['Cara Cust', 'Oli Opp', 'Sid Sql'].map((n) => idOf(H, n)), strangers = ['Ann One', 'Ben Two', 'Cat Three', 'Dan Four'].map((n) => idOf(H, n));
  fits(H, [...known.map((id) => ({ id, segment: 'ops-leaders', reason: 'COO', score: 60 })), ...strangers.map((id) => ({ id, unsure: true, reason: 'vague title', score: 95 }))]);
  const b = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', strangers.map((id) => `${id} reach because worth a try`).join('\n')]);
  assert.ok(!b.ERROR, b.ERROR);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'keep 3']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.deepEqual(g.top.map((x) => x.id).sort(), [...known].sort(), `the three you know stay: ${JSON.stringify(g.top.map((x) => x.name))}`);
  // Cutting someone the user set to reach by name on check-these is never silent: the card names them.
  assert.equal(g.kept, '3 kept (keep 3); cut 4 you said to reach on check-these: Ann One (S1), Ben Two (S2), Cat Three (S3), Dan Four (S4); say rescue <name> to keep them');
  const two = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'keep 2']);
  assert.equal(two.shortlisted, 2);
  assert.match(two.kept, /^2 kept \(keep 2\); cut 1 you know: Sid Sql \(Initech\); say rescue <name> to keep them; cut 4 you said to reach on check-these: Ann One/);
  // A pick at the gate still pins: "rescue" puts Sid back and keeps N whole.
  const back = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'rescue Sid Sql']);
  assert.ok(back.top.some((x) => x.name === 'Sid Sql'));
  assert.equal(back.shortlisted, 2);
});

test('check-these: group lines by title, company and "everyone else"; a line of their own wins', () => {
  assert.deepEqual(splitDecisionLines('all Chief Risk Officer: reach; all intern: skip because not buyers, c004 warm\neveryone else: skip'),
    ['all Chief Risk Officer: reach', 'all intern: skip because not buyers', 'c004 warm', 'everyone else: skip']);
  const p = parseDecisionLines('all at Big Bank: warm because old friends\nall intern: skip because not buyers; everyone else: reach');
  assert.deepEqual(p.map((x) => [x.scope, x.group, x.because]), [[{ company: 'Big Bank' }, 'warm', 'old friends'], [{ title: 'intern' }, 'skip', 'not buyers'], [{ rest: true }, 'reach', null]]);
  assert.throws(() => parseDecisionLines('all intern: same-person'), /isn't a decision.*one line per group/s);
  const people = [{ id: 'c001', title: 'Summer Interns', company_key: 'x' }, { id: 'c002', title: 'Internal Audit Lead', company_key: 'x' }, { id: 'c003', title: 'Intern', company_key: 'x' }];
  assert.deepEqual(matchGroups(parseDecisionLines('all intern: skip'), people, new Set(['c003']))[0].ids, ['c001'], 'whole words, a plural allowed; a line of their own is taken first');

  const H = setup({ attendees: 'Name,Title,Company,Email\nAl Ade,Chief Risk Officer,Acme,al@acme.test\nBea Cole,Chief Risk Officer,Globex,bea@globex.test\nCal Dunn,Intern,Initech,cal@initech.test\n'
    + 'Dot Eng,Intern,Hooli,dot@hooli.test\nEve Fox,Head of things,Umbrella,eve@umbrella.test\nFin Gale,Head of stuff,Umbrella,fin@umbrella.test\nGus Hart,Head of it,Wonka,gus@wonka.test\n' });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const id = (n) => idOf(H, n);
  fits(H, ['Al Ade', 'Bea Cole', 'Cal Dunn', 'Dot Eng', 'Eve Fox', 'Fin Gale', 'Gus Hart'].map((n) => ({ id: id(n), unsure: true, reason: 'vague title' })));
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `all Chief Risk Officer: reach\nall intern: skip because not buyers\n${id('Dot Eng')} warm because we met\nall at umbrella: reach\neveryone else: skip`]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.decided, 7);
  assert.deepEqual(r.groups.map((g) => [g.line, g.matched]), [['all Chief Risk Officer: reach', 2], ['all intern: skip because not buyers', 1], ['all at umbrella: reach', 2], ['everyone else: skip', 1]]);
  const dec = (n) => ledger(H).filter((e) => e.type === 'decide' && e.id === id(n)).pop();
  assert.equal(dec('Dot Eng').group, 'warm', 'a line of their own beats "all intern"');
  assert.equal(dec('Cal Dunn').because, 'not buyers');
  assert.equal(dec('Gus Hart').group, 'skip');
  assert.ok(dec('Al Ade').answered_check && dec('Eve Fox').group === 'reach');
  assert.equal(r.check_these.length, 0);
});

test('check-these: a group reach never covers someone a coworker holds', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAl Ade,Chief Risk Officer,Acme,al@acme.test\nBea Cole,Chief Risk Officer,Globex,bea@globex.test\n',
    crm: 'Name,Email,Company,Owner,Status\nBea Cole,bea@globex.test,Globex,Pat Teammate,Lead\n', settings: { coworker_contacts: 'ask', status_map: { Lead: 'ignore' } } });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const al = idOf(H, 'Al Ade'), bea = idOf(H, 'Bea Cole');
  fits(H, [{ id: al, unsure: true, reason: 'vague' }, { id: bea, segment: 'ops-leaders', reason: 'risk lead', score: 70 }]);
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.ok(v.check_these.some((x) => x.id === bea), JSON.stringify(v.check_these));
  assert.match(v.check_these_answer, /all <words in their title>: reach\|warm\|skip.*all at <company>.*everyone else/);
  const r = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', 'all Chief Risk Officer: reach']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.groups[0].matched, 2);
  assert.equal(r.groups[0].decided, 1);
  assert.deepEqual(r.groups[0].held_back.map((x) => x.id), [bea]);
  assert.deepEqual(r.still_unsettled, [bea]);
  assert.ok(!ledger(H).some((e) => e.type === 'decide' && e.id === bea));
});

test('the coworker list has only on-target people; the rest are plainly left out', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\nMo Mark,Marketing Manager,Globex,mo@globex.test\nFay Fac,Facilities Lead,Initech,fay@initech.test\n',
    crm: 'Name,Email,Company,Owner,Status\nOla Ops,ola@acme.test,Acme,Pat Teammate,Lead\nMo Mark,mo@globex.test,Globex,Pat Teammate,Lead\nFay Fac,fay@initech.test,Initech,Pat Teammate,Lead\n', settings: { status_map: { Lead: 'ignore' } } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.equal(load.colleague.length, 3);
  const v = fits(H, [{ id: idOf(H, 'Ola Ops'), segment: 'ops-leaders', reason: 'COO', score: 80 }, { id: idOf(H, 'Mo Mark'), segment: null, reason: 'marketing' }, { id: idOf(H, 'Fay Fac'), segment: null, reason: 'facilities' }]);
  // Colleague notes are off by default: the on-target coworker's contact is left to them, and the card says so.
  assert.equal(v.colleague_notes, 0);
  assert.ok(v.left_out.some((x) => /left to them, and no note is drafted/.test(x.why)), JSON.stringify(v.left_out));
  assert.deepEqual(JSON.parse(readFileSync(join(H.dir, 'derived', 'shortlist.json'), 'utf8')).coordinate, [idOf(H, 'Ola Ops')]);
  assert.ok(v.left_out.some((x) => x.why === "doesn't fit a segment" && x.count === 2), JSON.stringify(v.left_out));
});

test('before free time is given, the card says times come then, not that they ran out', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\nBo Li,COO,Globex,bo@globex.test\n' });
  writeFileSync(join(H.dir, 'slots.json'), JSON.stringify({ slots: [] }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const v = fits(H, load.needs_fit.map((x) => ({ id: x.id, segment: 'ops-leaders', reason: 'COO', score: 80 })));
  assert.equal(v.open_ask, 2);
  assert.doesNotMatch(v.open_ask_note, /ran out/);
  assert.match(v.open_ask_note, /once you give your free time/);
  assert.doesNotMatch(cli(H, 'crm-triage', ['plan', '--event', H.slug]).no_times, /ran out/);
});

test('no email: fit is judged like anyone\'s; a student who doesn\'t fit is "not a fit", not "fits, but no email"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nStu Dent,Student,Uni,\nIvy Vest,Investor,Fund,\nOla Ops,COO,Acme,\nBo Li,COO,Globex,bo@globex.test\n', settings: { channels: ['email'] } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.deepEqual(load.needs_fit.map((x) => x.name).sort(), ['Bo Li', 'Ivy Vest', 'Ola Ops', 'Stu Dent'], 'people with no email are judged too');
  const v = fits(H, [{ id: idOf(H, 'Stu Dent'), segment: null, reason: 'student' }, { id: idOf(H, 'Ivy Vest'), segment: null, reason: 'investor' },
    { id: idOf(H, 'Ola Ops'), segment: 'ops-leaders', reason: 'COO', score: 80 }, { id: idOf(H, 'Bo Li'), segment: 'ops-leaders', reason: 'COO', score: 80 }]);
  const why = Object.fromEntries(v.left_out.map((x) => [x.why, x.e_g.map((s) => s.replace(/^c\d+ /, '').replace(/ \(.*$/, ''))]));
  assert.deepEqual(why['fits, but no email address'], ['Ola Ops'], JSON.stringify(v.left_out));
  assert.deepEqual(why["doesn't fit a segment"].sort(), ['Ivy Vest', 'Stu Dent']);
});

test('crm_accounts apply: a coworker\'s active record or deal at a company holds everyone there; a hold "until <owner>" holds the company', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nChen Nakamura,COO,Urbane Goods,chen@urbanegoods.test\nTheo Nakamura,COO,Little Grocers,theo@littlegrocers.test\nRafael Vogel,COO,Vogel Foods,rafael@vogelfoods.test\n'
      + 'Ada Ash,COO,Hold Co,ada@holdco.test\nBob Birch,COO,Hold Co,bob@holdco.test\nCy Cedar,COO,Hold Co,cy@holdco.test\nDee Free,COO,Free Co,dee@freeco.test\n',
    crm: 'Name,Email,Company,Owner,Status\nUma One,uma@urbanegoods.test,Urbane Goods,Sam Rivera,Opportunity\nUlf Two,ulf@urbanegoods.test,Urbane Goods,Sam Rivera,Opportunity\nUte Deal,ute@urbanegoods.test,Urbane Goods,Raj Patel,Negotiation\n'
      + 'Lia Prospect,lia@littlegrocers.test,Little Grocers,Raj Patel,Prospecting\nRafael Vogel,rafael@vogelfoods.test,Vogel Foods,Sam Rivera,Opportunity\nVic Won,vic@vogelfoods.test,Vogel Foods,Di Park,Closed Won\n',
    settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Raj Patel', 'Di Park'], status_map: { Lead: 'ignore', Negotiation: 'warm', Prospecting: 'ignore', 'Closed Won': 'customer', Opportunity: 'warm' } },
  });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  fits(H, load.needs_fit.map((x) => ({ id: x.id, segment: 'ops-leaders', reason: 'COO', score: 80 })));
  const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  const r = res();
  for (const [n, who] of [['Chen Nakamura', /Raj Patel.*Negotiation/], ['Theo Nakamura', /Raj Patel/]]) {
    assert.equal(r[idOf(H, n)].group, 'colleague', `${n}: ${r[idOf(H, n)].says}`);
    assert.match(r[idOf(H, n)].says, who);
  }
  // Rafael's own record is the user's open deal: he stays theirs, with Di's won deal there as a heads-up.
  assert.notEqual(r[idOf(H, 'Rafael Vogel')].group, 'colleague', r[idOf(H, 'Rafael Vogel')].says);
  assert.match(r[idOf(H, 'Rafael Vogel')].coworker_also || '', /Di Park/, JSON.stringify(r[idOf(H, 'Rafael Vogel')]));
  // Two held until Raj says yes, with a cap of 2 at Hold Co: Cy never backfills their places.
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'cap hold-co 2; hold Ada Ash until Raj says yes; hold Bob Birch until Raj says yes']);
  assert.ok(!g.ERROR, g.ERROR);
  const short = JSON.parse(readFileSync(join(H.dir, 'derived', 'shortlist.json'), 'utf8')).ranked;
  assert.deepEqual(short.sort(), [idOf(H, 'Dee Free'), idOf(H, 'Rafael Vogel')].sort(), JSON.stringify(g.left_out));
  assert.match(res()[idOf(H, 'Cy Cedar')].says, /Hold Co is on hold until Raj says yes/);
  // The user's own word for one person there still counts.
  const back = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Cy Cedar']);
  assert.ok(back.top.some((x) => x.name === 'Cy Cedar'));
});

test('the user\'s own customer stays theirs when a coworker also has a deal there; their cold contacts held for it are named on the card', () => {
  const H = setup({
    attendees: 'Name,Title,Company,Email\nGoran Ach,Director of AML,Granmere Pay,goran@granmerepay.test\nKavya Del,Head of Payments Risk,Silverline Pay,kavya@silverline.test\n',
    crm: 'Name,Email,Company,Owner,Status\nGoran Ach,goran@granmerepay.test,Granmere Pay,Sam Rivera,Customer\nBea Bsa,bea@granmerepay.test,Granmere Pay,Priya Raman,Customer\nKavya Del,kavya@silverline.test,Silverline Pay,Sam Rivera,Lead\nRon Rec,ron@silverline.test,Silverline Pay,Dan Whitfield,Opportunity\n',
    settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Priya Raman', 'Dan Whitfield'], status_map: { Customer: 'customer', Lead: 'ignore', Opportunity: 'warm' } },
  });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const v = fits(H, load.needs_fit.map((x) => ({ id: x.id, segment: 'ops-leaders', reason: 'risk', score: 80 })));
  const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  assert.notEqual(r[idOf(H, 'Goran Ach')].group, 'colleague', r[idOf(H, 'Goran Ach')].says);
  assert.equal(r[idOf(H, 'Kavya Del')].group, 'colleague', r[idOf(H, 'Kavya Del')].says);
  assert.equal(v.own_held?.count, 1, JSON.stringify(v.own_held));
  assert.match(v.own_held.line, /YOUR OWN/);
  assert.equal(v.held_for_coworkers?.['Dan Whitfield'], 1, JSON.stringify(v.held_for_coworkers));
});
