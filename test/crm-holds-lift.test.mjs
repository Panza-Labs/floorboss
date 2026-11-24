// Hold 1 (do-not-contact, opt-out) stays until the user lifts it in their own words through one read-back step: a file
// or a column going away never lifts it, nor does a plain reach. It carries to the user's other events, matched as
// inside one event, and a lift at the source event lifts it there too. Customers, coworkers' records, open and lost
// deals do not carry (spec 0.1.7 §7b). Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';

const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted,Deal Stage,Unsubscribed,Notes\n';
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Free,COO,Freeco,bo@freeco.test\n';
const HOLDS = {
  dnc: { dnc: 'ana@acme.test\n', crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false,\n' },
  unsubscribed: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,true,\n' },
  note: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false,please remove me from all emails\n' },
  customer: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,2026-09-01,,false,\n' },
  coworker: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Pat Teammate,Lead,,,false,\n' },
  open_deal: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Pat Teammate,Prospect,2026-09-20,Open,false,\n' },
  lost: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,2026-08-10,,false,\n' }
};
const MAP = { Lead: 'ignore', Customer: 'customer', Prospect: 'ignore', 'Closed Lost': 'lost' };
function mk(hold, { attendees = LIST, dnc, crm, home, event = {} } = {}) {
  const h = HOLDS[hold];
  const H = setup({ attendees, home, crm: crm === undefined ? h.crm : crm, dnc: dnc === undefined ? h.dnc : dnc, event, settings: { status_map: MAP, rejected_months: 6, route: ['email', 'email'] } });
  assert.ok(!triage(H).load.ERROR);
  return H;
}
const second = (E1, attendees = LIST) => {
  const H = setup({ home: E1.HOME, attendees, event: { slug: 'ev2', name: 'Second Expo' }, settings: { route: ['email', 'email'] } });
  assert.ok(!triage(H).load.ERROR);
  return H;
};
const put = (H, name, text) => { mkdirSync(join(H.dir, 'work'), { recursive: true }); const p = join(H.dir, 'work', name); writeFileSync(p, text); return p; };
const reach = (H, id) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', id, '--group', 'reach', '--because', 'write to her anyway']);
const drafts = (H, name = 'Ana Berg') => {
  triage(H);
  return todoJobs(H).jobs.filter((j) => j.id === idOf(H, name) && j.kind === 'message').length;
};
const lift = (H, id) => {
  const ask = cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id]);
  return { ask, yes: cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id, '--answer', '1', '--said', 'she wrote to say she wants to hear from us again']) };
};

// F1: a hold seen once stays when its file or column goes.
const gone = {
  'the do-not-contact file deleted': (H) => { rmSync(join(H.dir, 'dnc.txt')); if (existsSync(join(H.dir, 'inputs', 'dnc.txt'))) rmSync(join(H.dir, 'inputs', 'dnc.txt')); },
  'a new do-not-contact file without her': (H) => cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'dnc', '--file', put(H, 'd2.txt', 'nobody@else.test\n')]),
  'a CRM export without the opt-out column': (H) => {
    cli(H, 'crm-triage', ['inputs', '--event', H.slug, '--kind', 'crm', '--file', put(H, 'crm2.csv', 'Name,Email,Company,Owner,Status\nAna Berg,ana@acme.test,Acme,Sam Rivera,Lead\n')]);
    cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
    cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm']);
  }
};
for (const [how, change] of Object.entries(gone))
  test(`F1: ${how} never lifts the hold, and a plain reach is refused`, () => {
    const H = mk(how.includes('CRM') ? 'unsubscribed' : 'dnc');
    const id = idOf(H, 'Ana Berg');
    change(H);
    const l = cli(H, 'crm-triage', ['load', '--event', H.slug]);
    assert.match(JSON.stringify(l.warnings || []), /Ana Berg is no longer in the file that held them.*still holds them/, JSON.stringify(l).slice(0, 600));
    const r = reach(H, id);
    assert.ok(r.ERROR, JSON.stringify(r).slice(0, 300));
    assert.doesNotMatch(r.ERROR, /file|load the list|c\d{3}/, 'never tells the model to edit files, and no ids');
    assert.match(r.ERROR, how.includes('CRM') ? /Check their record in your CRM\. If they really asked/ : /Check your do-not-contact list\. If they really asked/);
    assert.equal(drafts(H), 0);
  });

test('F1: the read-back names her and where she was held; only "1" with the user\'s words lifts it', () => {
  const H = mk('dnc');
  const id = idOf(H, 'Ana Berg');
  assert.match(cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id, '--answer', '1', '--said', 'she asked']).ERROR, /Ask the user first/);
  const ask = cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', 'Ana Berg']);
  assert.equal(ask.ask, 'Ana Berg is on your do-not-contact list (since Mon 12 Oct). Take Ana Berg off it in floorboss?');
  assert.deepEqual(ask.options, ['1. Yes, Ana Berg asked to hear from us again.', '2. No.']);
  assert.equal(cli(H, 'crm-triage', ['lift-hold', '--event', H.slug, '--id', id, '--answer', '2', '--said', 'no']).says, 'Ana Berg stays held.');
  assert.equal(drafts(H), 0);
  const { yes } = lift(H, id);
  assert.equal(yes.lifted, 1, JSON.stringify(yes));
  assert.equal(yes.says, 'Ana Berg is off the hold in floorboss. Your do-not-contact list is unchanged: take them off it there too if it is wrong.');
  assert.equal(drafts(H), 1, 'the list still names her, but her lift stands');
});

test('F1: after a file drops her, the read-back still lifts her', () => {
  const H = mk('dnc');
  const id = idOf(H, 'Ana Berg');
  gone['a new do-not-contact file without her'](H);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  lift(H, id);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.equal(drafts(H), 1);
});

// F3: the carry matches as inside one event.
for (const [name, at1, at2, dnc] of [
  ['a plus tag', 'ana@acme.test', 'ana+expo@acme.test'],
  ['Gmail dots', 'anaberg.example@gmail.com', 'a.na.berg.example@gmail.com', 'anaberg.example@gmail.com\n'],
  ['googlemail.com', 'anaberg.example@gmail.com', 'anaberg.example@googlemail.com', 'anaberg.example@gmail.com\n'],
  ['another address, same name and company', 'ana@acme.test', 'ana.berg@personal.test'],
  ['a name-only entry', 'ana@acme.test', 'ana.b@acme.test', 'Ana Berg\n']
])
  test(`F3: a do-not-contact hold carries to the next event by ${name}`, () => {
    const E1 = mk('dnc', { attendees: LIST.replace('ana@acme.test', at1), dnc: dnc || HOLDS.dnc.dnc, crm: null });
    const H = second(E1, LIST.replace('ana@acme.test', at2));
    assert.equal(drafts(H), 0);
  });

// F5: a lift at the source event lifts the carried hold.
test('F5: lifted at the first event, she is not held at the second', () => {
  const E1 = mk('dnc', { crm: null });
  lift(E1, idOf(E1, 'Ana Berg'));
  const H = second(E1);
  assert.equal(drafts(H), 1);
  assert.doesNotMatch(JSON.stringify(JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))), /until you release them/);
});

// Words.
test('words: the refusal says the real source, once, with no id', () => {
  for (const [hold, want] of [['unsubscribed', /Ana Berg is held: opted out in your CRM\./], ['note', /Ana Berg is held: a note in your CRM says: "please remove me from all emails"\./], ['dnc', /Ana Berg is held: on your do-not-contact list\./]]) {
    const H = mk(hold);
    const e = reach(H, idOf(H, 'Ana Berg')).ERROR;
    assert.match(e, want, e);
    assert.equal((e.match(/do-not-contact list/g) || []).length, hold === 'dnc' ? 2 : 0, e); // the source once, then "Check your do-not-contact list"
    assert.doesNotMatch(e, /new since you said/);
  }
});

test('words: a carried reason gets one suffix, however many events it passed through', () => {
  const E1 = mk('dnc', { crm: null });
  const E2 = second(E1);
  const E3 = setup({ home: E1.HOME, attendees: LIST, event: { slug: 'ev3', name: 'Third Expo' }, settings: { route: ['email', 'email'] } });
  triage(E3);
  triage(E2);
  const says = JSON.parse(readFileSync(join(E3.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(E3, 'Ana Berg')].says;
  assert.equal((says.match(/at your event/g) || []).length, 1, says);
});

test('words: "added" for someone held says she is held and why; a held reason never says "new since you said"', () => {
  const H = mk('dnc');
  const f = put(H, 'rec.json', JSON.stringify({ items: [{ who: 'Ana Berg', what: 'added' }] }));
  const r = cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', f]);
  assert.doesNotMatch(JSON.stringify(r), /added to the shortlist/, JSON.stringify(r));
  assert.match(JSON.stringify(r), /Ana Berg \(Acme\) is held \(on your do-not-contact list/);
  const says = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[idOf(H, 'Ana Berg')].says;
  assert.doesNotMatch(says, /new since you said/);
});

// §7b: only hold 1 carries.
for (const hold of ['customer', 'coworker', 'open_deal', 'lost'])
  test(`not carried: a ${hold} hold at the first event does not hold her at the second (its CRM says what is true there)`, () => {
    const H = second(mk(hold));
    assert.equal(drafts(H), 1);
  });

// §7b: a customer rule from setup stays the user's choice; the approval screen says how many go to customers.
import { customerApproval } from '../skills/flow/scripts/steps/approval.mjs';
test('customer rule: the approval screen adds one line counting the customers, and names how to review them', () => {
  const H = setup({ attendees: LIST + 'Cy Ng,CFO,Initech,cy@initech.test\n', crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,2026-09-01,,false,\nCy Ng,cy@initech.test,Initech,Sam Rivera,Customer,2026-09-01,,false,\n',
    settings: { status_map: MAP, customer_rule: { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' }, route: ['email', 'email'] } });
  triage(H);
  const jobs = todoJobs(H).jobs.filter((j) => j.kind === 'message');
  assert.ok(jobs.some((j) => j.id === idOf(H, 'Ana Berg')), 'the rule lets customers through');
  const resolved = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'));
  const r = customerApproval(jobs, resolved);
  assert.equal(r.customerLine, "2 of these go to your customers. You can ask to review each of them before anything goes: say 'show me the customer messages'.");
  assert.deepEqual([...new Set(r.customerJobs.map((j) => j.id))].sort(), [idOf(H, 'Ana Berg'), idOf(H, 'Cy Ng')].sort());
  assert.equal(customerApproval(jobs.filter((j) => j.id === idOf(H, 'Bo Free')), resolved).customerLine, null, 'no customers, no line');
});

// F4: only a clear stop in a CRM note is hold 1; a limited or mixed note goes to the user, quoted.
const noteWorld = (note) => mk('note', { crm: HEAD + `Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false,${note}\n` });
for (const note of ['do not call, email is fine', 'unsubscribed from the newsletter but asked for a demo', 'kein newsletter', 'no cold calls'])
  test(`F4: the note "${note}" holds her for the user's decision, and her reach counts`, () => {
    const H = noteWorld(note.includes(',') ? `"${note}"` : note);
    const id = idOf(H, 'Ana Berg');
    const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[id];
    assert.equal(r.group, 'check', JSON.stringify(r).slice(0, 300));
    assert.match(r.says, new RegExp(`a note in your CRM: "${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    const d = reach(H, id);
    assert.ok(!d.ERROR, d.ERROR);
    assert.equal(drafts(H), 1);
  });
for (const note of ['do not email', 'do not contact', 'unsubscribe from everything', 'unsubscribed', 'stop', 'remove me', 'no more emails', 'bitte keine E-Mails mehr'])
  test(`F4: the note "${note}" is hold 1`, () => {
    const H = noteWorld(note);
    const id = idOf(H, 'Ana Berg');
    assert.match(reach(H, id).ERROR || '', /a note in your CRM says/);
    assert.equal(drafts(H), 0);
  });

// F6: a group answer covering held customers asks once for the whole group before they are drafted.
const CUST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\nCy Ng,COO,Initech,cy@initech.test\nDee Fox,COO,Freeco,dee@freeco.test\n';
const custWorld = () => mk('customer', { attendees: CUST, crm: HEAD + ['Ana Berg,ana@acme.test,Acme', 'Bo Li,bo@globex.test,Globex', 'Cy Ng,cy@initech.test,Initech'].map((x) => `${x},Sam Rivera,Customer,2026-09-01,,false,\n`).join('') });
const batch = (H, text) => cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', text]);
const customersAnswer = (H, a) => cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--customers', a]);
const drafted = (H) => { triage(H); return new Set(todoJobs(H).jobs.filter((j) => j.kind === 'message').map((j) => j.contact.name)); };
for (const [line, names] of [['everyone else: reach', ['Ana Berg', 'Bo Li', 'Cy Ng']], ['all at Acme: reach', ['Ana Berg']], ['everyone else: warm', ['Ana Berg', 'Bo Li', 'Cy Ng']]])
  test(`F6: "${line}" asks once about the customers it covers, then "1" includes them`, () => {
    const H = custWorld();
    const r = batch(H, line);
    assert.ok(!r.ERROR, r.ERROR);
    const want = `This includes ${names.length} of your customers: ${names.map((n) => `${n} (${{ 'Ana Berg': 'Acme', 'Bo Li': 'Globex', 'Cy Ng': 'Initech' }[n]})`).join(', ')}. 1. Include them. 2. Leave them out. 3. Pick: name the ones to include.`;
    assert.equal(r.customers_ask, want);
    for (const n of names) assert.ok(!drafted(H).has(n), `${n} waits for the read-back`);
    assert.ok(drafted(H).has('Dee Fox'), 'someone who is not a customer goes on at once');
    const a = customersAnswer(H, '1');
    assert.ok(!a.ERROR, a.ERROR);
    const d = drafted(H);
    for (const n of names) assert.ok(d.has(n), n);
  });
test('F6: "2" leaves the customers out', () => {
  const H = custWorld();
  batch(H, 'everyone else: reach');
  customersAnswer(H, '2');
  const d = drafted(H);
  for (const n of ['Ana Berg', 'Bo Li', 'Cy Ng']) assert.ok(!d.has(n), n);
});
test('F6: "3" with names includes only those named', () => {
  const H = custWorld();
  batch(H, 'everyone else: reach');
  const a = customersAnswer(H, '3 Ana Berg, Cy Ng');
  assert.deepEqual(a.included.sort(), ['Ana Berg', 'Cy Ng']);
  const d = drafted(H);
  assert.ok(d.has('Ana Berg') && d.has('Cy Ng') && !d.has('Bo Li'));
});

// F8: a gate "reach" for a lost deal inside the wait is read back once; a group answer never lifts it.
test('F8: "reach Ana Berg" for a lost deal is read back; 1 lifts it for this event, 2 keeps her held', () => {
  for (const [ans, want] of [['1', 1], ['2', 0]]) {
    const H = mk('lost');
    const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Ana Berg']);
    assert.equal(g.say_to_user, "Ana's deal was lost 2 months ago; your wait is 6 months. Write to them anyway? 1. Yes. 2. No.", JSON.stringify(g));
    assert.ok(!/"type":"decide"/.test(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')), 'nothing counts before the answer');
    const a = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', ans]);
    assert.ok(!a.ERROR, a.ERROR);
    assert.equal(drafts(H), want, ans);
    if (ans === '1') assert.match(readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8'), /"type":"decide"[^\n]*"said":"[^"]*reach Ana Berg/);
  }
});
test('F8: a group answer does not lift a lost-deal wait, and names her', () => {
  const H = mk('lost', { attendees: LIST + 'Dee Fox,Head of things,Freeco2,dee@freeco2.test\n' });
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: idOf(H, 'Dee Fox'), unsure: true, reason: 'vague' }])]);
  const r = batch(H, 'everyone else: reach');
  assert.match(r.tell_user || '', /Ana Berg is still waiting after a lost deal, so this answer leaves them out\./, JSON.stringify(r).slice(0, 400));
  assert.equal(drafts(H), 0);
});
