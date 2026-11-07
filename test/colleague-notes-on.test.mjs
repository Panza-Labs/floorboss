// Colleague notes can be turned on: a question with the team, "note <name>" or "notes on" at the shortlist,
// and the card says how.
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

// ---------- (2) colleague notes can be turned on ----------


test('colleague notes: the card says how to turn them on; "note <name>" drafts one, "notes on" all, and a note for someone no coworker holds is refused', () => {
  const H = setup({ attendees: PEOPLE, crm: CRM, settings: { status_map: { Lead: 'ignore' } } });
  triage(H);
  const view = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  const line = view.left_out.find((x) => /Pat Teammate/.test(x.why));
  assert.match(line.why, /colleague notes are off: say "note <name>".*"notes on"/, line.why);
  // Refused for someone no coworker holds, and nothing is saved.
  const bad = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'note Bo Li']);
  assert.match(bad.ERROR || '', /isn't held by a coworker/);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'note Ola Ops']);
  assert.ok(!g.ERROR, g.ERROR);
  const notes = todoJobs(H).jobs.filter((j) => j.kind === 'coordinate');
  assert.deepEqual(notes.map((j) => j.id), [idOf(H, 'Ola Ops')]);
  assert.equal(notes[0].holder, 'Pat Teammate');
  // "notes on" is the setup choice: saved in the user's config, for every event.
  const on = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'notes on']);
  assert.ok(!on.ERROR, on.ERROR);
  assert.equal(json(join(H.HOME, 'config.json')).colleague_notes, true);
  assert.ok(!cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'notes off']).ERROR);
  assert.equal(json(join(H.HOME, 'config.json')).colleague_notes, false);
});

test('colleague notes: the team question saves the choice once (flow answer)', () => {
  const H = setup({ attendees: PEOPLE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'cn.txt');
  writeFileSync(f, 'yes, draft a note to the coworker');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'colleague_notes', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.colleague_notes, true);
  assert.equal(json(join(H.HOME, 'config.json')).colleague_notes, true);
  assert.equal(json(join(H.HOME, 'onboarding.json')).answers.colleague_notes_asked, true);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /"notes on"/);
  assert.match(readme, /"note <name>"/);
});
