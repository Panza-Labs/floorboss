// /floorboss:start --restart does what it says: answers, the setup level, the scan and the settings the
// questions set are cleared and asked again from the disclaimer; the profile files and connected tools stay,
// and a new event after a restart isn't told its setup carries over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';

test('restart: cleared to the disclaimer, profile and connectors kept, earlier settings saved, no "carries over"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const RECIPE = { server: 'gmail', tool: 'send_email' };
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, context_profile: 'buyers', crm_user_name: 'Sam Rivera', drafting_mode: 'floorboss', connectors: { 'email.send': RECIPE } }));
  cli(H, 'event-context', ['scan']);
  writeFileSync(join(H.dir, 'a.json'), JSON.stringify({ inventory_confirmed: true, setup_level: 'standard' }));
  cli(H, 'event-context', ['onboarding', '--event', H.slug, '--answer-file', join(H.dir, 'a.json')]);
  const r = cli(H, 'event-context', ['onboarding', '--reset']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.kept, /^Starting over from the disclaimer: every setup question is asked again\. Your profile files \(buyers: who to meet, what you bring, voice\) and connected tools are kept/);
  const cfg = JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { connectors: { 'email.send': RECIPE }, context_profile: 'buyers' });
  assert.equal(JSON.parse(readFileSync(join(H.HOME, 'config.before-restart.json'), 'utf8')).crm_user_name, 'Sam Rivera');
  assert.ok(!existsSync(join(H.HOME, 'inventory.json')), 'the scan runs again');
  assert.ok(existsSync(join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md')), 'the profile files stay');
  const ob = JSON.parse(readFileSync(join(H.HOME, 'onboarding.json'), 'utf8'));
  assert.deepEqual(ob.answers, {});
  // The first step is the disclaimer, before any question about which event.
  const s = cli(H, 'flow', ['next', '--new-run']);
  assert.equal(s.step, 'disclaimer', JSON.stringify(s).slice(0, 300));
  cli(H, 'event-context', ['ack']);
  assert.equal(cli(H, 'flow', ['next']).step, 'scan', 'the scan of their tools is done again');
  // Which event, answered "a new event": no claim that the setup carries over.
  writeFileSync(join(H.dir, 'w.txt'), 'a new event');
  const a = cli(H, 'flow', ['answer', '--ask', 'which_event', '--value-file', join(H.dir, 'w.txt')]);
  assert.ok(!a.ERROR, a.ERROR);
  assert.doesNotMatch(a.result.note, /carries over/);
  assert.match(a.result.note, /setup questions too, since you restarted/);
});
