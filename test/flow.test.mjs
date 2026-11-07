// The flow: one step at a time, from an empty home to done, with every answer saved by `answer`. The driver
// plays a plain seller with the mock event's context and an attendee list of two people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, cli, ROOT } from './sims/lib/driver.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';

test('flow: an empty home walks to done, asking each question once and saving every answer where it belongs', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  const persona = simplePersona({ asks: { attendee_list: join(H.HOME, 'inputs', 'attendees.csv') } });
  const { trail, slug } = drive(H, persona);
  assert.equal(trail[0], 'disclaimer');
  assert.equal(trail[1], 'scan');
  assert.ok(trail.includes('onboarding:event') && trail.includes('onboarding:customers') && trail.includes('onboarding:free_time'), trail.join(' '));
  // Mechanical steps (mapping proposals, load, todo, batch_check) run inside flow next and no longer show here.
  for (const s of ['attendee_list', 'map_columns_attendees', 'fit', 'gate', 'research', 'draft', 'critic', 'approve', 'done']) assert.ok(trail.includes(s), `missing step ${s}: ${trail.join(' ')}`);
  assert.equal(new Set(trail.filter((s) => s.startsWith('onboarding:'))).size, trail.filter((s) => s.startsWith('onboarding:')).length, 'no onboarding question is asked twice');
  // Every answer landed where the code expects it, not where Claude guessed.
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  assert.equal(cfg.disclaimer_ack, true);
  // The goal is this event's (in its own settings); the rest is the user's setup, reused for the next event.
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'events', slug, 'event.json'), 'utf8')).settings.goal, 'ops leaders at 3PLs');
  assert.equal(cfg.goal, undefined);
  assert.deepEqual(['ops leaders at 3PLs', cfg.home_tz, cfg.own_company, cfg.crm_user_name, cfg.drafting_mode, cfg.languages], ['ops leaders at 3PLs', 'Europe/Amsterdam', 'Lanecraft', 'Sam Rivera', 'floorboss', ['English']]);
  assert.deepEqual(cfg.customer_rule, { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' });
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(ob.answers.works_alone, true);
  assert.equal(ob.answers.crm_choice, 'spreadsheet');
  const ev = join(H.HOME, 'events', slug);
  const st = fold(readLedger(join(ev, 'ledger.jsonl')).entries);
  assert.equal(Object.keys(st.people).length, 2);
  assert.ok(st.mappings.attendees, 'the column mapping was confirmed and recorded');
  assert.equal(st.answered.gate.value, 'ok');
  for (const id of ['c001', 'c002']) { const t = st.people[id].touches[1]; assert.ok(t.hash && t.critic?.verdict === 'PASS' && t.approved?.hash === t.hash, `${id} drafted, read and approved`); assert.equal(t.approved.to, st.people[id].email); }
  assert.ok(!existsSync(join(ev, 'log.jsonl')), 'no log.jsonl: the ledger is the record');
  // `next` on a finished event says done and summarises.
  const again = cli(H, 'flow', ['next', '--event', slug]);
  assert.equal(again.done, true);
});

test('flow: a second event on the same device asks which event, confirms the setup once, and asks only this event\'s questions', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  writeFileSync(join(H.HOME, 'dnc-list.txt'), 'nobody@elsewhere.test\n');
  const first = drive(H, simplePersona({ asks: { attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), dnc: join(H.HOME, 'dnc-list.txt') } }));
  const ob1 = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  // A new run (the run's event choice lapsed): which event, then a new one.
  rmSync(join(H.HOME, 'work', 'session-event.json'), { force: true });
  // Other people (the two from the first event were written to there, and are held for that).
  writeFileSync(join(H.HOME, 'second-list.csv'), 'Name,Title,Company,Email\nCy Ng,COO,Initech,cy@initech.test\nDi Ho,VP Ops,Hooli,di@hooli.test\n');
  const second = drive(H, simplePersona({ event: { name: 'Second Expo', city: 'Lyon', start: '2026-12-01', end: '2026-12-02', zone: 'Europe/Paris' }, asks: { which_event: 'a new event', reuse_setup: 'yes, same setup', list_source: join(H.HOME, 'second-list.csv'), attendee_list: join(H.HOME, 'second-list.csv'), free_time: { free: 'Tue 1 Dec 10-12, Wed 2 Dec 14-16', zone: 'Europe/Paris' } } }));
  assert.notEqual(second.slug, first.slug);
  assert.equal(second.trail[0] === 'which_event' || second.trail.includes('which_event'), true, second.trail.join(' '));
  const asked2 = second.trail.filter((x) => x.startsWith('onboarding:')).map((x) => x.split(':')[1]);
  assert.ok(asked2.includes('reuse_setup'), asked2.join(' '));
  for (const id of ['setup_level', 'tools', 'crm_where', 'company', 'team', 'samples', 'sending', 'home_tz', 'dnc']) assert.ok(!asked2.includes(id), `${id} asked again for the second event: ${asked2.join(' ')}`);
  for (const id of ['event', 'goal', 'list_source', 'free_time']) assert.ok(asked2.includes(id) || id === 'event', `${id} not asked for the second event: ${asked2.join(' ')}`);
  // The first event's goal stayed with it; the do-not-contact list carried over.
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'events', first.slug, 'event.json'), 'utf8')).settings.goal, 'ops leaders at 3PLs');
  assert.ok(existsSync(join(H.HOME, 'events', second.slug, 'inputs', 'dnc.txt')), 'the do-not-contact list carried into the new event');
  assert.equal(ob1.answers.setup_level, 'full');
});

test('flow answer: refuses an unknown ask id and a bad event answer', () => {
  const H = makeHome({});
  assert.match(cli(H, 'flow', ['answer', '--ask', 'nonsense', '--value', 'x']).ERROR, /isn't a question floorboss asked/);
  const f = join(H.HOME, 'work', 'e.json');
  writeFileSync(f, JSON.stringify({ name: 'X' }));
  assert.match(cli(H, 'flow', ['answer', '--ask', 'event', '--value-file', f]).ERROR, /"name","city","start","end","zone"/);
});

test('flow: a CRM the user chose is connected before anything relies on it, or the user picks a fallback', { timeout: 300000 }, () => {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  writeFileSync(join(H.HOME, 'scan-home', '.claude.json'), JSON.stringify({ mcpServers: { hubspot: { command: 'node', args: ['crm-a.mjs'] } } }));
  const persona = simplePersona({ asks: { attendee_list: join(H.HOME, 'inputs', 'attendees.csv'), tools: { crm: 'hubspot' } } });
  const STOP = new Error('reached connect');
  let at = null;
  try { drive(H, persona, { onStep: (s) => { if (s.step === 'connect') { at = s; throw STOP; } } }); } catch (e) { if (e !== STOP) throw e; }
  assert.ok(at, 'the flow stops at connect: no CRM lookup is skipped without a word');
  assert.match(at.judge.how, /crm\.lookup/);
  // Nothing moves on while the CRM isn't connected.
  assert.equal(cli(H, 'flow', ['next']).step, 'connect');
  const f = join(H.HOME, 'work', 'fallback.json');
  writeFileSync(f, JSON.stringify({ task: 'crm.lookup', answer: 'use an export instead' }));
  cli(H, 'flow', ['answer', '--ask', 'connect_fallback', '--value-file', f]);
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(ob.answers.crm_choice, 'export', 'the fallback changes the choice itself');
  assert.notEqual(cli(H, 'flow', ['next']).step, 'connect');
});
