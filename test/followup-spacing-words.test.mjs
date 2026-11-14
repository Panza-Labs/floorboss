// What a person types for the days between follow-ups, and what they mean: a list of gaps, null (the default) or 'ask'
// (floorboss must refuse and ask again). Each answer is read whole, or refused with the line the model acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGap, GAP_STEPS } from '../lib/gap-words.mjs';

// The reviewer's 249 phrasings (fourth review), with what a person means. One change: an answer over 200 characters
// is refused whole, even when the rest is filler.
const PHRASES = [
  ['3 days is not fine', 'ask'], ['sure, not 3 days', 'ask'], ['3 days apart from weekends', 'ask'], ['3 days or the default', 'ask'], ['default 3', 'ask'], ['3 default', 'ask'],
  ['not 3 days', 'ask'], ['3 days not', 'ask'], ['never 3 days', 'ask'], ["don't wait 3 days", 'ask'], ['no more than 3 days', 'ask'], ['3 days no more', 'ask'], ['less than a week', 'ask'], ['over 3 days', 'ask'], ['under a week', 'ask'], ['above 2', 'ask'], ['below 5', 'ask'], ['3 days or less', 'ask'], ['3 plus', 'ask'], ['3+', 'ask'], ['>3', 'ask'], ['<5 days', 'ask'], ['≥3', 'ask'], ['~3', [3]], ['3ish', 'ask'], ['3-ish', 'ask'],
  ['longer', 'ask'], ['a longer gap', 'ask'], ['a shorter wait', 'ask'], ['a bigger gap of 3 days', 'ask'], ['3 days is too long', 'ask'], ['3 days is too short, make it 5', 'ask'], ['it is fine', 'ask'], ['fine', 'ask'], ['ok', 'ask'], ['sure', 'ask'], ['thanks', 'ask'], ['please', 'ask'], ['a', 'ask'], ['the gap', 'ask'], ['the week', 'ask'], ['day', 'ask'], ['a wait', 'ask'],
  ['a day, two', 'ask'], ['a message a day', [1]], ['every 3', [3]], ['in a week', [7]], ['a day', [1]], ['a week', [7]], ['just a day', [1]], ['about a day', [1]], ['a day or so', 'ask'], ['a day and a week', 'ask'], ['a week and a day', 'ask'], ['a week a day', 'ask'], ['2 days a week', 'ask'], ['3 days in a week', 'ask'], ['a week of 3 days', 'ask'], ['every day of the week', [1]], ['each week a message', [7]], ['a message every week', [7]], ['a message each 3 days', [3]],
  ['weeks: 2', [14]], ['week 2', 'ask'], ['days: 3', [3]], ['gap: 3', [3]], ['gap 3 days', [3]], ['3 gap', [3]], ['wait: a week', [7]], ['2 weeks', [14]], ['3 weeks', 'ask'], ['two weeks', [14]], ['1 week', [7]], ['0 weeks', 'ask'], ['0 days', 'ask'], ['14 days', [14]], ['15 days', 'ask'], ['0', 'ask'], ['00', 'ask'], ['-3', 'ask'], ['- 3 days', 'ask'], ['3 -', 'ask'], ['minus 3', 'ask'],
  ['3 and 5', [3, 5]], ['3 & 5', 'ask'], ['3 + 2', 'ask'], ['3+2 days', 'ask'], ['3 plus 2 days', 'ask'], ['3 days plus a week', 'ask'], ['3x', 'ask'], ['3 x 2', 'ask'], ['3 * 2', 'ask'], ['2 times 3 days', 'ask'], ['double 3', 'ask'], ['3 twice', 'ask'], ['3 3', 'ask'], ['3 days 3 days', 'ask'],
  ['one two three', 'ask'], ['one, two, three', [1, 2, 3]], ['1, two, 3 days', [1, 2, 3]], ['two 3', 'ask'], ['2 three days', 'ask'], ['a 3', [3]], ['an 8 day gap', [8]], ['1 2 3 4 5 6 7', 'ask'], ['1,2,3,4,5,6,7', [1, 2, 3, 4, 5, 6, 7]], ['1, 2, 3, 4, 5, 6, 7, 8', 'ask'], ['1 then 2 then 3 then 4 then 5 then 6 then 7 then 8', 'ask'], ['1,2,3,4,5,6,7,8,9,10', 'ask'],
  ['３ days', 'ask'], ['٣ days', 'ask'], ['३ days', 'ask'], ['3 days', [3]], ['3​days', 'ask'], ['3 days‮', 'ask'], ['𝟑 days', 'ask'], ['Ⅲ days', 'ask'], ['3 days 👍', [3]], ['👍 3 days', [3]], ['3️⃣', 'ask'], ['three days ✅', [3]],
  ['3 days (not weekends)', 'ask'], ['3 days (but 5 for Ana)', 'ask'], ['3 (or 4)', 'ask'], ['(not) 3 days', 'ask'], ['3 days (', 'ask'], ['3 days)', 'ask'], ['the default (but 3 days for email)', 'ask'], ['the default (recommended)', null], ['the default: set by how far off the event is (recommended)', null],
  ['3 days. not really', 'ask'], ['3 days! no, 5', 'ask'], ['3 days - no', 'ask'], ['3 days — or 4', 'ask'], ['3 days: no', 'ask'], ['3 days, no', 'ask'], ['no, 3 days', [3]], ['yes, 3 days', [3]], ['3 days yes', [3]], ['3 days?', 'ask'], ['3 days??', 'ask'], ['is 3 days ok', 'ask'], ['3 days ok', [3]], ['3 days okay?', 'ask'],
  ['the default', null], ['default', null], ['Default.', null], ['the default is fine', null], ['the default is not fine', 'ask'], ['not the default', 'ask'], ['the default, not 3 days', 'ask'], ['back to the default', null], ['go back to the default', null], ['reset', null], ['reset it', null], ['reset to 3', 'ask'], ["don't reset", 'ask'], ['never reset', 'ask'], ['no reset', 'ask'], ['the usual', null], ['as usual', 'ask'], ['unusual', 'ask'], ['abnormal', 'ask'], ['non-standard', 'ask'], ['nonstandard 3', 'ask'], ['the standard gap', null], ['my default', null], ['your default', 'ask'], ['the old default', 'ask'], ['default default', null], ['let the event decide', null], ["don't let the event decide", 'ask'], ['lead time', null], ['no lead time', 'ask'], ['the lead time is 3 days', 'ask'], ['normal 3', 'ask'], ['the normal week', 'ask'],
  ['every other day', [2]], ['every other week', [14]], ['every other', 'ask'], ['the other day', 'ask'], ['every third day', [3]], ['every 3rd day', [3]], ['each second day', 'ask'], ['a couple of days', [2]], ['a couple days', [2]], ['a couple of weeks', [14]], ['couple weeks', [14]], ['a pair of days', 'ask'], ['once a week', [7]], ['once a day', [1]], ['twice a day', 'ask'], ['once every 3 days', [3]], ['once', 'ask'],
  ['48 hours', [2]], ['36 hours', 'ask'], ['72h', [3]], ['0 hours', 'ask'], ['24 hours a day', 'ask'], ['3 days 24 hours', 'ask'], ['1 month', 'ask'], ['a month', 'ask'], ['3 working days', 'ask'], ['3 weekdays', 'ask'], ['3 days email', 'ask'], ['3 days for LinkedIn', 'ask'], ['3 emails', 'ask'], ['3 days between 2 emails', 'ask'], ['3 days between emails', 'ask'], ['3 days between messages', [3]], ['3 days between each message', [3]], ['3 messages', 'ask'], ['3 follow-ups', 'ask'], ['3 days, 2 follow-ups', 'ask'],
  ['3 days then the default', 'ask'], ['3, default', 'ask'], ['3 then nothing', 'ask'], ['3 then stop', 'ask'], ['3 days, then never', 'ask'], ['3 days until Friday', 'ask'], ['3 days starting Monday', 'ask'], ['3 days for now', 'ask'], ['3 days for this event', 'ask'], ['3 days only for Test Expo', 'ask'], ['3 days at this event, a week at the others', 'ask'], ['3 days if they opened it', 'ask'], ['3 days unless they reply', 'ask'],
  ['give me a day', 'ask'], ['give you a week', [7]], ['say it is a week', [7]], ['you say', 'ask'], ['it is 5', [5]], ['make it 5', [5]], ['make 5', [5]], ['give it 5 it is fine', [5]], ['of 5', [5]], ['5 of', [5]], ['about 5', [5]], ['around 5 days', [5]], ['roughly a week', [7]], ['5 or so', 'ask'], ['5 ish', 'ask'], ['5 max', 'ask'],
  ['3 days'.padEnd(250, ' ') + 'not really', 'ask'], ['ok '.repeat(70) + '3 days but not on Mondays', 'ask'], ['3 days ' + 'please '.repeat(40) + 'except never', 'ask'], ['x'.repeat(50000), 'ask'], ['3 days ' + 'a '.repeat(25000), 'ask'], [' '.repeat(300) + '3 days', [3]]
];

const HINT = /If the user plainly meant one of these, answer again in that form \("N days", "N, M days" or "default"\), then say back exactly what was saved\.$/;

test('249 phrasings: each is read as a person means it, or refused with what to type; nothing half read', () => {
  assert.equal(PHRASES.length, 249);
  for (const [said, want] of PHRASES) {
    let got,
      err = null;
    try {
      got = parseGap(said);
    } catch (e) {
      err = e.message;
    }
    const label = JSON.stringify(said.slice(0, 60));
    if (want === 'ask') {
      assert.ok(err, `${label} was saved as ${JSON.stringify(got)}`);
      assert.match(err, HINT, label);
    } else {
      assert.equal(err, null, `${label} refused: ${err}`);
      assert.deepEqual(got, want, label);
      assert.ok(got === null || (got.length >= 1 && got.length <= GAP_STEPS && got.every((n) => Number.isInteger(n) && n >= 1 && n <= 14)), label);
    }
  }
});

// Fifth review: emoji are a closed list, weeks never share a bare number, contradicting units refuse.
const FIFTH = [
  ['3 days ❌', 'ask'], ['🚫 3 days', 'ask'], ['3 days 👎', 'ask'], ['3 days ❓', 'ask'], ['🚫 the default', 'ask'], ['3 days ❤️', 'ask'],
  ['3 days 👍', [3]], ['3 days 👍🏽', [3]], ['✅ a week', [7]], ['2 weeks then 1', 'ask'], ['a week, then 2', 'ask'], ['1 and 2 weeks', 'ask'],
  ['week then 2', 'ask'], ['weeks: 2 days', 'ask'], ['days: 3 weeks', 'ask'], ['3 days, 5', [3, 5]], ['days: 3, 5', [3, 5]],
  ['3 days (recommended).', [3]], ['2, 5 days', [2, 5]], ['a week, then 2 days', [7, 2]], ['every day of the week', [1]]
];
test('fifth-review phrasings: read whole, or refused with what to type', () => {
  for (const [said, want] of FIFTH) {
    let got,
      err = null;
    try {
      got = parseGap(said);
    } catch (e) {
      err = e.message;
    }
    if (want === 'ask') assert.match(err || `saved as ${JSON.stringify(got)}`, HINT, said);
    else assert.deepEqual(err ? `refused: ${err}` : got, want, said);
  }
});
