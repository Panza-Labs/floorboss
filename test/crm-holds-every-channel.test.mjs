// The CRM holds (spec 0.1.7 §7) stop a person on every channel: an email, a note in the event app, and a LinkedIn
// message sent by hand (and its CRM task). For each hold and each channel: no draft is handed out, no card offers a
// send or a copy, nothing is on the send list or the browser send list, and no CRM task is made.
// Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, draftApprove, idOf } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana-berg-test\nBo Free,COO,Freeco,bo@freeco.test,https://www.linkedin.com/in/bo-free-test\n';
const HEAD = 'Name,Email,Company,Owner,Status,Last Contacted,Deal Stage,Unsubscribed\n';
export const HOLDS = {
  dnc: { dnc: 'ana@acme.test\n', crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,false\n', status_map: { Lead: 'ignore' } },
  unsubscribed: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Lead,,,true\n', status_map: { Lead: 'ignore' } },
  customer: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Customer,2026-09-01,,false\n', status_map: { Customer: 'customer' } },
  coworker: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Pat Teammate,Lead,,,false\n', status_map: { Lead: 'ignore' } },
  coworker_open_deal: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Pat Teammate,Prospect,2026-09-20,Open,false\n', status_map: { Prospect: 'ignore' } },
  lost: { crm: HEAD + 'Ana Berg,ana@acme.test,Acme,Sam Rivera,Closed Lost,2026-08-10,,false\n', status_map: { 'Closed Lost': 'lost' }, rejected_months: 6 }
};
export const CHANNELS = ['email', 'app', 'linkedin'];
// The route's step for each channel: 1 email, 2 the event app, 3 LinkedIn by hand.
const TOUCH = { email: 1, app: 2, linkedin: 3 };

export function world(hold) {
  const h = HOLDS[hold];
  const H = setup({
    attendees: LIST,
    crm: h.crm,
    dnc: h.dnc,
    event: { app_name: 'Grip' },
    settings: {
      status_map: h.status_map,
      linkedin_messages: true,
      route: ['email', 'app', 'linkedin', 'email'],
      sending: { channels: ['email', 'app'], followups: 'scheduled' },
      ...(h.rejected_months != null ? { rejected_months: h.rejected_months } : {})
    }
  });
  const t = triage(H);
  assert.ok(!t.load.ERROR, t.load.ERROR);
  return H;
}

const readJ = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
// What reaches Ana on a channel, from drafting to the send lists. Empty when she is held there.
export function reaches(H, channel, name = 'Ana Berg') {
  const id = idOf(H, name);
  const touch = TOUCH[channel];
  const out = [];
  const jobs = todoJobs(H).jobs.filter((j) => j.id === id && j.kind === 'message' && j.touch === touch);
  if (jobs.length) out.push(`a draft is handed out (message ${touch}, ${jobs[0].channel}${jobs[0].routed ? `/${jobs[0].routed}` : ''})`);
  draftApprove(H);
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (led.some((e) => e.type === 'approve' && e.id === id && Number(e.touch) === touch)) out.push('a message is approved');
  const ob = existsSync(join(H.dir, 'outbox.html')) ? readFileSync(join(H.dir, 'outbox.html'), 'utf8') : '';
  if (new RegExp(`data-id="${id}"[^>]*data-touch="${touch}"`).test(ob)) out.push('a card offers it');
  cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  const lists = [...readJ(join(H.dir, 'derived', 'send-list.json'), []), ...readJ(join(H.dir, 'derived', 'browser-send-list.json'), [])];
  if (lists.some((x) => x.id === id && Number(x.touch) === touch)) out.push('it is on a send list');
  cli(H, 'event-outreach', ['task-list', '--event', H.slug]);
  const tasks = readJ(join(H.dir, 'task-list.json'), []);
  if (tasks.some((x) => x.id === id && x.kind === 'send' && Number(x.touch) === touch)) out.push('a CRM task is made');
  return out;
}

for (const ch of CHANNELS)
  test(`control: someone with no hold is reached on ${ch}`, () => {
    assert.ok(reaches(world('dnc'), ch, 'Bo Free').length > 0);
  });

// Hold 1 has no way around it: every way the user can say "reach" or "approve" a person by id or name.
const NEVER = /floorboss does not write to them on any channel/;
const overrides = {
  decide: (H, id) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', id, '--group', 'reach', '--because', 'I know her, write anyway']),
  'decide warm': (H, id) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', id, '--group', 'warm', '--because', 'we met last year']),
  'decide colleague': (H, id) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', id, '--group', 'colleague', '--because', 'give her to Pat']),
  'decide-batch': (H, id) => cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${id} reach because I insist`]),
  'decide-batch group': (H) => cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', 'everyone else: reach']),
  'gate reach': (H) => cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'reach Ana Berg anyway because I insist']),
  'gate rescue': (H) => cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'rescue Ana Berg']),
  'gate mine': (H) => cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'Ana Berg is mine'])
};
for (const hold of ['dnc', 'unsubscribed'])
  for (const [how, say] of Object.entries(overrides))
    test(`${hold}: "${how}" never lets her through, on any channel`, () => {
      const H = world(hold);
      const id = idOf(H, 'Ana Berg');
      const r = say(H, id);
      const text = JSON.stringify(r);
      if (!/group/.test(how)) assert.match(text, NEVER, `the answer says so plainly: ${text.slice(0, 400)}`);
      assert.doesNotMatch(text, /internal|rung|HARD_HOLDS|seen_holds/);
      cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
      assert.deepEqual(reaches(H, 'email'), [], 'email');
      // The app note and the LinkedIn message, before any draft of the first message was approved.
      const jobs = todoJobs(H).jobs.filter((j) => j.id === id && j.kind === 'message');
      assert.deepEqual(jobs.map((j) => [j.touch, j.channel]), []);
    });

test('do-not-contact: the plain answer says what the user can do, and never to edit a file', () => {
  const H = world('dnc');
  const r = JSON.stringify(overrides.decide(H, idOf(H, 'Ana Berg')));
  assert.match(r, /Check your do-not-contact list\. If they really asked to hear from you again, say so in your own words, and floorboss reads it back/);
  assert.doesNotMatch(r, /file|load the list/);
});

// Hold 2: a current customer is held and shown to the user, who decides; their word writes to them.
test('customer: held and shown on check-these; the user\'s own reach for her lets her draft go', () => {
  const H = world('customer');
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const id = idOf(H, 'Ana Berg');
  assert.ok((v.check_these || []).some((x) => x.id === id), JSON.stringify(v.check_these));
  overrides.decide(H, id);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  assert.ok(todoJobs(H).jobs.some((j) => j.id === id && j.kind === 'message'));
});

for (const hold of Object.keys(HOLDS))
  for (const ch of CHANNELS)
    test(`${hold}: held on ${ch}`, () => {
      const H = world(hold);
      assert.deepEqual(reaches(H, ch), []);
    });

// C. An address found later (a people-data tool, or a CSV the user fills in) goes through the same holds before any
// draft is written to it.
const NOMAIL = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana-berg-test\nCal Peer,CFO,Acme,cal@acme.test,\nBo Free,COO,Freeco,bo@freeco.test,https://www.linkedin.com/in/bo-free-test\n';
function foundWorld(hold) {
  const h = HOLDS[hold];
  const H = setup({ attendees: NOMAIL, crm: h.crm, dnc: h.dnc, event: { app_name: 'Grip' },
    settings: { status_map: h.status_map, linkedin_messages: true, route: ['email', 'app', 'linkedin', 'email'], sending: { channels: ['email', 'app'], followups: 'scheduled' }, ...(h.rejected_months != null ? { rejected_months: h.rejected_months } : {}) } });
  assert.ok(!triage(H).load.ERROR);
  const id = idOf(H, 'Ana Berg');
  cli(H, 'crm-triage', ['enrich-list', '--event', H.slug, '--ids', id]);
  const f = join(H.dir, 'found.csv');
  writeFileSync(f, `floorboss_id,full_name,company,email\n${id},Ana Berg,Acme,ana@acme.test\n`);
  const imp = cli(H, 'crm-triage', ['enrich-import', '--event', H.slug, '--file', f]);
  assert.ok(!imp.ERROR && imp.saved !== false, JSON.stringify(imp));
  triage(H);
  return H;
}
test('found address: control, she gets an email once her address is found', () => {
  const H = setup({ attendees: NOMAIL, settings: { route: ['email', 'email'] } });
  triage(H);
  const id = idOf(H, 'Ana Berg');
  const f = join(H.dir, 'found.csv');
  writeFileSync(f, `floorboss_id,full_name,company,email\n${id},Ana Berg,Acme,ana@acme.test\n`);
  assert.ok(!cli(H, 'crm-triage', ['enrich-import', '--event', H.slug, '--file', f]).ERROR);
  triage(H);
  assert.ok(todoJobs(H).jobs.some((j) => j.id === id && j.kind === 'message' && j.channel === 'email'));
});
for (const hold of Object.keys(HOLDS))
  test(`found address: ${hold} holds her before any draft, on every channel`, () => {
    const H = foundWorld(hold);
    const id = idOf(H, 'Ana Berg');
    assert.deepEqual(todoJobs(H).jobs.filter((j) => j.id === id && j.kind === 'message').map((j) => [j.touch, j.channel]), []);
  });

// D. The same person at the user's second event: a hold the CRM gave at the first holds at the second, which has no
// CRM of its own.
// Only hold 1 carries across events: a customer, a coworker's record, an open deal or a lost deal is read from the CRM
// each event is given, which says what is true then (spec 0.1.7 §7b: "not carried").
const CARRIED = new Set(['dnc', 'unsubscribed']);
for (const hold of Object.keys(HOLDS))
  test(`second event: ${hold} at the first event ${CARRIED.has(hold) ? 'holds' : 'does not hold'} her at the second`, () => {
    const E1 = world(hold);
    const E2 = setup({ home: E1.HOME, attendees: LIST, event: { slug: 'ev2', name: 'Second Expo', app_name: 'Grip' },
      settings: { linkedin_messages: true, route: ['email', 'app', 'linkedin', 'email'], sending: { channels: ['email', 'app'], followups: 'scheduled' } } });
    assert.ok(!triage(E2).load.ERROR);
    const id = idOf(E2, 'Ana Berg');
    const jobs = todoJobs(E2).jobs.filter((j) => j.id === id && j.kind === 'message').map((j) => [j.touch, j.channel]);
    if (CARRIED.has(hold)) assert.deepEqual(jobs, []);
    else assert.ok(jobs.length > 0, 'not carried');
  });

// F7: an open deal the user owns (or with no owner) gets a warm draft on every channel, marked on the approval screen.
import { dealMark } from '../skills/flow/scripts/review.mjs';
for (const [name, owner] of [['the user owns', 'Sam Rivera'], ['with no owner', '']])
  test(`open deal ${name}: a warm draft on every channel, with the mark "you have an open deal with them"`, () => {
    HOLDS.mine = { crm: HEAD + `Ana Berg,ana@acme.test,Acme,${owner},Prospect,2026-09-20,Open,false\n`, status_map: { Prospect: 'ignore' } };
    const H = world('mine');
    delete HOLDS.mine;
    const id = idOf(H, 'Ana Berg');
    const r = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[id];
    assert.equal(r.group, 'warm', JSON.stringify(r).slice(0, 200));
    assert.equal(dealMark(r), 'you have an open deal with them');
    const jobs = todoJobs(H).jobs.filter((j) => j.id === id && j.kind === 'message').map((j) => j.touch);
    assert.deepEqual(jobs.slice(0, 3), [1, 2, 3]);
  });
