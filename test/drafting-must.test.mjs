// The drafting must-fix rules (2026-11-20 live test as a gun-store software founder): open with the reader, no demo
// framing, subject lines, times on :00 or :30, the short show name, follow-ups that stand alone and shrink, a closing
// last note, "you" over "I/we", one word limit in the skill and the code, and an outbox banner that is true for
// auto-send events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraft, draftWarnings } from '../skills/event-outreach/scripts/checks.mjs';
import { assignSlots } from '../skills/slot-finder/scripts/assign.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { STRUCTURES } from '../skills/event-outreach/scripts/structures.mjs';
import { CONSTANTS } from '../lib/config.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SKILL = readFileSync(join(ROOT, 'skills/event-outreach/SKILL.md'), 'utf8').replace(/\s+/g, ' ');
const CRITIC = readFileSync(join(ROOT, 'agents/outreach-critic.md'), 'utf8').replace(/\s+/g, ' ');

const OPTOUT = "If this isn't relevant, say so and I won't follow up.";
const LABELS = ['Tue 1 Dec, 09:00 New York time', 'Wed 2 Dec, 14:30 New York time'];
const ctx = (over = {}) => ({
  contact: { name: 'Ana Ruiz', company: 'Maple Arms' },
  slotLabels: LABELS,
  eventName: 'Northeast Firearms Retailers Expo 2026',
  eventAliases: ['NEFR Expo'],
  eventDays: ['2026-12-01', '2026-12-02', '2026-12-03'],
  optout: OPTOUT,
  pasteLimit: 600,
  ...over
});
const email = (subject, body) => ({ channel: 'email', subject, body });
// A first message that meets every rule.
const GOOD = `Hi Ana,

Most independent stores lose about an hour a night to end-of-day paperwork and the bound book. Ridgeline Arms in Waco cut that to 15 minutes with Counterline, which leaves your staff on the floor while customers are still in.

Could we take 20 minutes at the NEFR Expo, Tue 1st at 9:00 or Wed 2nd at 14:30, to compare notes on where your store is heading?

Best,
Gary
Counterline Software

${OPTOUT}`;
const fails = (d, c = ctx()) => checkDraft(d, c).join(' | ');

test('a first message that follows every rule passes, with no warnings', () => {
  assert.deepEqual(checkDraft(email('End-of-day paperwork', GOOD), ctx()), []);
  assert.deepEqual(draftWarnings(email('End-of-day paperwork', GOOD), ctx()), []);
});

test('1. the first sentence opens with the reader, never the sender', () => {
  const openers = [
    "I'm Gary from Counterline Software.",
    'I am Gary, founder of Counterline.',
    'My name is Gary and I run Counterline.',
    'I build Counterline Software for store owners.',
    'We build point-of-sale and recordkeeping software for independent stores.',
    'We help gun stores keep their bound book.',
    'I work with independent gun stores on compliance.',
    'I work at Counterline, which builds store software.',
    'I work for Counterline Software.',
    'Gary here, from Counterline.'
  ];
  for (const o of openers) {
    const body = GOOD.replace('Most independent stores lose about an hour a night to end-of-day paperwork and the bound book.', o);
    assert.match(fails(email('End-of-day paperwork', body)), /opens with you/, o);
  }
  // The real failing draft.
  const real = `Hi Ana,\n\nI'm Gary from Counterline Software. We build point-of-sale and recordkeeping software for independent stores. Ridgeline Arms in Waco cut end-of-day paperwork from about an hour to 15 minutes.\n\nCould we meet for 20 minutes at the Northeast Firearms Retailers Expo, Tue 1st at 9:00 or Wed 2nd at 14:30?\n\nGary\n\n${OPTOUT}`;
  assert.match(fails(email('End-of-day paperwork', real)), /opens with you/);
  // "I" later in the message, or a sentence about them that names the sender's product, is fine.
  assert.doesNotMatch(fails(email('End-of-day paperwork', GOOD)), /opens with you/);
  // The user's own opening rule ("start with who I am") is theirs to keep.
  assert.doesNotMatch(fails(email('End-of-day paperwork', real), ctx({ senderOpeningOk: true })), /opens with you/);
  // The skill and the critic teach the order: their situation, relevance, value.
  assert.match(SKILL, /their situation, then why it's relevant to them, then the value/i);
  assert.match(SKILL, /Becc Holland/);
  assert.match(CRITIC, /first sentence is about the sender/i);
  assert.doesNotMatch(STRUCTURES['plain-request'], /^Say plainly who you are/);
});

test('2. no demo framing: the ask is a conversation between peers', () => {
  const phrases = ['I can show you how it tracks inventory.', 'I can walk you through how that was set up.', 'An inventory walkthrough would take 20 minutes.', 'A quick walk-through of the bound book.', 'I can give you a demo.', "I've set aside 20 minutes for you.", 'I have set aside two times.', 'Would a quick call to show the software work?'];
  for (const p of phrases) {
    const body = GOOD.replace('Could we take', `${p} Could we take`);
    assert.match(fails(email('End-of-day paperwork', body)), /demo/, p);
  }
  // A demo the CRM already has ("Demo scheduled") may be named: it's their own history.
  const warm = GOOD.replace('Could we take', 'Ahead of our demo, could we take');
  assert.doesNotMatch(fails(email('End-of-day paperwork', warm), ctx({ factText: '{"status":"Demo scheduled"}' })), /demo/);
  assert.doesNotMatch(SKILL, /I can walk you through/);
  assert.match(CRITIC, /walk you through/);
});

test('3. subject lines: no question mark, no first name, and a warning over 40 characters', () => {
  assert.match(fails(email('20 minutes at the Expo?', GOOD)), /subject .*question/i);
  assert.match(fails(email('Ana, end-of-day paperwork', GOOD)), /subject .*first name/i);
  assert.match(fails(email('Paperwork for ana', GOOD)), /subject .*first name/i);
  // A word that only contains the name is not the name.
  assert.doesNotMatch(fails(email('Banana inventory', GOOD)), /first name/);
  assert.deepEqual(checkDraft(email('Closing time at independent stores', GOOD), ctx()).filter((p) => /subject/.test(p)), []);
  assert.match(draftWarnings(email('End-of-day paperwork and the bound book at your store', GOOD), ctx()).join(' | '), /subject is \d+ characters/);
  assert.deepEqual(draftWarnings(email('End-of-day paperwork', GOOD), ctx()), []);
  // A follow-up's subject is the thread's: not judged.
  assert.doesNotMatch(fails(email('Re: 20 minutes at the Expo?', GOOD), ctx({ followup: true })), /subject/);
  assert.match(SKILL, /About 40 characters at most/);
  assert.match(CRITIC, /subject/i);
});

test('4. times only on the hour or half hour: the check and the slot picker', () => {
  const at = (t) => GOOD.replace('Wed 2nd at 14:30', `Wed 2nd at 14:30 (or ${t})`);
  for (const t of ['11:10', '9:45', '2:15pm', '14h10']) assert.match(fails(email('End-of-day paperwork', at(t))), /on the hour or half hour/, t);
  for (const t of ['11:00', '9:30', '2pm', '10am']) assert.doesNotMatch(fails(email('End-of-day paperwork', at(t))), /on the hour or half hour/, t);
  // Prices and figures aren't times.
  assert.doesNotMatch(fails(email('End-of-day paperwork', GOOD.replace('about an hour', 'about an hour (and $4.15 a box)'))), /half hour/);
  // A time already offered in a message that went (an older slot) may be offered again.
  assert.doesNotMatch(fails(email('x', at('11:10')), ctx({ slotLabels: [...LABELS, 'Thu 3 Dec, 11:10 New York time'] })), /half hour/);

  // The picker offers only slots that start on :00 or :30 (slot ids carry the event-zone time).
  const slot = (id, start, day) => ({ id, start, day });
  const slots = [
    slot('s20261201T1110', '2026-12-01T16:10:00Z', '2026-12-01'),
    slot('s20261202T1110', '2026-12-02T16:10:00Z', '2026-12-02'),
    slot('s20261201T0900', '2026-12-01T14:00:00Z', '2026-12-01'),
    slot('s20261202T0930', '2026-12-02T14:30:00Z', '2026-12-02')
  ];
  const r = assignSlots([{ id: 'c1' }], slots, { max_offers: 3 });
  assert.deepEqual(r.assignments.c1, ['s20261201T0900', 's20261202T0930']);
  // Only off-grid slots left: nobody gets an 11:10, and floorboss says why.
  const off = assignSlots([{ id: 'c1' }, { id: 'c2' }], slots.slice(0, 2), { max_offers: 3 });
  assert.deepEqual(off.openAsk, ['c1', 'c2']);
  assert.equal(off.off_grid, 2);
  const one = assignSlots([{ id: 'c1' }], [...slots.slice(0, 2), slots[2]], { max_offers: 3 });
  assert.deepEqual(one.assignments.c1, ['s20261201T0900']);
  assert.deepEqual(one.short_of_two, ['c1']);
  assert.match(SKILL, /on the hour or the half hour/);
});

test('5. the show by its short name: a warning when the full long name comes back', () => {
  const twice = GOOD.replace('the NEFR Expo', 'the Northeast Firearms Retailers Expo 2026').replace('Hi Ana,\n\n', 'Hi Ana,\n\nBefore the Northeast Firearms Retailers Expo 2026: ');
  assert.match(draftWarnings(email('End-of-day paperwork', twice), ctx()).join(' | '), /full name .*more than once/);
  const once = GOOD.replace('the NEFR Expo', 'the Northeast Firearms Retailers Expo 2026');
  assert.doesNotMatch(draftWarnings(email('End-of-day paperwork', once), ctx()).join(' | '), /full name/);
  // A name with no shorter form has nothing to warn about.
  const short = GOOD.replace('the NEFR Expo', 'FreightWeek').replace('Hi Ana,\n\n', 'Hi Ana,\n\nBefore FreightWeek: ');
  assert.doesNotMatch(draftWarnings(email('End-of-day paperwork', short), ctx({ eventName: 'FreightWeek', eventAliases: [] })).join(' | '), /full name/);
  assert.match(SKILL, /short name everywhere/);
});

const FIRST = GOOD;
const FU = `Hi Ana,

Counterline keeps your bound book and end-of-day counts in one place, so closing takes minutes, not an hour. Stores like yours also use it to get ready for an ATF visit.

Would Tue 1st at 9:00 or Wed 2nd at 14:30 at the NEFR Expo work?

Gary

${OPTOUT}`;
const fu = (over = {}) => ctx({ followup: true, previousBody: FIRST, ...over });

test('6. follow-ups stand alone, shrink, and the last one is a short closing note', () => {
  assert.deepEqual(checkDraft(email('Re: End-of-day paperwork', FU), fu()), []);
  for (const o of ['For the inventory walkthrough, I can show you the bound book.', 'As I mentioned, Counterline keeps the bound book.', 'Following up on my note about the bound book.', 'Further to my email, the bound book matters.', 'Per my last email, the bound book matters.', 'As mentioned, the bound book matters.']) {
    const body = FU.replace('Counterline keeps your bound book and end-of-day counts in one place, so closing takes minutes, not an hour.', o);
    assert.match(fails(email('Re: x', body), fu()), /refers back/, o);
  }
  // Shorter than the one before it (the opt-out line doesn't count).
  assert.match(fails(email('Re: x', FIRST), fu()), /shorter than the message before/);
  // The last touch: says it's the last, names the days at the show, asks only yes or no (no times).
  const LAST = `Hi Ana,\n\nLast note from me on this. I'm at the NEFR Expo Tue 1st to Thu 3rd: is 20 minutes on closing time worth it, yes or no?\n\nGary\n\n${OPTOUT}`;
  const last = fu({ lastTouch: true, previousBody: FU });
  assert.deepEqual(checkDraft(email('Re: x', LAST), last), []);
  assert.match(fails(email('Re: x', LAST.replace('Last note from me on this. ', '')), last), /says it's the last/);
  assert.match(fails(email('Re: x', LAST.replace('Tue 1st to Thu 3rd', 'that week')), last), /days you're at the show/);
  assert.match(fails(email('Re: x', LAST.replace('yes or no?', 'Tue 1st at 9:00 or Wed 2nd at 14:30?')), last), /yes or no/);
  assert.match(SKILL, /never read the earlier email/);
  assert.match(SKILL, /shorter than the one before/);
  assert.match(SKILL, /closing note/);
  assert.match(CRITIC, /never read the earlier/);
});

test('7. "you" over "I/we": a warning when the sender outnumbers the reader', () => {
  const me = GOOD.replace('Most independent stores lose', 'We think, and I agree, that our customers and my team see we lose');
  assert.match(draftWarnings(email('End-of-day paperwork', me), ctx()).join(' | '), /I\/we/);
  assert.match(SKILL, /"you" and "your" more than "I" and "we"/);
});

test('8. one word limit: about 60-100 words for a first email, in the skill and the code; follow-ups shorter', () => {
  assert.equal(CONSTANTS.email_word_limit, 100);
  assert.match(SKILL, /About 60–100 words for a first email/);
  assert.doesNotMatch(SKILL, /40–80 words/);
  const long = GOOD.replace('Could we take', `${'More words here. '.repeat(15)}Could we take`);
  assert.match(fails(email('End-of-day paperwork', long)), /email is \d+ words; the limit is 100/);
  assert.doesNotMatch(fails(email('End-of-day paperwork', GOOD)), /words/);
});

test('9. the outbox banner is true for an auto-send event, and unchanged otherwise', () => {
  const base = { event: { name: 'NEFR Expo', city: 'New York', time_zone: 'America/New_York', start_date: '2026-12-01', end_date: '2026-12-03' }, generatedAt: 'x', cards: [], slots: [], visit: [] };
  const hand = renderOutbox(base);
  assert.match(hand, /You're sending these yourself\. Check the rules that apply to you and your recipients before you send\. floorboss never sends anything\./);
  const auto = renderOutbox({ ...base, event: { ...base.event, autosend: true } });
  assert.doesNotMatch(auto, /floorboss never sends anything|You're sending these yourself/);
  assert.match(auto, /Auto-send is on for this event/);
});
