// The small things from the third first-time-user review: counts read as a person writes them, a refused
// check-these answer doesn't claim the rest was saved, more US cities are known, a title isn't a caution, the
// README counts the mock's questions right, and the shortlist and approval don't come back for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, NOW, setup, cli, triage, idOf } from './fixtures/harness.mjs';
import { simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, run, loadMock, home, answer } from './fixtures/r2.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { plural } from '../lib/plural.mjs';
import { zoneFrom } from '../lib/tz.mjs';
import { stopLikeCells } from '../skills/crm-triage/scripts/sources.mjs';

test('plural: one person, two people, one message', () => {
  assert.equal(plural(1, 'person', 'people'), '1 person');
  assert.equal(plural(3, 'person', 'people'), '3 people');
  assert.equal(plural(1, 'message'), '1 message');
  assert.equal(plural(2, 'message'), '2 messages');
  const src = readFileSync(join(ROOT, 'skills/flow/scripts/steps.mjs'), 'utf8');
  assert.doesNotMatch(src, /\$\{[a-zA-Z.]+\.length\} (people need|messages to write|messages are ready)/);
});

test('US cities: the ones asked for are known; an unknown one asks for a big city or a time zone', () => {
  const want = { Milwaukee: 'America/Chicago', Minneapolis: 'America/Chicago', 'St. Louis': 'America/Chicago', 'Kansas City': 'America/Chicago', Nashville: 'America/Chicago', Charlotte: 'America/New_York', Pittsburgh: 'America/New_York', Cleveland: 'America/New_York', Cincinnati: 'America/New_York', Columbus: 'America/New_York', Indianapolis: 'America/Indiana/Indianapolis', Detroit: 'America/Detroit', Baltimore: 'America/New_York', Tampa: 'America/New_York', Orlando: 'America/New_York', 'Salt Lake City': 'America/Denver', Portland: 'America/Los_Angeles', Sacramento: 'America/Los_Angeles', 'San Diego': 'America/Los_Angeles', 'Las Vegas': 'America/Los_Angeles', Austin: 'America/Chicago', Dallas: 'America/Chicago', Houston: 'America/Chicago', 'San Antonio': 'America/Chicago', Raleigh: 'America/New_York' };
  for (const [city, zone] of Object.entries(want)) assert.equal(zoneFrom(city), zone, city);
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\n' });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'home_tz.txt');
  writeFileSync(f, 'Smallville');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'home_tz', '--value-file', f]);
  assert.match(r.ERROR || '', /ask for the nearest big city, or a time zone like Europe\/Amsterdam/, "the event's own zone, not one on another continent");
});

test('a caution word in a title is someone\'s job, not a caution; in a notes-like column it says why', () => {
  const cols = { Position: { field: 'title' }, Remarks: { field: 'ignore' } };
  const out = stopLikeCells(['Position', 'Remarks'], [{ Position: 'Legal Counsel', Remarks: '' }, { Position: 'COO', Remarks: 'unhappy with the last vendor' }], cols);
  assert.deepEqual(out.map((x) => x.column), ['Remarks']);
  assert.equal(out[0].cells[0].word, 'unhappy');
});

test('a refused check-these answer that settled nobody says nothing else was saved', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\n' });
  triage(H);
  const ola = idOf(H, 'Ola Ops');
  // Ola goes to check-these (an unsure fit), and a match answer doesn't settle that.
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify([{ id: ola, unsure: true, reason: 'vague title', score: 60 }])]);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'check.txt');
  writeFileSync(f, `${ola} different-person`);
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'check_these', '--value-file', f]);
  assert.match(r.ERROR || '', /Still unsettled: .*Nothing else was saved\./);
  assert.doesNotMatch(r.ERROR, /The rest were saved/);
});

test('README: the mock asks about nine questions', () => {
  assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /asks about nine questions/);
});

test('mock: a cut or a recorded send brings back neither the shortlist nor the approval of drafts left out', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  const at = untilStep(H, per, 'approve');
  const ids = [...new Set(JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8')).jobs.filter((j) => j.kind === 'message').map((j) => j.id))];
  const a = answer(HOME, 'approve', `approve all except ${ids[0]}`);
  assert.ok(!a.ERROR, a.ERROR);
  const f = join(HOME, 'work', 'report.json');
  writeFileSync(f, JSON.stringify({ items: [{ who: ids[1], what: 'sent' }, { who: ids[2], what: 'cut', reason: 'met them already' }] }));
  const r = run(HOME, 'event-outreach', ['record', '--event', MOCK, '--file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  // Something went: not asked about in the run that recorded it (minutes after sending); the next run, with
  // nothing connected that can see replies, asks what came in first.
  assert.notEqual(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since');
  run(HOME, 'flow', ['next', '--new-run']);
  assert.equal(run(HOME, 'flow', ['next', '--event', MOCK]).step, 'replies_since');
  assert.ok(!answer(HOME, 'replies_since', 'none').ERROR);
  const s = run(HOME, 'flow', ['next', '--event', MOCK]);
  assert.notEqual(s.step, 'gate', JSON.stringify(s).slice(0, 300));
  assert.notEqual(s.step, 'approve', JSON.stringify(s).slice(0, 300));
  // The draft left out is said, not asked about again.
  assert.match(s.tell_user || '', new RegExp(`Left out at your last approval, and waiting for your word: .*\\(${ids[0]}\\)`));
});
