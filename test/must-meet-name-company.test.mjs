// A must-meet written "Name, Company" (the way the goal question asks for it) finds that person; and a
// must-meet whose draft failed the critic twice is named as "your must-meet" at approval and at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW, setup, cli } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home, mockPerson } from './fixtures/r2.mjs';
import { mustMeetHits } from '../skills/crm-triage/scripts/shortlist.mjs';

test('must-meet lines: "Name, Company", "Name - Company", "Name (Company)" and "Name at Company" all find the person', () => {
  const contacts = [{ id: 'c001', name: 'Rachel Kim', company_key: 'lakeshore health system' }, { id: 'c002', name: 'Marcus Bell', company_key: 'lakeshore health system' }, { id: 'c003', name: 'Marcus Bell', company_key: 'prairie cold storage' }];
  for (const line of ['Marcus Bell, Lakeshore Health System', 'Marcus Bell - Lakeshore Health System', 'Marcus Bell (Lakeshore Health System)', 'Marcus Bell at Lakeshore Health System']) {
    assert.deepEqual(mustMeetHits(line, contacts).hits.map((c) => c.id), ['c002'], line);
  }
  // The company, when given, picks between two people of the same name.
  assert.deepEqual(mustMeetHits('Marcus Bell, Prairie Cold Storage', contacts).hits.map((c) => c.id), ['c003']);
});

test('the shortlist card finds a "Name, Company" must-meet on the list', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nRachel Kim,Director of Facilities,Lakeshore Health System,rachel@lakeshore.test\nMarcus Bell,VP Facilities,Lakeshore Health System,marcus@lakeshore.test\n', settings: { must_meet: ['Marcus Bell, Lakeshore Health System'] } });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  assert.ok(!load.ERROR, load.ERROR);
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const mm = JSON.stringify(v.must_meet || load.must_meet);
  assert.match(mm, /"found":\[\{"id":"c00\d","name":"Marcus Bell"/, mm);
  assert.doesNotMatch(mm, /not on this list/);
});

test('a must-meet held after two critic fails is named as "your must-meet" at approval and at the end', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const evFile = join(HOME, 'events', MOCK, 'event.json');
  const ev = JSON.parse(readFileSync(evFile, 'utf8'));
  const p = mockPerson(0);
  ev.settings.must_meet = [`${p.name}, ${p.company}`];
  writeFileSync(evFile, JSON.stringify(ev));
  const H = { HOME, now: NOW, env: envOf(HOME) };
  let target = null;
  const held = [], told = [];
  const per = simplePersona({
    slug: MOCK,
    asks: { check_these: (s) => s.ask.people.map((x) => `${x.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip', approve: (s) => { held.push(...(s.held || [])); return 'approve all'; } },
    judge: {
      critic: (batch) => {
        target ||= JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'shortlist.json'), 'utf8')).must_meet[0];
        return (batch.drafts || batch).map((d) => `${d.id}:${d.touch} ${d.id === target && d.touch === 1 ? 'FAIL: claims something the profile does not back' : 'PASS'}`).join('\n');
      },
    },
  });
  const r = drive(H, per, { maxSteps: 220, onStep: (s) => { if (s.tell_user) told.push(s.tell_user); } });
  assert.ok(target, 'the must-meet was found and shortlisted');
  const h = held.find((x) => x.id === target);
  assert.ok(h, `held at approval: ${JSON.stringify(held)}`);
  assert.equal(h.must_meet, true);
  assert.match(h.why, /^your must-meet: failed the critic twice/);
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-5).join(' '));
  assert.match(r.last.tell_user || '', new RegExp(`${p.name} \\(${target}\\): your must-meet's draft failed the critic twice`));
});
