// Drafting says what happened: floorboss's own check failures reach the rewrite, a draft stuck after three
// tries is told to the user and kept from the critic, the draft format lists only fact sources the checks take,
// question-first needs a reader fact, the event-name check says what counts, and save-drafts is all or nothing.
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

test('mock run: a draft stuck after three tries is said out loud, kept from the critic and named on its card; checks reach the rewrite; the format lists real fact sources; the mapping is remembered for the mock only', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  // A quick setup at home: the mock must not take it (no "company research?" question in the mock).
  writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'quick' } }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  let target = null;
  const feedbackSeen = [], formats = [], told = [], criticIds = [], mappingWhy = [];
  const base = simplePersona({ slug: MOCK });
  const per = simplePersona({
    slug: MOCK,
    asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' },
    judge: {
      draft: (todo, ids, reasons) => {
        const out = base.judge.draft(todo, ids, reasons);
        target ||= out.find((d) => todo.jobs.find((j) => j.id === d.id && j.touch === d.touch && j.kind === 'message' && j.channel === 'email'))?.id;
        const job = todo.jobs.find((j) => j.id === target && j.touch === 1);
        if (job?.revise_feedback) feedbackSeen.push(job.revise_feedback);
        // The target's draft always leaves out the opt-out line, so floorboss's checks fail it every time.
        return out.map((d) => (d.id === target && d.touch === 1 ? { ...d, body: d.body.replace(todo.optout_sentence || "If this isn't relevant, say so and I won't follow up.", '').trim() } : d));
      },
    },
  });
  const r = drive(H, per, { maxSteps: 220, onStep: (s) => {
    if (s.step === 'draft') formats.push(s.judge.format);
    if (s.tell_user) told.push(s.tell_user);
    if (s.step === 'critic') for (const a of s.agents) criticIds.push(...a.then[a.then.indexOf('--ids') + 1].split(','));
    if (/^map_columns_/.test(s.step) && s.ask) mappingWhy.push(s.why);
  } });
  assert.ok(r.last.done || r.last.step === 'waiting', r.trail.slice(-6).join(' '));
  assert.ok(target, 'a draft was targeted');
  assert.ok(!r.trail.includes('company_research'), `the home setup's quick level reached the mock: ${r.trail.join(' ')}`);
  assert.ok(feedbackSeen.some((f) => /floorboss's checks failed the last version: .*opt-out/.test(f)), `script checks carried into the rewrite: ${JSON.stringify(feedbackSeen)}`);
  assert.ok(told.some((t) => t.includes(target) && /after its rewrites/.test(t) && /\d check fails?/.test(t)), `stuck draft said to the user: ${JSON.stringify(told)}`);
  assert.ok(r.trail.includes('stuck_drafts'), r.trail.join(' '));
  // After the third try it isn't read by the critic as if nothing happened.
  const ledger = readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!ledger.some((e) => e.type === 'critic' && e.id === target), 'the stuck draft went to the critic');
  assert.ok(formats.length && formats.every((f) => /in this batch: /.test(f) && !/research\|crm\|mailbox\|list\|none/.test(f)), JSON.stringify(formats));
  assert.ok(mappingWhy.length && mappingWhy.every((w) => /this mock run only/.test(w) && !/next ones/.test(w)), JSON.stringify(mappingWhy));
  const page = run(HOME, 'event-outreach', ['open', '--event', MOCK, '--review', '--no-open']);
  assert.ok(!page.ERROR, page.ERROR);
  const html = readFileSync(join(HOME, 'events', MOCK, 'outbox.html'), 'utf8');
  assert.match(html, /Still fails floorboss&#39;s checks after three rewrites|Still fails floorboss's checks after three rewrites/);
});

// ---------- (3) drafting checks ----------

test('drafting: question-first never goes to someone floorboss knows only by title and company; the event-name check says what counts', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\nCy Ng,COO,Initech,cy@initech.test\nDee Ho,COO,Hooli,dee@hooli.test\n' });
  triage(H);
  const { jobs } = todoJobs(H);
  const msgs = jobs.filter((j) => j.kind === 'message');
  assert.ok(msgs.length >= 3);
  for (const j of msgs) {
    if (j.fact_sources.every((f) => f === 'list' || f === 'none')) assert.notEqual(j.structure, 'question-first', `${j.id}: ${j.fact_sources}`);
  }
  const p = checkDraft({ channel: 'email', subject: 's', body: 'Hi Ana, see you at the forum? Best, Sam' }, { contact: { name: 'Ana Berg' }, eventName: 'Iberian Logistics Forum', eventAliases: [], slotLabels: [] });
  const ev = p.find((x) => /doesn't name the event/.test(x));
  assert.match(ev, /write "Iberian Logistics Forum" or "Iberian Logistics"/);
  assert.match(ev, /"the forum", counts only once the user adds it as one of the event's short names/);
  // Added as a short name, it counts.
  assert.ok(!checkDraft({ channel: 'email', subject: 's', body: 'Hi Ana, see you at the forum? Best, Sam' }, { contact: { name: 'Ana Berg' }, eventName: 'Iberian Logistics Forum', eventAliases: ['the forum'], slotLabels: [] }).some((x) => /name the event/.test(x)));
});

test('save-drafts: one bad entry saves nothing', () => {
  const H = setup({ attendees: PEOPLE });
  triage(H);
  const { jobs } = todoJobs(H);
  const [a] = jobs.filter((j) => j.kind === 'message');
  const f = join(H.HOME, 'batch.json');
  writeFileSync(f, JSON.stringify([{ id: a.id, touch: 1, subject: 'Test Expo', body: 'Hi there, a fine draft.', brief: 'x' }, { id: 'c099', touch: 1, body: 'nobody' }, { id: a.id, touch: 1, body: '' }]));
  const r = cli(H, 'event-outreach', ['save-drafts', '--event', H.slug, '--drafts-file', f]);
  assert.match(r.ERROR || '', /Nothing was saved: .*c099.*isn't in the current drafting list.*twice/);
  assert.ok(!existsSync(a.draft_file), 'the good entry was not written either');
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8');
  assert.doesNotMatch(led, /"type":"drafted"/);
});
