// The mock event never touches the user's own setup: its profile lives in its own folder, a real profile and
// the config's context_profile survive loading it (and loading it again), answers saved on the mock write only
// the mock's files, and a real event never picks the mock's profile up as the user's. Also what the mock says
// about itself: a Lisbon sender in Lisbon time, canned research said to be canned, "Closed Lost" read as lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { USER, EVENT, STATUS_MAPS } from '../examples/mock-event/mock-data.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';

const MOCK = 'mock-harbour-haul';
const envOf = (HOME) => ({ ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home') });
const loadMock = (HOME, goal = 'buyers') => JSON.parse(execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', goal, '--now', NOW], { env: envOf(HOME), encoding: 'utf8' }));
const run = (HOME, skill, args) => JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: envOf(HOME), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const answer = (HOME, ask, value, event = MOCK) => { const f = join(HOME, 'work', `${ask}.json`); writeFileSync(f, JSON.stringify(value)); return run(HOME, 'flow', ['answer', '--event', event, '--ask', ask, '--value-file', f]); };
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

function realSetup() {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-mockiso-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  for (const n of ['who-to-meet', 'what-you-bring', 'voice']) { mkdirSync(join(HOME, 'context', 'lanecraft', n), { recursive: true }); writeFileSync(join(HOME, 'context', 'lanecraft', n, 'SKILL.md'), `REAL ${n}\n`); }
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, context_profile: 'lanecraft', own_company: 'Lanecraft', home_tz: 'Europe/Berlin' }));
  return HOME;
}
const snapshot = (HOME) => ({ config: readFileSync(join(HOME, 'config.json'), 'utf8'), ...Object.fromEntries(['who-to-meet', 'what-you-bring', 'voice'].map((n) => [n, readFileSync(join(HOME, 'context', 'lanecraft', n, 'SKILL.md'), 'utf8')])) });

test('mock: a real setup survives loading the mock, loading it again, and answers saved on the mock', () => {
  const HOME = realSetup();
  const before = snapshot(HOME);
  const out = loadMock(HOME);
  assert.equal(out.context, join(HOME, 'events', MOCK, 'context'), 'the mock\'s profile is inside its own folder');
  const ev = json(join(HOME, 'events', MOCK, 'event.json'));
  assert.equal(ev.context_profile, 'mock-buyers', 'the mock keeps its profile name on its own event');
  assert.equal(ev.context_dir, join(HOME, 'events', MOCK, 'context'));
  assert.ok(!existsSync(join(HOME, 'context', 'mock-buyers')), 'nothing written into the user\'s context folder');
  // Answers saved on the mock that write a profile file go to the mock's profile, never the user's.
  answer(HOME, 'samples', { closest: 'casual and plain', rules: ['never open with a question'] });
  assert.match(readFileSync(join(HOME, 'events', MOCK, 'context', 'voice', 'SKILL.md'), 'utf8'), /never open with a question/);
  loadMock(HOME);
  loadMock(HOME, 'investors');
  assert.deepEqual(snapshot(HOME), before, 'config.json and the real profile are exactly as they were');
  assert.equal(json(join(HOME, 'config.json')).context_profile, 'lanecraft');
  // The mock reads its own profile; a check of it says nothing about the user's.
  const chk = run(HOME, 'event-context', ['check', '--event', MOCK]);
  assert.equal(chk.dir, join(HOME, 'events', MOCK, 'context'));
});

test('mock: a whole mock run, start to approval, leaves a real setup as it was', { timeout: 300000 }, () => {
  const HOME = realSetup();
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'standard', works_alone: true, crm_choice: 'export' } }));
  const before = { ...snapshot(HOME), onboarding: readFileSync(join(HOME, 'onboarding.json'), 'utf8') };
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: { samples: [{ subject: 'Hi', body: 'Hi Ana, quick one from the mock. Best, Sam' }] } } });
  const r = drive(H, per, { maxSteps: 200 });
  assert.ok(r.last.done, r.trail.slice(-5).join(' '));
  const after = snapshot(HOME);
  for (const k of ['who-to-meet', 'what-you-bring', 'voice']) assert.equal(after[k], before[k], k);
  assert.deepEqual(JSON.parse(after.config), JSON.parse(before.config), 'config.json is as it was');
  // The next real run starts from the user's own profile and answers.
  execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'next', '--new-run'], { env: envOf(HOME), encoding: 'utf8' });
  const ob = json(join(HOME, 'onboarding.json'));
  assert.equal(ob.answers.setup_level, 'standard');
  assert.notEqual(ob.event, MOCK);
  assert.equal(json(join(HOME, 'config.json')).context_profile, 'lanecraft');
});

test('mock: after the mock, the first real setup starts the user\'s own profile, not the mock\'s', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-mockiso-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  // An older version of the mock left its profile in context/ and its name in the config.
  for (const n of ['who-to-meet', 'what-you-bring', 'voice']) { mkdirSync(join(HOME, 'context', 'mock-buyers', n), { recursive: true }); writeFileSync(join(HOME, 'context', 'mock-buyers', n, 'SKILL.md'), `MOCK ${n}\n`); }
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, context_profile: 'mock-buyers', own_company: 'Tallyline', goal: 'heads of finance' }));
  loadMock(HOME);
  run(HOME, 'event-context', ['onboarding', '--new-event']);
  const d = run(HOME, 'event-context', ['onboarding-defaults']);
  assert.equal(d.saved.context_profile, 'tallyline', JSON.stringify(d));
  assert.equal(json(join(HOME, 'config.json')).context_profile, 'tallyline');
  assert.ok(existsSync(join(HOME, 'context', 'tallyline', 'voice', 'SKILL.md')));
  assert.equal(readFileSync(join(HOME, 'context', 'mock-buyers', 'voice', 'SKILL.md'), 'utf8'), 'MOCK voice\n', 'the old folder is left alone, not deleted');
});

test('mock: the sender is in Lisbon, so times are Lisbon times; "Closed Lost" means lost', () => {
  assert.equal(EVENT.city, 'Lisbon');
  assert.equal(USER.home_tz, 'Europe/Lisbon');
  for (const g of ['buyers', 'investors']) assert.equal(STATUS_MAPS[g]['Closed Lost'], 'lost', g);
  const HOME = mkdtempSync(join(tmpdir(), 'fb-mockiso-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  loadMock(HOME);
  assert.equal(json(join(HOME, 'events', MOCK, 'event.json')).settings.home_tz, 'Europe/Lisbon');
});

test('mock: its research is canned and says so; no profile reads as "identity not confirmed"', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-mockiso-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  const out = loadMock(HOME);
  assert.ok(out.profiles > 0);
  const dir = join(HOME, 'events', MOCK, 'profiles');
  const mds = execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.md'));
  for (const f of mds) {
    const md = readFileSync(join(dir, f), 'utf8');
    assert.match(md, /Mock event: this research is canned/, f);
    assert.doesNotMatch(md, /NOT confirmed/, f);
    assert.equal(json(join(dir, f.replace(/\.md$/, '.json'))).identity_confirmed, true, f);
  }
});
