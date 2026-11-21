// Live Codex run (2026-11-20): first emails named "booth 42037 in Hall G", "9 a.m. Las Vegas time" and "Jan 19 or
// Jan 20", and opened "I'd like to compare...". The checks passed them. They fail now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';

const OPTOUT = "If this isn't relevant, say so and I won't follow up.";
const ctx = (over = {}) => ({
  contact: { name: 'Ana Ruiz', company: 'Maple Arms' },
  slotLabels: ['Tue 1 Dec, 09:00 New York time', 'Wed 2 Dec, 14:30 New York time'],
  eventName: 'Northeast Firearms Retailers Expo 2026',
  eventAliases: ['NEFR Expo'],
  eventCity: 'Las Vegas',
  optout: OPTOUT,
  pasteLimit: 600,
  ...over
});
const GOOD = `Hi Ana,

Most independent stores lose about an hour a night to end-of-day paperwork and the bound book. Ridgeline Arms in Waco cut that to 15 minutes, which leaves your staff on the floor while customers are still in.

Could we take 20 minutes at the NEFR Expo, Tue 1st at 9:00 or Wed 2nd at 14:30, to compare notes on where your store is heading?

Best,
Gary

${OPTOUT}`;
const fails = (body, c = ctx()) => checkDraft({ channel: 'email', subject: 'Closing time', body }, c).join(' | ');
const swap = (a, b) => GOOD.replace(a, b);

test('the good draft passes', () => assert.deepEqual(checkDraft({ channel: 'email', subject: 'Closing time', body: GOOD }, ctx()), []));

test('a meeting place before a yes fails', () => {
  for (const p of ['at booth 42037', 'at Booth #512', 'in Hall G', 'in hall 3', 'at stand 12', 'at table 4'])
    assert.match(fails(swap('at the NEFR Expo,', `${p} at the NEFR Expo,`)), /meeting place/, p);
  assert.match(fails(swap('at the NEFR Expo,', 'in the Sands lounge at the NEFR Expo,'), ctx({ meetingPlace: 'Sands lounge' })), /meeting place/);
  // Words that only look like places are fine.
  assert.doesNotMatch(fails(swap('about an hour', 'about an hour in the hall, at a stand-up table')), /meeting place/);
  // Follow-ups too; a confirmation never goes through the drafting checks.
  assert.match(fails(swap('at the NEFR Expo,', 'at booth 12 at the NEFR Expo,'), ctx({ followup: true })), /meeting place/);
});

test('times are written the way a person types them', () => {
  for (const t of ['PT', 'PST', 'ET', 'EST', 'UTC', 'GMT', 'CET'])
    assert.match(fails(swap('14:30,', `14:30 ${t},`)), /time zone/, t);
  assert.match(fails(swap('14:30,', '14:30 Las Vegas time,')), /Las Vegas time/);
  assert.match(fails(swap('9:00 or', '9:00 New York time or')), /New York time/);
  for (const t of ['9 a.m.', '9 A.M.', '9 am', '9am', '2 p.m', '2PM'])
    assert.match(fails(swap('9:00 or', `${t} or`)), /a\.m\.|am\/pm/, t);
  assert.match(fails(swap('Tue 1st at 9:00 or Wed 2nd', 'Tue Dec 1 at 9:00 or Wed Dec 2')), /month/);
  assert.match(fails(swap('Tue 1st at 9:00 or Wed 2nd', 'Tue 1 Dec at 9:00 or Wed 2 Dec')), /month/);
  assert.match(fails(swap('Tue 1st at 9:00 or Wed 2nd', 'Tue 1st at 9:00 or Wed, December 2nd')), /month/);
  // "Las Vegas" alone, "next time", a month in another sentence, "may" the verb: fine.
  assert.doesNotMatch(fails(swap('Waco', 'Las Vegas')), /time zone|time"|month|a\.m\./);
  assert.doesNotMatch(fails(swap('Could we take', 'Next time we could take')), /time zone|time"|month/);
  assert.doesNotMatch(fails(swap('Most independent', 'Since March 2026 most independent')), /month/);
  assert.doesNotMatch(fails(swap('Could we take', 'You may 5 times over. Could we take')), /month/);
});

test('the first sentence does not open "I\'d like", "I would like", "Let\'s" or "Let us"', () => {
  const real = (o) => `Hi Ana,\n\n${o} compare what your store spends on software with what a full setup costs. Could we take 20 minutes at the NEFR Expo, Tue 1st at 9:00 or Wed 2nd at 14:30?\n\nBest,\nGary\n\n${OPTOUT}`;
  for (const o of ["I'd like to", 'I’d like to', 'I would like to', "Let's", 'Let us']) assert.match(fails(real(o)), /opens with a wish/, o);
  assert.doesNotMatch(fails(real('Your store may want to')), /opens with a wish/);
  assert.doesNotMatch(fails(GOOD.replace('Could we take', "Let's take")), /opens with a wish/);
});
