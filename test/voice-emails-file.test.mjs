// One file holding two emails that got replies is read as two emails: each its own quote, its length counted
// per email, its greeting seen; and the user's own "under 80 words" rule wins over the length read from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli } from './fixtures/harness.mjs';
import { splitEmails, voiceFromEmails, lengthRule } from '../skills/flow/scripts/profile-write.mjs';

// The simulated tester's file, as they had it.
const FILE = `Email 1 (to a Head of Finance Ops, got a reply in a day):
Subject: month-end at Rookfield
Hi Jonas,
Most card issuers I talk to still match settlement files by hand for the last 3% that don't line up. Is that still true for you?
We built Tallyroute to take that last 3% off the team. Happy to show you in 20 minutes if useful.
Maya

Email 2 (to a CFO, got a reply):
Subject: quick one before Ledger Week
Hi Sara,
Saw the new UK e-money safeguarding rules land. Teams we work with are now reconciling client money daily instead of monthly.
Would 15 minutes on Thursday be worth it to compare notes?
Thanks,
Maya
`;
const answer = (H, ask, value) => { mkdirSync(join(H.HOME, 'work'), { recursive: true }); const f = join(H.HOME, 'work', `${ask}.json`); writeFileSync(f, JSON.stringify(value)); return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]); };

test('splitEmails: labels, Subject lines and greetings mark where each email starts; one email with paragraphs stays one', () => {
  const e = splitEmails(FILE);
  assert.deepEqual(e.map((x) => x.subject), ['month-end at Rookfield', 'quick one before Ledger Week']);
  assert.ok(e.every((x) => /^Hi (Jonas|Sara),/.test(x.body)), JSON.stringify(e));
  assert.ok(e.every((x) => !/Email \d/.test(x.body)));
  assert.equal(splitEmails('Hi Ana,\n\nPara one.\n\nPara two.\n\nSam').length, 1);
  assert.equal(splitEmails('Hi Ana,\nOne.\nSam\n\nHi Bo,\nTwo.\nSam').length, 2);
  const v = voiceFromEmails(e.map((x) => x.body));
  assert.equal(v.greeting, '"Hi <first name>,"');
  assert.match(v.length, /^about (40|50) words/);
  assert.equal(lengthRule(['plain words', 'under 80 words']), 'under 80 words (your rule)');
  assert.equal(lengthRule(['shorter']), null);
});

test('samples with that file: two quotes in the voice file, a greeting, and the user\'s length rule as the Length', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nOla Ops,COO,Acme,ola@acme.test\n' });
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const file = join(H.HOME, 'work', 'emails-that-got-replies.md');
  writeFileSync(file, FILE);
  const r = answer(H, 'samples', { closest: 'casual and plain', rules: ['under 80 words'], emails: [file] });
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.emails_saved, 2);
  const voice = readFileSync(join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md'), 'utf8');
  assert.match(voice, /^- \*\*Length:\*\* under 80 words \(your rule\)$/m);
  assert.match(voice, /^- \*\*Greeting:\*\* "Hi <first name>,"$/m);
  assert.match(voice, /### 1\. month-end at Rookfield\n\n> Hi Jonas,/);
  assert.match(voice, /### 2\. quick one before Ledger Week\n\n> Hi Sara,/);
});
