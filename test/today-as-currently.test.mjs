// "Today" meaning "currently" is no date: "When a merchant signs up with Tillmoss today, where does payments come
// into it?" passes the relative-time check, as does the simulated tester's Loopcart question. "Today" next to a time, a day,
// a meeting word or the meeting ask ("today at 10", "meet today", "free today?") still fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeWordsIn } from '../skills/event-outreach/scripts/leadtime.mjs';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';

test('"today" as "currently" passes; "today" as a date fails', () => {
  for (const s of ['When a merchant signs up with Tillmoss today, where does payments come into it?', 'How does a merchant get paid out on Loopcart today, and who set that up?', 'Most platforms today send merchants to a separate signup.'])
    assert.deepEqual(relativeWordsIn(s), [], s);
  for (const s of ['Could you do today at 10?', 'Shall we meet today?', 'Are you free today?', 'I can do 14:30 today.', 'Would today work for a coffee?', 'See you later today.'])
    assert.ok(relativeWordsIn(s).includes('today'), s);
});

test('a draft with "today" as "currently" passes the check; one asking to meet today is told to write the date', () => {
  const ctx = { contact: { name: 'Kate Lindqvist' }, eventName: 'RSF Berlin', factText: '' };
  const body = (s) => `Hi Kate,\n\n${s} Could we take 20 minutes at RSF Berlin, Tue 10th at 13:30 or Wed 11th at 13:30?\n\nBest, Ines`;
  const ok = checkDraft({ channel: 'email', subject: 'RSF Berlin', body: body('When a merchant signs up with Tillmoss today, where does payments come into it?') }, ctx);
  assert.ok(!ok.some((p) => /relative time words/.test(p)), ok.join(' | '));
  const bad = checkDraft({ channel: 'email', subject: 'RSF Berlin', body: body('Or could we meet today at 16:00?') }, ctx);
  assert.ok(bad.some((p) => /relative time words \(today\)/.test(p)), bad.join(' | '));
});
