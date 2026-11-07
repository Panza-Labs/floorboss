// The blind rating set says where each draft goes: an email, a LinkedIn message, a note in the event's app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

test('rate set: paste messages are labelled LinkedIn or the event app, never "first email"', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,\nBo Li,VP Ops,Globex,,https://www.linkedin.com/in/bo-li-example\nCy Ng,Head of Ops,Initech,,\n', event: { app_name: 'Meetwell' } });
  triage(H);
  const { jobs } = todoJobs(H);
  assert.equal(jobs.filter((j) => j.kind === 'message').length, 3, JSON.stringify(jobs.map((j) => [j.id, j.channel])));
  for (const j of jobs.filter((x) => x.kind === 'message')) {
    const first = j.contact.name.split(' ')[0];
    const body = `Hi ${first}, carriers are being asked for insurance proof earlier this year. Is that showing up for you? Could you do ${(j.slot_labels || []).join(' or ') || 'a coffee at Test Expo'}?\n\nBest, Sam`;
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--json', JSON.stringify({ subject: j.channel === 'email' ? 'Test Expo' : undefined, body, brief: 'x', structure: 'question-first', fact_source: 'list' })]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'PASS']);
  }
  const set = cli(H, 'event-outreach', ['rate-set', '--event', H.slug]);
  assert.equal(set.drafts, 3, JSON.stringify(set));
  const md = readFileSync(set.file, 'utf8');
  const heads = md.split('\n').filter((l) => l.startsWith('## '));
  assert.ok(heads.some((h) => /Acme \(first email\)/.test(h)), heads.join('\n'));
  assert.ok(heads.some((h) => /Globex \(first LinkedIn message\)/.test(h)), heads.join('\n'));
  assert.ok(heads.some((h) => /Initech \(first message in Meetwell\)/.test(h)), heads.join('\n'));
});
