// 0.1.7: every LinkedIn message, the first and each follow-up, is 300 characters or fewer, so any of them also
// works as the note of a connection request. Held to it when it is written and again at approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup, cli, triage, todoJobs, idOf, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { buildBrief } from '../skills/event-outreach/scripts/drafter.mjs';

const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const SETTINGS = { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'linkedin', 'linkedin'], linkedin_messages: true };
const mk = () => {
  const H = setup({ attendees: PEOPLE, settings: SETTINGS });
  triage(H);
  return H;
};
const save = (H, j, d) => cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify(d)]);
const linkedinJobs = (H) => todoJobs(H).jobs.filter((j) => j.kind === 'message' && j.channel === 'paste');

test('a LinkedIn follow-up is given the 300-character limit, like the first LinkedIn message', () => {
  const H = mk();
  const jobs = linkedinJobs(H);
  assert.deepEqual(jobs.map((j) => [j.touch, j.char_limit]), [[2, 300], [3, 300]]);
});

test('a LinkedIn follow-up over 300 characters fails its checks when it is saved', () => {
  const H = mk();
  const r = todoJobs(H);
  const j = r.jobs.find((x) => x.kind === 'message' && x.touch === 3);
  const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
  const body = `${d.body.replace(/\n\nBest, Sam$/, '')} ${'We could compare notes on shift handoffs across your sites. '.repeat(6)}\n\nBest, Sam`.slice(0, 900);
  assert.ok(body.length > 300 && body.length < 600, String(body.length));
  const saved = save(H, j, { body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) });
  assert.ok(Array.isArray(saved.checks) && saved.checks.some((p) => /limit is 300/.test(p)), JSON.stringify(saved));
});

test("the drafter's brief for a LinkedIn follow-up names the job's 300-character limit, not the 600 of a pasted note", () => {
  const H = mk();
  const j = linkedinJobs(H).find((x) => x.touch === 3);
  const text = buildBrief(j, { event: { name: 'Test Expo', city: 'Rotterdam', start_date: '2026-11-10', end_date: '2026-11-12' }, settings: { paste_limit: 600 }, files: {} });
  assert.match(text, /at most 300 characters/);
});

test('at approval, a LinkedIn message longer than the limit is not approved (the limit was lowered after it was written)', () => {
  const H = mk();
  const r = todoJobs(H);
  const lens = {};
  for (const j of r.jobs.filter((x) => x.kind === 'message')) {
    const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
    save(H, j, { subject: 'Test Expo', body: d.body, brief: 'x, no research profile', structure: d.structure, fact_source: d.fact_source, ...(d.insight ? { insight: d.insight } : {}) });
    lens[j.touch] = d.body.length;
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS']);
  }
  const len = lens[2];
  // LinkedIn's note limit is lower on this account than when the drafts were written.
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  ev.settings.linkedin_note_limit = len - 10;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  const ledger = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!ledger.some((e) => e.type === 'approved' && e.touch === 2), `the LinkedIn message over the limit is not approved: ${JSON.stringify(g).slice(0, 600)}`);
});
