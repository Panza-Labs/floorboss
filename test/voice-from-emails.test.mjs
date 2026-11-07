// Standard setup asks for the user's own emails that got replies with the samples question: given, they go
// into the voice file and set its length and greeting; with none, the voice file has no empty lines or sections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, setup, cli } from './fixtures/harness.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';

const answer = (H, ask, value) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', `${ask}.json`); writeFileSync(f, JSON.stringify(value)); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]); };
const PEOPLE = 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\n';

test('the samples question asks for two to five emails that got replies, and "none" is an answer', () => {
  const q = NODES.find((n) => n.id === 'samples').ask({ cfg: {}, ans: {} });
  assert.match(q, /two to five emails you sent that got replies/);
  assert.match(q, /Or say "none"/);
});

test('emails given: saved under "Emails that got replies", Length, Greeting and Avoid come from them', () => {
  const H = setup({ attendees: PEOPLE });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const file = join(H.HOME, 'work', 'email3.txt');
  writeFileSync(file, 'Subject: Dock queues\n\nHi Mo,\n\nSaw the dock queue numbers you posted. Worth 20 minutes on Tuesday to compare?\n\nThanks, Jess');
  const r = answer(H, 'samples', { closest: 'casual and plain', rules: [], emails: [
    { subject: 'Quick one', body: 'Hi Jo,\n\nYour team moved to cross-docking last spring. Could we compare notes for 20 minutes at the expo?\n\nThanks, Jess' },
    { subject: 'Energy audit', body: 'Hi Sam,\n\nTwo of your buildings run chillers at night. Happy to show what we found, 20 minutes on Wednesday?\n\nThanks, Jess' },
    file,
  ], avoid: 'exclamation marks' });
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.emails_saved, 3);
  const voice = readFileSync(join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md'), 'utf8');
  assert.match(voice, /^- \*\*Length:\*\* about \d+ words, like your emails that got replies$/m);
  assert.match(voice, /^- \*\*Greeting:\*\* "Hi <first name>,"$/m);
  assert.match(voice, /^- \*\*Avoid:\*\* exclamation marks$/m);
  assert.match(voice, /## Emails that got replies\n\n### 1\. Quick one/);
  assert.match(voice, /### 3\. Dock queues\n\n> Hi Mo,/);
  const led = readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(led.filter((e) => e.type === 'voice_sample').length, 3);
});

test('"none": the voice file drops the fields and the section nothing filled, instead of leaving them blank', () => {
  const H = setup({ attendees: PEOPLE });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const vf = join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md');
  writeFileSync(vf, readFileSync(join(ROOT, 'skills/event-context/templates/voice.md'), 'utf8'));
  const r = answer(H, 'samples', { closest: 'casual and plain', rules: ['Never start with I'], sign_off: 'Thanks, Jess', emails: [] });
  assert.ok(!r.ERROR, r.ERROR);
  const voice = readFileSync(vf, 'utf8');
  assert.match(voice, /^- \*\*Tone:\*\* casual and plain$/m);
  assert.match(voice, /^- \*\*Sign-off:\*\* Thanks, Jess$/m);
  assert.doesNotMatch(voice, /^- \*\*[^*]+:\*\*\s*$/m, 'no empty field lines');
  assert.doesNotMatch(voice, /Emails that got replies/, 'no empty section');
  assert.doesNotMatch(voice, /<[^>\n]{2,}>/, 'no template placeholders');
  assert.match(voice, /## Rules from your feedback\n- Never start with I/);
});
