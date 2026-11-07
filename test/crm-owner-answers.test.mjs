// The user's CRM name and coworker names are matched against the owners the CRM read holds, and saved as the
// CRM writes them: "Maya Okafor, that's me" is Maya Okafor, so her own customers stay hers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, cli, triage, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { ownerMatch } from '../lib/names.mjs';

const CRM = 'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\n'
  + 'Sofia,Marques,sofia.marques@crestpay.example,Crestpay,Maya Okafor,Customer,09/12/2026,No\n'
  + 'Hannah,Wolfe,hannah.wolfe@bramblecard.example,Bramble Card,Ben Hartley,Opportunity,10/20/2026,No\n';
const PEOPLE = 'Name,Title,Company,Email\nSofia Marques,COO,Crestpay,sofia.marques@crestpay.example\nHannah Wolfe,Director,Bramble Card,hannah.wolfe@bramblecard.example\n';
const answer = (H, ask, value) => {
  const f = join(H.dir, `${ask}.txt`);
  writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
  try { return JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; }
};
const settingsOf = (H) => ({ ...JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8')), ...JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8')).settings });

test('ownerMatch: the same value, then any case, then first and last name in the answer; a first name alone only where asked', () => {
  const owners = ['Maya Okafor', 'Ben Hartley', 'Ben Ito'];
  assert.equal(ownerMatch("Maya Okafor, that's me", owners), 'Maya Okafor');
  assert.equal(ownerMatch('maya okafor', owners), 'Maya Okafor');
  assert.equal(ownerMatch('me, Maya', owners), null);
  assert.equal(ownerMatch('Maya', owners, { first: true }), 'Maya Okafor');
  assert.equal(ownerMatch('Ben', owners, { first: true }), null, 'two Bens: neither');
  assert.equal(ownerMatch('Priya Raman', owners), null);
});

test('crm_name: free text with the owner in it saves the owner value; a name that owns nothing is asked again with the owners; Sofia stays the user\'s', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM });
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  delete ev.settings.crm_user_name;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const bad = answer(H, 'crm_name', 'Priya Raman');
  assert.match(bad.ERROR, /"Priya Raman" isn't an owner in your CRM: Maya Okafor, Ben Hartley\?/);
  const r = answer(H, 'crm_name', "Maya Okafor, that's me");
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(settingsOf(H).crm_user_name, 'Maya Okafor');
  // Her own customer is hers, not a coworker's; Ben's opportunity is his.
  triage(H);
  const tr = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8'));
  const why = (name) => JSON.stringify(tr.pre[idOf(H, name)]);
  assert.doesNotMatch(why('Sofia Marques'), /Maya Okafor holds/, why('Sofia Marques'));
  assert.match(why('Hannah Wolfe'), /Ben Hartley/, why('Hannah Wolfe'));
});

test('coworker_contacts: "Ben: warn me" is saved under the CRM\'s owner value; a name that is no owner is asked again', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM, settings: { crm_user_name: 'Maya Okafor' } });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  assert.match(answer(H, 'coworker_contacts', 'leave them alone; Dana: warn me').ERROR, /"Dana" isn't an owner in your CRM/);
  const r = answer(H, 'coworker_contacts', 'leave them alone; Ben: warn me');
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(settingsOf(H).coworker_overrides, { 'Ben Hartley': 'warn' });
});

test('coworker_contacts: rules typed as sentences ("Ben: leave alone, he\'s coming. Maya: treat as mine.") keep each to its own name', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM, settings: { crm_user_name: 'Ben Ito' } });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', H.slug]).ERROR);
  const r = answer(H, 'coworker_contacts', 'Ben Hartley: leave alone, he\'s coming with me. Maya: warn me, she owns the big one.');
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(settingsOf(H).coworker_overrides, { 'Ben Hartley': 'leave', 'Maya Okafor': 'warn' });
});
