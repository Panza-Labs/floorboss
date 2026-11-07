// What cards, questions and steps say is what's true: keep N names who it cuts, the import question names
// each skill by what it is, coordinate notes are for the colleague, no app means no app, one "next".
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

// ---------- (4) keep N names who it cuts ----------

test('keep N: a group answer on check-these is not named as "you said to reach"; a line for one person is', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAnn One,Head of things,S1,ann@s1.test\nBen Two,Head of things,S2,ben@s2.test\nCat Three,Head of things,S3,cat@s3.test\n' });
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const ids = load.needs_fit.map((r) => r.id);
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits', JSON.stringify(ids.map((id, i) => ({ id, unsure: true, reason: 'vague title', score: 90 - i })))]);
  const b = cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', `${idOf(H, 'Cat Three')} reach because she runs the floor\neveryone else: reach`]);
  assert.ok(!b.ERROR, b.ERROR);
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'keep 1']);
  assert.ok(!g.ERROR, g.ERROR);
  assert.match(g.kept, /cut 1 you said to reach on check-these: Cat Three \(S3\); say rescue <name> to keep them/);
  assert.doesNotMatch(g.kept, /Ben Two/);
});

// ---------- (5) import_context ----------

test('import_context: a humanizer or tone skill is "how you write", company material is what you can say about your company', () => {
  const s = { inv: { found: { voice: ['skill:humanizer'], company_context: ['skill:humanizer', 'skill:acme-positioning', 'skill:tone-guide'] } } };
  const q = importAsk(s);
  assert.match(q, /humanizer, tone-guide for how you write/);
  assert.match(q, /acme-positioning for what you can say about your company/);
  assert.doesNotMatch(q.split('for what you can say')[0].split('how you write, and ')[1] || '', /humanizer/);
  assert.equal(importAsk({ inv: { found: { voice: ['skill:humanizer'], company_context: [] } } }), 'Use humanizer for how you write?');
});

// ---------- (6) and #13: cards and the rate set say what's real ----------

test('outbox: a coordinate note is for the colleague; with no event app, nothing points at one', () => {
  const base = { event: { name: 'Test Expo', no_app: true }, counts: {}, slots: [] };
  const coord = { kind: 'coordinate', id: 'c001', touch: 1, name: 'Ola Ops', title: 'COO', company: 'Acme', holder: 'Pat Teammate', channel: 'note', body: 'Pat, Ola is at Test Expo. Will you reach out?' };
  const paste = { kind: 'message', id: 'c002', touch: 1, name: 'Bo Li', title: 'VP', company: 'Globex', channel: 'paste', body: 'Hi Bo', verdict: { verdict: 'PASS', reasons: [] } };
  const html = renderOutbox({ ...base, cards: [coord, paste] });
  assert.doesNotMatch(html, /paste in the event app|event app or DM/);
  assert.match(html, /send it to Pat Teammate yourself/);
  assert.match(html, /no address: paste it wherever you reach them/);
  const withApp = renderOutbox({ ...base, event: { name: 'Test Expo', app_name: 'Meetwell' }, cards: [paste] });
  assert.match(withApp, /paste it in Meetwell/);
});

test('rate set: with no event app, a paste message is "(first message, to paste)"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,\nCy Ng,Head of Ops,Initech,,\nDee Ho,COO,Hooli,dee@hooli.test,\n' });
  triage(H);
  const { jobs } = todoJobs(H);
  for (const j of jobs.filter((x) => x.kind === 'message')) {
    const body = `Hi ${j.contact.name.split(' ')[0]}, carriers are being asked for insurance proof earlier this year. Could you do ${(j.slot_labels || []).join(' or ') || 'a coffee at Test Expo'}?\n\nBest, Sam`;
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--json', JSON.stringify({ subject: j.channel === 'email' ? 'Test Expo' : undefined, body, brief: 'x', structure: 'plain-request', fact_source: 'list' })]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'PASS']);
  }
  const set = cli(H, 'event-outreach', ['rate-set', '--event', H.slug]);
  const heads = readFileSync(set.file, 'utf8').split('\n').filter((l) => l.startsWith('## '));
  assert.ok(heads.some((h) => /Initech \(first message, to paste\)/.test(h)), heads.join('\n'));
  assert.ok(!heads.some((h) => /event app/.test(h)), heads.join('\n'));
});

// ---------- #10: one next ----------

test('next: inside the flow every answer says "run flow next again", never another command', () => {
  const H = setup({ attendees: 'Full Name,Job,Org,Mail\nAna Berg,COO,Acme,ana@acme.test\n' });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  assert.ok(!cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']).ERROR);
  const f = join(H.HOME, 'work', 'map.txt');
  writeFileSync(f, 'looks right');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'map_columns_attendees', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.next, 'run flow next again');
  assert.doesNotMatch(JSON.stringify(r), /load --event|onboarding-plan|drafts come next/);
  const asking = readFileSync(join(ROOT, 'skills/flow/references/asking.md'), 'utf8');
  assert.doesNotMatch(asking, /Then run `onboarding-plan` again|Run `… event-context\/scripts\/cli\.mjs onboarding-plan`/);
  const scanSrc = readFileSync(join(ROOT, 'skills/event-context/scripts/cli.mjs'), 'utf8');
  assert.doesNotMatch(scanSrc, /then run onboarding-plan/);
});
