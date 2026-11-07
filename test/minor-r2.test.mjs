// Small things from the second first-time-user review.
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

// ---------- minor ----------

test('minor: load.mjs --help loads nothing', () => {
  const HOME = home();
  loadMock(HOME);
  const ev = join(HOME, 'events', MOCK, 'event.json');
  const before = readFileSync(ev, 'utf8');
  writeFileSync(join(HOME, 'events', MOCK, 'marker.txt'), 'still here');
  const r = spawnSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--help'], { env: envOf(HOME), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node load\.mjs --goal buyers\|investors/);
  assert.equal(readFileSync(ev, 'utf8'), before);
  assert.ok(existsSync(join(HOME, 'events', MOCK, 'marker.txt')), 'the mock folder was not replaced');
});

test('minor: the voice file keeps no template placeholders once answered (quick setup asks few fields)', () => {
  const tpl = readFileSync(join(ROOT, 'skills/event-context/templates/voice.md'), 'utf8');
  const md = clearVoicePlaceholders(tpl.replace(/^- \*\*Sign-off:\*\*.*$/m, '- **Sign-off:** Best, Noor'));
  assert.doesNotMatch(md, /<e\.g\.|<[^>\n]{2,}>/);
  assert.match(md, /- \*\*Sign-off:\*\* Best, Noor/);
  assert.doesNotMatch(md, /^- \*\*Tone:\*\*/m, 'an unanswered field is left out (test/voice-from-emails.test.mjs)');
  // Through the flow: the about_you answer writes the voice file without placeholders.
  const H = setup({ attendees: PEOPLE });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const voice = join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md');
  writeFileSync(voice, tpl);
  const f = join(H.HOME, 'work', 'about.json');
  writeFileSync(f, JSON.stringify({ sign_off: 'Best, Noor', sender_name: 'Noor Haddad, Patchbay', city: 'Lisbon' }));
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'about_you', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  const out = readFileSync(voice, 'utf8');
  assert.doesNotMatch(out, /<e\.g\.|<[^>\n]{2,}>/, out);
  assert.match(out, /Sign-off:\*\* Best, Noor/);
});

test('minor: a company brief says its relation once ("prospect. They …", never "prospect. prospect:")', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-r2-brief-'));
  const r = writeCompanyBrief(dir, 'Acme Freight', { sells: 'freight forwarding', relation_to_us: 'prospect: they move reefer loads we could insure', what_they_would_want: 'faster certificates', sources: ['https://example.com/acme'], industry_news: [{ text: 'Port fees rise in 2027', url: 'https://example.com/news', date: '2026-09-01' }] });
  assert.ok(r.saved, JSON.stringify(r));
  const md = readFileSync(join(dir, 'companies', readdirSync(join(dir, 'companies')).find((x) => x.endsWith('.md'))), 'utf8');
  assert.match(md, /\*\*Relation to us:\*\* prospect\. They move reefer loads we could insure/);
  assert.doesNotMatch(md, /prospect\. prospect/);
});

test('minor: the languages answer says what was saved, not the whole config; approvals with sending off are "you" to send; "skip" on the rate set needs no set', () => {
  const H = setup({ attendees: PEOPLE });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, own_company: 'Lanecraft' }));
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'lang.txt');
  writeFileSync(f, 'English only');
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', 'languages', '--value-file', f]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.deepEqual(r.result, { languages: ['English'] });
  triage(H);
  // Rate "skip" before any blind set was made (rate-set never ran).
  const sk = cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text', 'skip']);
  assert.ok(!sk.ERROR, sk.ERROR);
  assert.equal(sk.skipped, true);
  // An approval with sending off doesn't claim it goes via email.send.
  const { jobs } = todoJobs(H);
  for (const j of jobs.filter((x) => x.kind === 'message')) {
    const body = `Hi ${j.contact.name.split(' ')[0]}, I work on carrier compliance for freight teams. Could you do ${j.slot_labels.join(' or ')} at Test Expo?\n\nBest, Sam\n\nIf this isn't relevant, say so and I won't follow up.`;
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--json', JSON.stringify({ subject: 'Test Expo', body, brief: 'x', structure: 'plain-request', fact_source: 'list' })]);
    cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--text', 'PASS']);
  }
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.ok(!g.ERROR && g.approved >= 1, JSON.stringify(g));
  const approvals = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'approved');
  assert.ok(approvals.length && approvals.every((e) => e.via === 'you'), JSON.stringify(approvals.map((e) => e.via)));
});
