// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The guided intake (2026-11-21): onboarding as buttons and fields. Two multi-selects: what floorboss can learn from
// about the user's business (once per user: a CRM, past emails, the company's site or material), and who to reach at
// this show (an attendee file, the event's site or app, a few names). Each pick gets one targeted step; anything not
// picked asks nothing; a one-line summary ends it. Every question with a fixed set of answers carries `choices`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, drive, simplePersona, cli, ROOT } from './sims/lib/driver.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n';
const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };

function home(codex = false) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  if (codex) {
    H.env = { ...H.env, ...CODEX };
    delete H.env.CLAUDECODE;
  } else H.env = { ...H.env, CLAUDECODE: '1' };
  return H;
}
// Drives until `stop` matches a step (that step isn't answered); returns every step seen before it, and it.
function until(H, per, stop) {
  const steps = [];
  const STOP = new Error('stop');
  let at = null;
  try {
    drive(H, per, { maxSteps: 160, onStep: (s) => { if (stop(s)) { at = s; throw STOP; } steps.push(s); } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return { steps, at };
}
const asks = (steps) => steps.filter((s) => s.ask).map((s) => s.ask.id);
// The asks between the intake and the goal question: the intake's own steps.
const between = (steps, from, to = 'goal') => {
  const ids = asks(steps);
  const i = ids.indexOf(from);
  const j = ids.indexOf(to, i);
  return ids.slice(i + 1, j < 0 ? undefined : j);
};
const persona = (asks = {}) => simplePersona({ asks: { setup_level: 'standard', list_source: (s, H) => join(H.HOME, 'inputs', 'attendees.csv'), ...asks } });

test('intake: the account question is a multi-select of what floorboss can learn from', { timeout: 300000 }, () => {
  const H = home();
  const { at } = until(H, persona(), (s) => s.ask?.id === 'account_intake');
  assert.ok(at, 'the account intake is asked');
  assert.equal(at.ask.multi, true);
  assert.equal(at.ask.other_allowed, false);
  assert.deepEqual(at.ask.choices.map((c) => c.value), ['crm', 'emails', 'material', 'none']);
  for (const c of at.ask.choices) assert.ok(c.label && c.description, JSON.stringify(c));
  assert.ok(at.ask.header && at.ask.header.length <= 12, at.ask.header);
  assert.match(at.ask.question, /What can floorboss learn from/);
});

test('intake: the show question is a multi-select of who to reach, asked after the account one', { timeout: 300000 }, () => {
  const H = home();
  const { steps, at } = until(H, persona({ account_intake: 'none' }), (s) => s.ask?.id === 'show_intake');
  assert.ok(at, 'the show intake is asked');
  assert.ok(asks(steps).includes('account_intake'));
  assert.equal(at.ask.multi, true);
  assert.deepEqual(at.ask.choices.map((c) => c.value), ['file', 'website', 'names']);
  assert.match(at.ask.question, /Who do you want to reach at this show/);
  assert.ok(!asks(steps).includes('goal'), 'both intakes come before the goal');
});

test('intake: each pick leads to its one step; an unpicked item asks nothing', { timeout: 600000 }, () => {
  // The file: put it in the show folder and say its name.
  {
    const H = home();
    const r = until(H, persona({ account_intake: 'none', show_intake: 'file', list_source: join(H.HOME, 'inputs', 'attendees.csv') }), (s) => s.ask?.id === 'goal');
    assert.deepEqual(between(r.steps, 'show_intake'), ['list_source', 'intake_summary']);
    const q = r.steps.find((s) => s.ask?.id === 'list_source').ask.question;
    assert.match(q, /show folder/);
    for (const id of ['crm_where', 'crm_use', 'tools', 'crm_export', 'intake_website', 'intake_names', 'intake_material']) assert.ok(!asks(r.steps).includes(id), `${id} asked`);
    const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
    assert.equal(ob.answers.crm_choice, 'none', 'a CRM not picked is off');
  }
  // The website: paste the link.
  {
    const H = home();
    const r = until(H, persona({ account_intake: 'none', show_intake: "the event's website or app", intake_website: 'https://expo.example/attendees' }), (s) => s.ask?.id === 'goal');
    assert.deepEqual(between(r.steps, 'show_intake'), ['intake_website', 'intake_summary']);
    assert.match(r.steps.find((s) => s.ask?.id === 'intake_website').ask.question, /Paste the link/);
  }
  // A few names: typed people, saved as the attendee list.
  {
    const H = home();
    const r = until(H, persona({ account_intake: 'none', show_intake: 'just a few names', intake_names: 'Cy Ng, Initech, cy@initech.test\nDi Ho, Hooli, di@hooli.test' }), (s) => s.ask?.id === 'goal');
    assert.deepEqual(between(r.steps, 'show_intake'), ['intake_names', 'intake_summary']);
    const sum = r.steps.find((s) => s.ask?.id === 'intake_summary').ask;
    assert.match(sum.question, /2 people you typed/);
    assert.equal(sum.choices.length, 2);
  }
  // The material: a link or a file.
  {
    const H = home();
    const r = until(H, persona({ account_intake: 'material', intake_material: 'https://lanecraft.example', show_intake: 'none' }), (s) => s.ask?.id === 'show_intake');
    assert.deepEqual(between(r.steps, 'account_intake', 'show_intake'), ['intake_material']);
    const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
    assert.match(String(ob.answers.material_source), /lanecraft\.example/);
  }
});

test('intake: a CRM pick says where to connect it, then checks the tool is visible; an export is the fallback', { timeout: 300000 }, () => {
  const H = home();
  const r = until(H, persona({ account_intake: 'a CRM', crm_where: 'HubSpot' }), (s) => s.step === 'crm_verify');
  const where = r.steps.find((s) => s.ask?.id === 'crm_where').ask;
  assert.match(where.question, /Customize, then Connectors/);
  assert.ok(where.choices.some((c) => /HubSpot/.test(c.label)));
  assert.ok(r.at?.judge, 'a check that the CRM tool is visible');
  assert.match(r.at.judge.how, /HubSpot/);
  // Nothing visible: asked again, with an export as a way on.
  writeFileSync(r.at.judge.write, JSON.stringify({ tools: [] }));
  const v = cli(H, 'flow', r.at.judge.then.slice(2));
  assert.ok(!v.ERROR, v.ERROR);
  const again = cli(H, 'flow', ['next', '--event', 'test-expo']);
  assert.equal(again.ask?.id, 'crm_verify');
  assert.ok(again.ask.choices.some((c) => /export/.test(c.label)));
  // Visible now: the CRM is connected (the connect step comes next).
  writeFileSync(join(H.HOME, 'work', 'v.json'), JSON.stringify({ tools: ['mcp__hubspot__search_contacts', 'mcp__hubspot__get_contact'] }));
  writeFileSync(join(H.HOME, 'work', 'a.txt'), "I've connected it, check again");
  assert.ok(!cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'crm_verify', '--value-file', join(H.HOME, 'work', 'a.txt')]).ERROR);
  const check = cli(H, 'flow', ['next', '--event', 'test-expo']);
  assert.equal(check.step, 'crm_verify');
  writeFileSync(check.judge.write, JSON.stringify({ tools: ['mcp__hubspot__search_contacts', 'mcp__hubspot__get_contact'] }));
  const ok = cli(H, 'flow', check.judge.then.slice(2));
  assert.ok(!ok.ERROR, ok.ERROR);
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.equal(ob.answers.crm_choice, 'connector');
  assert.match(String(ob.answers.crm_server), /hubspot/i);
});

test('intake: past emails picked are asked for (even on quick setup); not picked, never', { timeout: 600000 }, () => {
  const stop = (s) => s.step === 'approve';
  const picked = until(home(), persona({ setup_level: 'quick', account_intake: 'past emails', show_intake: 'file' }), stop);
  assert.ok(asks(picked.steps).includes('voice_samples'), asks(picked.steps).join(' '));
  const H2 = home();
  const not = until(H2, persona({ setup_level: 'standard', account_intake: 'none', show_intake: 'file' }), stop);
  assert.ok(!asks(not.steps).includes('voice_samples'), 'emails not picked: never asked for them');
  const samples = not.steps.find((s) => s.ask?.id === 'samples');
  if (samples) assert.doesNotMatch(samples.ask.question, /emails you sent/);
});

test('intake: the account setup carries over to the next show; only the show question is asked again', { timeout: 600000 }, () => {
  const H = home();
  drive(H, persona({ account_intake: 'none', show_intake: 'file', list_source: join(H.HOME, 'inputs', 'attendees.csv') }));
  writeFileSync(join(H.HOME, 'second.csv'), 'Name,Title,Company,Email\nCy Ng,COO,Initech,cy@initech.test\n');
  rmSync(join(H.HOME, 'work', 'session-event.json'), { force: true });
  const second = until(H, simplePersona({ event: { name: 'Second Expo', city: 'Lyon', start: '2026-12-01', end: '2026-12-02', zone: 'Europe/Paris' }, asks: { which_event: 'a new event', reuse_setup: 'yes, same setup', show_intake: 'file', list_source: join(H.HOME, 'second.csv') } }), (s) => s.ask?.id === 'goal');
  const ids = asks(second.steps);
  assert.ok(ids.includes('show_intake') && !ids.includes('account_intake'), ids.join(' '));
});

test('choices: fixed-answer setup questions carry choices; touches has the suggested one first', { timeout: 300000 }, () => {
  const H = home();
  const r = until(H, persona({ setup_level: 'full', account_intake: 'none', show_intake: 'file', list_source: join(H.HOME, 'inputs', 'attendees.csv') }), (s) => s.step === 'approve');
  const ask = (id) => r.steps.find((s) => s.ask?.id === id)?.ask;
  const lvl = ask('setup_level');
  assert.deepEqual(lvl.choices.map((c) => c.label.replace(/ \(recommended\)/, '')), ['quick', 'standard', 'full']);
  assert.equal(lvl.multi, false);
  assert.ok(lvl.choices.every((c) => c.value && c.description));
  const t = ask('touches');
  assert.match(t.choices[0].label, /suggested/);
  assert.ok(t.choices.length >= 2 && t.choices.length <= 4);
  assert.ok(t.choices.every((c) => /^[3-7]\b/.test(c.value)), JSON.stringify(t.choices));
  // Free text stays open: the show name and what they sell.
  for (const id of ['goal', 'offer']) if (ask(id)) assert.equal(ask(id).choices, undefined, `${id} is free text`);
});

test('choices in Codex: a numbered answer ("1,2") is read as those choices', { timeout: 300000 }, () => {
  const H = home(true);
  const r = until(H, persona({ setup_level: 'quick' }), (s) => s.ask?.id === 'account_intake');
  assert.ok(r.at);
  writeFileSync(join(H.HOME, 'work', 'n.txt'), '1,2');
  const a = cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'account_intake', '--value-file', join(H.HOME, 'work', 'n.txt')]);
  assert.ok(!a.ERROR, a.ERROR);
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  const vals = r.at.ask.choices.slice(0, 2).map((c) => c.value);
  for (const v of vals) assert.match(String(ob.answers.account_intake), new RegExp(v));
});

test('skill texts: Claude Code asks choices with AskUserQuestion; Codex shows them numbered', () => {
  const claude = readFileSync(join(ROOT, 'skills/flow/SKILL.md'), 'utf8');
  assert.match(claude, /`choices`[\s\S]*AskUserQuestion/);
  assert.match(claude, /multiSelect/);
  assert.match(claude, /12 characters/);
  const codex = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.match(codex, /`choices`[\s\S]*numbered/);
  assert.match(codex, /"1,3"/);
});
