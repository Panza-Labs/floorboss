// The mock event keeps to itself, both ways: its own answers and settings, no real ledgers or contacts, never
// the current event, and a stale session naming it never captures a real answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, NOW, setup, cli, triage, todoJobs, idOf } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { ATTENDEES } from '../examples/mock-event/mock-data.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { importAsk } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { clearVoicePlaceholders } from '../skills/flow/scripts/profile-write.mjs';
import { writeCompanyBrief } from '../skills/attendee-research/scripts/companies.mjs';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';
import { MOCK, envOf, json, run, loadMock, answer, home, realEvent, mockPerson, PEOPLE, CRM } from './fixtures/r2.mjs';

// ---------- (1) the mock keeps to itself ----------

test('mock: it never reads the home setup level or answers, and answers saved on it stay in its own overlay', async () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, own_company: 'Tallyline' }));
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'quick', works_alone: true, samples_skipped: true } }));
  loadMock(HOME);
  process.env.FLOORBOSS_HOME = HOME;
  const { onboardingState } = await import('../skills/event-context/scripts/onboarding-state.mjs');
  const st = onboardingState(MOCK);
  assert.equal(st.ans.setup_level, undefined, 'the mock is never "quick" because the user\'s setup is');
  assert.equal(st.ans.samples_skipped, undefined);
  // An answer saved on the mock lands under the mock's own answers, never in the user's.
  const r = answer(HOME, 'samples', { closest: 'casual and plain', rules: ['short lines'] });
  assert.ok(!r.ERROR, r.ERROR);
  const ob = json(join(HOME, 'onboarding.json'));
  assert.equal(ob.answers.samples_ok, undefined, JSON.stringify(ob));
  assert.equal(ob.events?.[MOCK]?.answers?.samples_ok, true);
  assert.deepEqual(ob.answers, { setup_level: 'quick', works_alone: true, samples_skipped: true });
  // The real setup still reads as quick.
  assert.equal(onboardingState(null).ans.setup_level, 'quick');
  delete process.env.FLOORBOSS_HOME;
});

test('mock: a real person in touch at a real event is not held in the mock, and a mock stop never holds a real event', () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  // Real direction: someone on the mock list was written to at a real event, and a contacts file of the user's.
  const marta = mockPerson(0), dev = mockPerson(1);
  realEvent(HOME, 'northgate', [marta]);
  writeFileSync(join(HOME, 'my-contacts.csv'), `Name,Email,Company\n${dev.name},${dev.email},${dev.company}\n`);
  const cfg = json(join(HOME, 'config.json'));
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ ...cfg, known_contacts_paths: [join(HOME, 'my-contacts.csv')] }));
  loadMock(HOME);
  assert.ok(!run(HOME, 'crm-triage', ['load', '--event', MOCK]).ERROR);
  const res = json(join(HOME, 'events', MOCK, 'derived', 'resolved.json'));
  const contacts = json(join(HOME, 'events', MOCK, 'derived', 'contacts.json'));
  const idOfName = (n) => contacts.find((x) => x.name === n)?.id;
  for (const p of [marta, dev]) {
    const r = res[idOfName(p.name)];
    assert.ok(r, p.name);
    assert.notEqual(r.group, 'in_touch', `${p.name} is held in the mock by the user's real data: ${r.says}`);
    assert.doesNotMatch(JSON.stringify(r), /Northgate|your contacts/, p.name);
  }
  // Mock direction: a stop recorded in the mock never holds the same person at a real event.
  const mockLedger = join(HOME, 'events', MOCK, 'ledger.jsonl');
  const ana = idOfName(marta.name);
  writeFileSync(mockLedger, readFileSync(mockLedger, 'utf8') + JSON.stringify({ at: NOW, type: 'stop', who: 'user', id: ana, said: 'stop (mock)' }) + '\n');
  const H = setup({ attendees: `Name,Title,Company,Email\n${marta.name},VP Operations,${marta.company},${marta.email}\n`, home: HOME, event: { slug: 'real-expo' } });
  assert.ok(!cli(H, 'crm-triage', ['load', '--event', 'real-expo']).ERROR);
  const real = json(join(HOME, 'events', 'real-expo', 'derived', 'resolved.json'));
  const r = Object.values(real)[0];
  assert.doesNotMatch(JSON.stringify(r), /said stop|Harbour/, `a mock stop held a real person: ${r.says}`);
});

test('mock: config --set during the mock writes the mock\'s settings, never the user\'s config', () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, own_company: 'Tallyline', touches: 2 }));
  loadMock(HOME);
  const before = readFileSync(join(HOME, 'config.json'), 'utf8');
  // The mock is the event of the run going on (flow next keeps it in the session file).
  writeFileSync(join(HOME, 'work', 'session-event.json'), JSON.stringify({ slug: MOCK, at: NOW }));
  const f = join(HOME, 'work', 'set.json');
  writeFileSync(f, JSON.stringify({ touches: 1, meeting_place: 'Hall 2, stand B14', colleague_notes: true }));
  const r = run(HOME, 'event-context', ['config', '--set-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.saved_for, /mock event/);
  assert.equal(readFileSync(join(HOME, 'config.json'), 'utf8'), before, 'config.json is untouched');
  const s = json(join(HOME, 'events', MOCK, 'event.json')).settings;
  assert.equal(s.touches, 1);
  assert.equal(s.colleague_notes, true);
  // A setting answered through the flow on the mock goes there too.
  assert.ok(!answer(HOME, 'languages', 'English only').ERROR);
  assert.deepEqual(json(join(HOME, 'events', MOCK, 'event.json')).settings.languages, ['English']);
  assert.equal(readFileSync(join(HOME, 'config.json'), 'utf8'), before);
  // Once the session is a real event's (or none), config --set is the user's again.
  writeFileSync(join(HOME, 'work', 'session-event.json'), JSON.stringify({ at: new Date(0).toISOString() }));
  assert.ok(!run(HOME, 'event-context', ['config', '--set-file', f]).ERROR);
  assert.equal(json(join(HOME, 'config.json')).touches, 1);
});

test('mock: it is never made the current event, and a pointer to it left behind is ignored by the next real run', () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'standard' } }));
  loadMock(HOME);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.ok(!s.ERROR, s.ERROR);
  assert.equal(s.event, MOCK);
  assert.notEqual(json(join(HOME, 'onboarding.json')).event, MOCK, 'flow next on the mock leaves the current event alone');
  // An older version left onboarding.json pointing at the mock: a run that names no event never picks it up.
  const ob = json(join(HOME, 'onboarding.json'));
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ ...ob, event: MOCK }));
  writeFileSync(join(HOME, 'work', 'session-event.json'), JSON.stringify({ at: new Date(0).toISOString() }));
  const n = run(HOME, 'flow', ['next']);
  assert.ok(!n.ERROR, n.ERROR);
  assert.notEqual(n.event, MOCK, JSON.stringify(n).slice(0, 300));
  // And the next onboarding call clears the stale pointer.
  run(HOME, 'event-context', ['onboarding']);
  assert.notEqual(json(join(HOME, 'onboarding.json')).event, MOCK);
});
test('mock: a run session still naming the mock never captures an answer given for a real event', () => {
  const H = setup({ attendees: PEOPLE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  loadMock(H.HOME);
  writeFileSync(join(H.HOME, 'work', 'session-event.json'), JSON.stringify({ slug: MOCK, at: NOW }));
  const f = join(H.HOME, 'work', 'cn2.txt');
  writeFileSync(f, 'yes, draft a note to the coworker');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'colleague_notes', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(json(join(H.HOME, 'config.json')).colleague_notes, true, 'saved in the user\'s setup');
  assert.equal(json(join(H.HOME, 'events', MOCK, 'event.json')).settings.colleague_notes, undefined, 'not in the mock');
  assert.equal(json(join(H.HOME, 'onboarding.json')).answers.colleague_notes_asked, true);
});
