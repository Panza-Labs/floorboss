// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The days between follow-ups, read from what the user types ("3 days", "a week apart", "2 days, then 5", "every other
// day", "3 días, luego una semana", "the default"). Every word must be read or be on a small closed list of words that
// can't change the meaning; anything left over, a negation, a comparison, an exception, an ordinal, a channel or a
// question refuses the whole answer with what to type. Never half an answer.
import { MAX_ROUTE } from './route.mjs';

// Whole days, at least 1, at most two weeks (a longer wait reads as a new conversation and rarely fits before an
// event), and at most one per follow-up. One number is every gap; several are one per follow-up in turn, the last
// carrying on for any after it.
export const GAP_MIN = 1;
export const GAP_MAX = 14;
export const GAP_STEPS = MAX_ROUTE - 1;
// Every refusal ends with what to type, and with what the model may send for the user (only what they plainly meant).
const TRY =
  'Say how many whole days to leave between messages, from 1 to 14: "3 days", "a week", "2 days, then 5" (a gap for each follow-up in turn), or "the default" (how far off the event is decides). If the user plainly meant one of these, answer again in that form ("N days", "N, M days" or "default"), then say back exactly what was saved.';

const NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  // Spanish, German, French: the numbers a gap uses ("tres días", "drei Tage", "onze jours").
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
  deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14
};
const ORDINALS = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 };
// The only words an answer may hold besides its numbers and units: none of them can change what the numbers mean.
// test/followup-spacing-plan.test.mjs holds this list to a reviewed copy, so it can't quietly grow.
export const FILLER = Object.freeze([
  'a', 'an', 'the', 'of', 'in', 'every', 'each', 'apart', 'between', 'follow-up', 'follow-ups', 'followup', 'followups',
  'message', 'messages', 'gap', 'gaps', 'wait', 'please', 'thanks', 'thank', 'you', 'ok', 'okay', 'sure', 'about', 'around',
  'roughly', 'it', 'give', 'make', 'lets', "let's", 'say', 'is', 'fine', 'just'
]);
const FILL = new Set(FILLER);
// Other languages' words read as English first (whole words only).
const L = (w) => new RegExp(`(?<![\\p{L}])(?:${w})(?![\\p{L}])`, 'gu');
const WORDS = [
  [L('(?:el )?valor por defecto|por defecto|predeterminado|par défaut|par defaut|standardmäßig'), 'default'],
  // Two weeks said as one word is read as weeks ("2 weeks"), so a bare number beside it is refused like any week.
  [L('quince días|quince dias|quinze jours'), '2 weeks'],
  [L('días|dias|tage|tagen|jours'), 'days'],
  [L('día|dia|tag|jour'), 'day'],
  [L('semanas|wochen|semaines'), 'weeks'],
  [L('semana|woche|semaine'), 'week'],
  [L('luego|después|despues|dann|danach|puis|ensuite'), 'then'],
  [L('una|un|une|eine|ein'), 'a'],
  [L('cada|alle|jeden|jede|chaque'), 'every'],
  [L('y'), 'and']
];
const NUM = `\\d+|${Object.keys(NUMBERS).join('|')}`;
// The ways to say "the default", read as one token (DEFAULT) that must stand with filler alone.
const DEFAULT_PHRASE =
  /\bthe default: set by how far off the event is\b|(?:\b(?:go |set it |put it )?back to )?\b(?:the |my )?(?:default|usual|normal|standard)\b(?: one| setting| spacing| gap)?|\breset\b(?: it| the gap)?|\blet the event(?: date)? decide\b|\blead time\b/g;

// The gap from an answer: a number, a list of numbers, or the user's words. null: the default (the table).
export function parseGap(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return parseGap(v.days ?? v.gap ?? v.followup_gap ?? v.said ?? '');
  if (Array.isArray(v) && v.length > GAP_STEPS) throw new Error(`At most ${GAP_STEPS} gaps, one for each follow-up a sequence can have. ${TRY}`);
  const days = Array.isArray(v) ? v.map(wholeDays) : typeof v === 'number' ? [wholeDays(v)] : fromWords(String(v));
  if (days === null) return null;
  if (!days.length) throw new Error(`Name at least one gap. ${TRY}`);
  if (days.length > GAP_STEPS) throw new Error(`At most ${GAP_STEPS} gaps, one for each follow-up a sequence can have. ${TRY}`);
  for (const n of days) {
    if (n < GAP_MIN) throw new Error(`A gap is at least 1 day. ${TRY}`);
    if (n > GAP_MAX) throw new Error(`A gap is at most 14 days (two weeks): a longer wait rarely fits before an event. ${TRY}`);
  }
  return days;
}
function wholeDays(x) {
  const n = typeof x === 'number' ? x : /^\s*\d+\s*$/.test(String(x)) ? Number(x) : NaN;
  if (!Number.isInteger(n)) throw new Error(`Gaps are in whole days ("${String(x).slice(0, 20)}" isn't one). ${TRY}`);
  return n;
}

function fromWords(words) {
  // An answer is short: one over 200 characters (after trimming) is refused whole, never cut and half read.
  const said = String(words).trim();
  const shown = said.slice(0, 60);
  const unclear = () => new Error(`"${shown}" isn't a number of whole days floorboss can read whole. ${TRY}`);
  const refuse = (why) => new Error(`${why} ${TRY}`);
  if (said.length > 200) throw refuse('That answer is too long to read as a gap: say only the days.');
  // An answer that ends on a mark leading to more ("3 days,", "3 days:", "3 days -", "3 days...", "3 days . ." or
  // "3 days…") was cut off: asked again, never saved as what came before it. One full stop or "!" at the end is a
  // sentence's end.
  const cutEnd = /(?:[,;:\-−–—]|\.(?:\s*\.)+|…)[\s.!]*$/;
  if (cutEnd.test(said)) throw unclear();
  let t = said
    .toLowerCase()
    .replace(/[.!]+\s*$/, '')
    // The setup question's own option label is the only bracket read (as nothing); any other bracket is refused.
    .replace(/\s*\(recommended\)\s*$/, '')
    // A short closed list of approving emoji is read as nothing; any other pictograph or symbol refuses ("3 days ❌").
    .replace(/(?:👍|✅|👌|🙂|🙏)[\u{1F3FB}-\u{1F3FF}]?️?/gu, ' ')
    .replace(/[‘’]/g, "'");
  // The same mark before the label or an emoji ("3 days, 👍", "3 days... (recommended)") is cut off too.
  if (cutEnd.test(t)) throw unclear();
  t = t
    .replace(/[.!]+\s*$/, '')
    .replace(/^~\s*(?=\d)/, '')
    .trim();
  if (!t) throw unclear();
  if (/[\p{Extended_Pictographic}\p{So}⃣️]/u.test(t)) throw refuse('Say the gap in words or numbers only: floorboss can\'t read a symbol beside it.');
  if (/[()[\]{}<>]/.test(t)) throw refuse('Say the gap without brackets: everything in the answer is read, and floorboss can\'t read a note beside it.');
  if (/\?|^(?:is|are|can|could|would|should|what|how|when|why|do|does|will|shall|which)\b/.test(t))
    throw refuse('That reads as a question: say the gap you want as it is, like "3 days".');
  if (/\+|&|\*|\bplus\b|\bx\s*\d|\d\s*x\b/.test(t)) throw refuse('Write the total in days, or the gaps in order ("2, then 5"): floorboss doesn\'t add them up.');
  // A plain yes or no before the gap ("no, 3 days") or a yes after it only answers the question asked.
  t = t.replace(/^(?:yes|yeah|yep|no|nope)\s*,\s*/, '').replace(/\s*,?\s*(?:yes|yeah|yep)$/, '');
  for (const [re, en] of WORDS) t = t.replace(re, en);
  // What can't be a gap, each said plainly.
  if (/^your own\b/.test(t)) throw refuse('That option asks for your own days: say them, for example "4 days" or "3 days, then a week".');
  if (/^(?:none|no|no follow-?ups?|zero follow-?ups?|don'?t follow up)$/.test(t))
    throw refuse(
      "The gap only spaces follow-ups that go. To send no follow-ups, the route has to be one message long: that's the route setting (`route`), which the full setup's route question saves (answer it with just \"email\"). For the gap itself:"
    );
  if (/(?:^|[\s,;:])[-−–]\s*\d/.test(t)) throw refuse("A gap can't be negative.");
  if (/\d\.\d/.test(t)) throw refuse(`Gaps are in whole days ("${shown}" has a part day).`);
  if (/\//.test(t)) throw refuse('Gaps are whole days, one per follow-up: write them with commas or "then", like "2, 5, 7" (no fractions or slashes).');
  // "1,5" or "2,5 días" could be a decimal comma: two numbers joined by a comma with no space aren't read as a list.
  const comma = t.match(/\d+(?:,\d+)+/g) || [];
  if (comma.some((g) => g.split(',').length === 2))
    throw refuse(`Is "${comma.find((g) => g.split(',').length === 2)}" a part day, or one gap then another? Gaps are whole days: for one then another, write "1, 5" or "1 then 5".`);
  if (/\b(?:business|working|work|week ?days|weekdays)\b/.test(t))
    throw refuse('floorboss counts calendar days (a planned follow-up that falls on a weekend goes on the Monday): say "3 days", not business days.');
  // Once a day, once a week, once every 3 days: one message each time, so that's the gap.
  t = t.replace(/^once a day$/, '1 day').replace(new RegExp(`^once every (${NUM}) days?$`), '$1 days');
  if (/\b(?:per|times|twice|thrice)\b|\b(?:once|twice) (?:a|every)\b(?! week\b)/.test(t) && !/^(?:once a week|once every week)$/.test(t))
    throw refuse('Say the days between messages, not how many go in a week: "every 2 days", "3 days".');
  if (new RegExp(`\\b(?:${NUM}) (?:more )?(?:follow-?ups?|emails?|messages?|notes?)\\b|\\b(?:every|each) (?:${NUM}) (?:emails?|messages?)\\b|\\b(?:emails?|messages?) (?:${NUM})\\b`).test(t))
    throw refuse('How many messages go is the route (`route`, set in full setup), not the gap: say only the days between them, like "3 days".');
  if (/\b(?:emails?|linkedin|app|event app|e-mail)\b/.test(t))
    throw refuse('Gaps go by follow-up in turn, not by channel: say "3 days, then 5" for the first follow-up and the next.');
  // Plain phrases a person uses for a number of days. Two weeks in any wording is read as weeks ("2 weeks"), so the
  // check for weeks beside a bare number below holds for it too ("a fortnight then 3": days or weeks?).
  t = t
    .replace(/\b(?:a |one )?fortnight\b/g, '2 weeks')
    .replace(/\bevery other day\b/g, '2 days')
    .replace(/\bevery other week\b/g, '2 weeks')
    .replace(/\bevery (\d+)(?:st|nd|rd|th) day\b/g, '$1 days')
    .replace(new RegExp(`\\bevery (${Object.keys(ORDINALS).join('|')}) day\\b`, 'g'), (_, w) => `${ORDINALS[w]} days`)
    .replace(/\b(?:a )?couple(?: of)? days\b/g, '2 days')
    .replace(/\b(?:a )?couple(?: of)? weeks\b/g, '2 weeks')
    // "weeks: 2", "days: 3": the unit, a colon, then how many (another unit after it, "weeks: 2 days", is refused below).
    .replace(new RegExp(`\\b(days?|weeks?)\\s*:\\s*(${NUM})\\s+(?=days?\\b|weeks?\\b)`, 'g'), ' COLON ')
    .replace(new RegExp(`\\b(days?|weeks?)\\s*:\\s*(${NUM})\\b`, 'g'), (_, u, n) => `${n} ${/^w/.test(u) ? 'weeks' : 'days'}`)
    .replace(/\b(?:daily|every day of the week|every day|each day)\b/g, '1 day')
    .replace(/\b(?:weekly|once a week|once every week|every week|each week)\b/g, '1 week')
    .replace(/(\d+)\s*(?:hours?|hrs?|h)\b/g, (m, n) => (Number(n) % 24 === 0 ? `${Number(n) / 24} days` : m))
    .replace(/(\d+)-?\s*(days?|d|weeks?|wks?|w)\b/g, (_, n, u) => `${n} ${/^w/.test(u) ? 'weeks' : 'days'}`)
    .replace(/\blet'?s say\b/g, 'lets say');
  // A week and some days is one total, not two gaps ("a week and 2 days", "1 week, 2 days").
  if (new RegExp(`\\bweeks?\\s*(?:,|and)\\s*(?:a|an|${NUM})\\s*days?\\b|\\bdays?\\s*(?:,|and)\\s*(?:a|an|${NUM})\\s*weeks?\\b`).test(t))
    throw refuse('A week and some days is one gap: write the total in days, like "9 days" (or "a week, then 2 days" for two gaps).');
  // A unit before its number ("week 2") could be a week number: the number comes first.
  if (new RegExp(`\\b(?:days?|weeks?)\\s+(?:${NUM})\\b`).test(t)) throw refuse('Put the number before the unit, like "2 weeks" or "3 days".');
  // An ordinal names one follow-up, and the others would be guessed: every gap is given in order instead.
  if (/\b(?:first|second|third|fourth|fifth|sixth|seventh|last|next|\d+(?:st|nd|rd|th))\b/.test(t))
    throw refuse('Give every gap in order, from the first follow-up on: "3, 5" means 3 days to the first follow-up, then 5 to the next.');
  // Guesses and limits ("a few days", "3 or 4", "up to 5", "day 3, day 7", "between 3 and 5"): asked again.
  const vague = new RegExp(
    `\\b(?:few|several|some|half|or|hours?|hrs?|minutes?|mins?|months?|ish|soon|whenever|maybe|later|depends|more|less|max|maximum|most|least|min|minimum|up to|tomorrow|other)\\b|\\d\\s*(?:-|–|to)\\s*\\d|\\bbetween\\s+(?:${NUM})\\b|\\bfrom\\s+(?:${NUM})\\b|\\bday\\s+(?:${NUM})\\b`
  );
  if (vague.test(t)) throw unclear();
  t = t.replace(DEFAULT_PHRASE, ' DEFAULT ').replace(/\b(?:is fine|give it|make it|lets say|after each(?: one| follow-?up| message)?)\b/g, ' ');
  // An answer that ends on a word leading to more ("3 days, then", "3 días, y", "3 days followed by") was cut off: a
  // gap was probably coming. Refused, never saved as what came before it. "After that" at the end is cut off only
  // when nothing comes before it in its part ("3 days, after that", "3 days: after that", "3 days then after that"):
  // "3 days, then 5 days after that" is whole.
  if (/(?:\bthen|\band|(?:^|[,;:]|\bthen|\band)\s*after that|\bfollowed by)\s*[,;:]?\s*$/.test(t)) throw unclear();
  // Each part read whole: at most one number, with its unit when it has one (day or week, never one on its own).
  const read = [];
  let isDefault = false;
  const parts = t.split(/\s*(?:,|;|\n|\band then\b|\bthen\b|\bafter that\b|\bfollowed by\b|\band\b)\s*/);
  for (const [pi, part] of parts.entries()) {
    const tokens = part.split(/\s+/).map((w) => w.replace(/^["':]+|["':]+$/g, '')).filter(Boolean);
    // The last part with no number, ending on a word that needs one after it ("3 days, the", "3 days, then every"):
    // cut off too, like a lone "a".
    if (pi === parts.length - 1 && tokens.length && !tokens.some((w) => /^\d+$/.test(w) || Object.hasOwn(NUMBERS, w)) && /^(?:the|of|every|each|in)$/.test(tokens[tokens.length - 1]))
      throw unclear();
    let found = null;
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i],
        unit = tokens[i + 1];
      const isUnit = /^(?:days?|weeks?)$/.test(unit || '');
      const n = /^\d+$/.test(w) ? Number(w) : Object.hasOwn(NUMBERS, w) ? NUMBERS[w] : /^an?$/.test(w) && isUnit ? 1 : null;
      if (n == null) {
        if (w === 'DEFAULT') isDefault = true;
        // An article with nothing after it ("3 days, a", "a day, a") is a gap cut off: refused, never read as nothing.
        else if (/^an?$/.test(w) && i === tokens.length - 1) throw unclear();
        // A unit with no number of its own ("week then 2"), or a word that's neither a number nor on the closed list,
        // is a part of the answer not read: refuse it all.
        else if (!FILL.has(w)) throw unclear();
        continue;
      }
      if (found) throw unclear();
      found = { n, unit: isUnit ? (/^w/.test(unit) ? 'w' : 'd') : null, word: !/^\d+$/.test(w) };
      if (isUnit) i++;
    }
    if (found) read.push(found);
    if (read.length > GAP_STEPS) break;
  }
  if (isDefault) {
    if (read.length) throw refuse(`"${shown}" says both the default and a gap: say one of them.`);
    return null;
  }
  if (!read.length) throw unclear();
  // Weeks and a bare number ("2 weeks then 1", "a week, then 2", "1 and 2 weeks"): days or weeks? Refused: give each
  // its unit, or the days. A bare number with days around it is days ("3 days, 5", "2, 5 days"); a number word after a
  // unit ("a day, two") could be either, and is refused.
  if (read.some((x) => x.unit === 'w') && read.some((x) => !x.unit))
    throw refuse('Give each gap its own unit, or write them all in days, like "7, 14 days".');
  if (read.some((x, i) => !x.unit && x.word && read.slice(0, i).some((y) => y.unit))) throw unclear();
  return read.map((x) => (x.unit === 'w' ? x.n * 7 : x.n));
}
