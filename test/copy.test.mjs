// The copy steps: a blind set the user rates as the readers would (ratings in the ledger, 3 or less sends the
// draft back), a skip recorded with the user's words, and emails that got replies saved to the voice file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove } from './fixtures/harness.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';

const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nCy Moss,Head of Ops,Initech,cy@initech.test\nDee Park,Director of Logistics,Umbrella,dee@umbrella.test\n';
const work = (H, n) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); return join(H.HOME, 'work', n); };
const ledger = (H) => fold(readLedger(join(H.dir, 'ledger.jsonl')).entries);

test('rate-set: a blind set across structures, the key apart; ratings saved by draft; 3 or less goes back', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const set = cli(H, 'event-outreach', ['rate-set', '--event', H.slug, '--n', '4']);
  assert.equal(set.drafts, 4, JSON.stringify(set));
  const md = readFileSync(set.file, 'utf8');
  assert.match(md, /^## 1\. To: /m);
  assert.doesNotMatch(md, /question-first|insight-first|plain-request|c00\d/, 'the set shows neither the structure nor the id');
  const key = JSON.parse(readFileSync(join(H.dir, 'derived', 'rate-key.json'), 'utf8'));
  assert.ok(new Set(key.map((k) => k.structure)).size >= 2, `structures spread: ${key.map((k) => k.structure)}`);
  const f = work(H, 'ratings.txt');
  writeFileSync(f, '1 7 fine\n#2 - 2/10 nobody would answer this\nnot a rating line\ndraft 3 = 6\n');
  const r = cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text-file', f]);
  assert.equal(r.rated, 3, JSON.stringify(r));
  assert.deepEqual(r.sent_back, [key[1].id]);
  const st = ledger(H);
  assert.equal(st.people[key[0].id].ratings[0].rating, 7);
  assert.equal(st.people[key[0].id].ratings[0].hash, key[0].hash);
  const entries = readLedger(join(H.dir, 'ledger.jsonl')).entries;
  assert.ok(entries.some((e) => e.type === 'revise' && e.id === key[1].id && /nobody would answer/.test(e.feedback) && e.said), 'the low one goes back with the user\'s words');
  // Rated drafts aren't offered again.
  const again = cli(H, 'event-outreach', ['rate-set', '--event', H.slug]);
  assert.ok(!JSON.parse(readFileSync(join(H.dir, 'derived', 'rate-key.json'), 'utf8')).some((k) => [key[0].hash, key[1].hash, key[2].hash].includes(k.hash)), JSON.stringify(again));
});

test('rate: a skip is recorded with the user\'s words; nothing parsable is an error', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  cli(H, 'event-outreach', ['rate-set', '--event', H.slug]);
  const f = work(H, 'r.txt');
  writeFileSync(f, 'looks fine to me');
  assert.match(cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text-file', f]).ERROR, /No ratings read/);
  writeFileSync(f, 'skip, I trust it');
  assert.equal(cli(H, 'event-outreach', ['rate', '--event', H.slug, '--text-file', f]).skipped, true);
  assert.equal(ledger(H).answered.rate.value, 'skipped');
});

test('voice-save: at most five emails that got replies, addresses and numbers taken out, under their own heading', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  const samples = Array.from({ length: 7 }, (_, i) => ({ subject: `Quick one ${i}`, body: `Hi Jo,\n\nSaw your note about dock queues. Worth 20 minutes Tuesday?\n\nSam\nsam@lanecraft.example +1 202 555 0147` }));
  const f = work(H, 'v.json');
  writeFileSync(f, JSON.stringify({ samples }));
  const r = cli(H, 'event-outreach', ['voice-save', '--event', H.slug, '--file', f]);
  assert.equal(r.saved, 5, JSON.stringify(r));
  const voice = readFileSync(r.file, 'utf8');
  assert.equal(voice.match(/## Emails that got replies/g).length, 1);
  assert.doesNotMatch(voice, /sam@lanecraft|1234 5678/);
  assert.match(voice, /\[address\]/);
  // Saving again replaces the section, never stacks it.
  cli(H, 'event-outreach', ['voice-save', '--event', H.slug, '--file', f]);
  assert.equal(readFileSync(r.file, 'utf8').match(/## Emails that got replies/g).length, 1);
  assert.equal(ledger(H).voice_samples.length, 10);
});

test('a confidential figure is matched whole: "2024-26" under NDA never flags an event named 2026', async () => {
  const { confidentialNumbers, checkDraft } = await import('../skills/event-outreach/scripts/checks.mjs');
  const facts = '| Carrier audits | review of 23 customer audit reports (shared under NDA), 2024-26 |\nWe cut late deliveries 40% (confidential)';
  assert.deepEqual(confidentialNumbers(facts), ['23', '40%']);
  const p = (body) => checkDraft({ channel: 'email', subject: 'x', body }, { ownFacts: facts }).filter((x) => /confidential/.test(x));
  assert.deepEqual(p('See you at Harbour Expo 2026, Tue 20th at 10:00?'), []);
  assert.equal(p('We read 23 audit reports.').length, 1);
  assert.equal(p('Late deliveries fell 40%.').length, 1);
});
