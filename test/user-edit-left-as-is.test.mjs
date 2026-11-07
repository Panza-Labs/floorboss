// The user's own edit (saved after "edit <id>") is never handed back to Claude to rewrite: the batch check
// names it as "yours, left as is", the critic still reads it, and a fail goes to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW, setup, cli, triage, todoJobs } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { untilStep } from './fixtures/flow-until.mjs';
import { MOCK, envOf, loadMock, home, run, answer } from './fixtures/r2.mjs';

test('edit <id>, then the critic fails the user\'s text: not redrafted, said to the user, approvable by id', { timeout: 300000 }, () => {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  loadMock(HOME);
  const H = { HOME, now: NOW, env: envOf(HOME) };
  let target = null;
  const per = simplePersona({
    slug: MOCK,
    asks: { check_these: (s) => s.ask.people.map((x) => `${x.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' },
    // The critic fails only the user's edited text.
    judge: { critic: (batch) => (batch.drafts || batch).map((d) => `${d.id}:${d.touch} ${d.id === target && JSON.stringify(d).includes('EDITED BY ME') ? 'FAIL: says the sender met them, which nothing backs' : 'PASS'}`).join('\n') },
  });
  const at = untilStep(H, per, 'approve');
  assert.equal(at.step, 'approve');
  const todo = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
  const job = todo.jobs.find((j) => j.kind === 'message' && j.touch === 1 && j.channel === 'email');
  target = job.id;
  const g = answer(HOME, 'approve', `approve all except ${target}\nedit ${target}`);
  assert.ok(!g.ERROR, g.ERROR);
  const ed = (g.result.to_edit || []).find((x) => x.id === target);
  assert.ok(ed, JSON.stringify(g.result).slice(0, 400));
  const draft = JSON.parse(readFileSync(job.draft_file, 'utf8'));
  writeFileSync(ed.file, `Subject: ${draft.subject}\n\n${draft.body.replace(/^(Hi [^,\n]+,)/, '$1 EDITED BY ME, we met at the last expo.')}\n`);
  const s = run(HOME, 'event-outreach', ['save-draft', '--event', MOCK, '--id', target, '--touch', '1', '--md-file', ed.file]);
  assert.ok(!s.ERROR, s.ERROR);
  const led = () => readFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(led().some((x) => x.type === 'drafted' && x.id === target && x.user_edited), 'saved as the user\'s own edit');
  const drafts = [], told = [];
  const r = drive(H, per, { maxSteps: 80, onStep: (st) => { if (st.step === 'draft') drafts.push(...st.judge.ids); if (st.tell_user) told.push(st.tell_user); } });
  assert.ok(led().some((x) => x.type === 'critic' && x.id === target && x.verdict === 'FAIL'), 'the critic read the edit');
  assert.ok(!drafts.some((k) => k.startsWith(`${target}:`)), `floorboss rewrote the user's edit: ${drafts.join(',')}`);
  assert.match(told.concat(r.last.tell_user || '').join(' '), new RegExp(`Your edit of [^(]+\\(${target}\\) failed the critic \\(says the sender met them.*approve ${target} by id`));
  const body = JSON.parse(readFileSync(job.draft_file, 'utf8')).body;
  assert.match(body, /EDITED BY ME/, 'the text is still the user\'s');
});

test('batch check: a reason that names the user\'s own edit says it is theirs, left as is', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,COO,Globex,bo@globex.test\nCy Ng,COO,Initech,cy@initech.test\nDee Ho,COO,Hooli,dee@hooli.test\n' });
  triage(H);
  const { t, jobs } = todoJobs(H);
  const msgs = jobs.filter((j) => j.kind === 'message' && j.touch === 1);
  const last = msgs[msgs.length - 1];
  for (const j of msgs) {
    const body = `Hi ${j.contact.name.split(' ')[0]}, we help operations teams at events like Test Expo plan dock shifts. Could you do ${j.slot_labels.join(' or ')}?\n\nBest, Sam\n\n${t.optout_sentence}`;
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', '1', ...(j === last ? ['--said', 'my own words'] : []), '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x', structure: 'plain-request', fact_source: 'list' })]);
  }
  const b = cli(H, 'event-outreach', ['batch-check', '--event', H.slug]);
  assert.equal(b.verdict, 'FAIL', JSON.stringify(b).slice(0, 300));
  const naming = b.reasons.filter((x) => new RegExp(`\\b${last.id}\\b`).test(x));
  assert.ok(naming.length, b.reasons.join(' | '));
  assert.ok(naming.every((x) => x.endsWith(`(${last.id} is yours, left as is)`)), naming.join(' | '));
});
