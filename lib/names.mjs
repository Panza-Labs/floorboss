// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Names in the user's answers turned into contact ids, for the gate and the approval answers, and into the
// CRM's owner values.

import { fold, foldText, suspicious, COMMAND_WORDS, effectsHash } from './reading.mjs';

// The words the list grammar below reads as the edge of a name ("approve Ana and Bo too", "except Ana as well"), and
// those that join or negate: one place, so the names that may stand for someone can't drift from what the parser reads.
const VERBS = ['approve', 'edit', 'drop', 'skip', 'remove', 'reach', 'rescue', 'warm', 'hold', 'leave', 'confirm', 'separate', 'note'];
const START_WORDS = ['and', 'plus', 'also', 'except'];
const END_WORDS = ['and', 'too', 'also', 'anyway'];
const AS_ENDS = ['well', 'is', 'it is', 'they are'];
const JOIN_WORDS = ['and', 'or', 'not', 'but', 'nor', 'plus', 'except', 'too', 'also'];
const GRAMMAR = new Set([...VERBS, ...START_WORDS, ...END_WORDS, 'as', ...AS_ENDS.flatMap((x) => x.split(' ')), ...JOIN_WORDS]);
// A name that may stand for someone: words of letters (any script), apostrophes and hyphens, with an initial ("R.") or
// a "Jr."/"Sr." allowed, and spaces between.
const NAME_WORD = "(?:\\p{L}[\\p{L}'’-]*|\\p{L}\\.|(?:jr|sr)\\.)";
const NAME_SHAPE = new RegExp(`^\\p{L}[\\p{L}'’-]*(?:\\s+${NAME_WORD})*$`, 'u');
// A title before a name, on the list or in the answer ("Ing. Roberto Salgado", "Dr. Paul Stone"): not part of it.
const TITLES = 'dr|dra|ing|arq|lic|prof|mr|mrs|ms|mx|sr|sra|srta';
const TITLE = new RegExp(`^(?:(?:${TITLES})\\.?\\s+)+`);
// A word that links two names ("Ana x Bo", "Ana With Bo"): such a row reads as a list of others, so it goes by id.
const LINK_WORDS = new Set(['x', 'vs', 'versus', 'with', 'w', 'und']);
// Text and names are compared folded (lib/reading.mjs): compatibility forms, invisible characters and combining
// marks out, lower case.
const norm = foldText;
const cleanName = (name) => fold(name).replace(TITLE, '');
const nameParts = (n) => {
  const w = n.split(/[^\p{L}\p{M}\d'’-]+/u).filter(Boolean);
  return { w, parts: [...w, ...w.flatMap((x) => x.split(/['’-]+/).filter(Boolean))] };
};

// A name as it may be shown back to the user: no control or format characters (a right-to-left override, a zero-width
// space), and no longer than a name.
export const shownName = (n) =>
  String(n ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

// Everyone on the list a single word could mean: a word of their name (first name, surname, any part). For the gate's
// question when a name fits more than one ("Which Ana: Ana Costa (c001) or Ana Berg (c002)?").
export function whoCouldBe(word, among) {
  const k = norm(word).trim();
  const seen = new Set();
  return (among || []).filter((p) => {
    if (!k || seen.has(p.id) || !nameParts(cleanName(p.name)).parts.includes(k)) return false;
    seen.add(p.id);
    return true;
  });
}

// People answer with names ("approve ana, drop Chloé Durand"): swap each name that fits one person on the
// list for their ID. people: [{id, name}]. Ambiguous names (two Annas) are left as written, so the gate asks.
// among: everyone on the list, when people holds only those a name may stand for (the gate's own list): who else a
// name could mean is decided over all of them.
// A name counts only as a whole item of a list: after a verb, "except", a comma or "and", and before a comma, "and" or
// the end. No list of words can tell a stray word from a name ("approve Ana minus Bo", with a Minus Ter listed), so
// words between names are left for the gate to refuse, and so are names with only spaces between them.
// readAs: an array that gets what each name was read as ({ said, ids }), for the gate to say back.
export function namesToIds(text, people, among = people, { readAs = null } = {}) {
  const keys = new Map();
  // Two-letter first names count ("Bo", "Jo"), except words a gate answer is made of.
  const WORDS = new Set([
    'an',
    'and',
    'at',
    'by',
    'do',
    'go',
    'if',
    'in',
    'is',
    'it',
    'me',
    'my',
    'no',
    'of',
    'ok',
    'on',
    'or',
    'so',
    'to',
    'up',
    'us',
    'we',
    'all',
    'cap',
    'keep',
    'top',
    'except',
    'not',
    'but',
    'nor',
    'plus',
    'also',
    'too',
    'as',
    'well',
    'anyway',
    'than',
    'because',
    'since',
    'until',
    'with',
    'without'
  ]);
  // A typed id always means that person: a name (or its first word) shaped like an id is never read as a name, or a
  // list row named "c001 Jones" would turn the user's "except c001" into its own id.
  const ID_WORD = /(^|[^\p{L}\d])c\d+(?![\p{L}\d])/iu;
  const add = (k, id) => {
    if (!k || k.length < 2 || WORDS.has(k) || ID_WORD.test(k)) return;
    keys.set(k, keys.has(k) && keys.get(k) !== id ? null : id);
  };
  // Only a name of the plain shape, none of whose words the grammar reads or that links two names, gets a key ("Ana. Bo",
  // "Ana & Bo", "Ana As Well", "Ana x Bo" go by id), and never one written to be confused with others (an invisible
  // character, letters from two scripts). Who else a name could mean is read from every row, keyed or not, each folded
  // so "Аna" with a Cyrillic A is Ana ("Paul R. Stone", "Dr. Paul Stone", a row the gate cut to its first word, all count):
  // - a first name alone, or a name of one word, is that person only when it is no word of any other name: with Sam
  //   Taylor listed, "Taylor" may be him as much as Taylor Reed, and the gate asks which (whoCouldBe).
  // - the whole name of two words or more, typed as listed (a title before it or not), is that person, unless another
  //   row has the same name or holds all of its words ("Maria Lopez" and "Ana Maria Lopez"), every word of it is
  //   someone else's first name ("Ana Bo" beside Ana Berg and Bo Li), or it ends in one letter ("Ana B", "Paul F.").
  // Whether a reading is saved at once or shown back first is decided after (lib/reading.mjs), never here.
  const rows = among.map((p) => ({ id: p.id, n: cleanName(p.name), ...nameParts(cleanName(p.name)) }));
  const plain = people
    .map((p) => ({ p, n: cleanName(p.name) }))
    .filter(({ p, n }) => NAME_SHAPE.test(n) && !ID_WORD.test(n) && !suspicious(p.name) && !n.split(' ').some((x) => GRAMMAR.has(x) || LINK_WORDS.has(x)));
  for (const { p, n } of plain) {
    const rest = rows.filter((x) => x.id !== p.id);
    const firsts = new Set(rest.map((x) => x.w[0]));
    const anyWord = new Set(rest.flatMap((x) => x.parts));
    const w = n.split(' ');
    if (!anyWord.has(w[0])) add(w[0], p.id);
    if (w.length < 2 || /^\p{L}\.?$/u.test(w[w.length - 1]) || rest.some((x) => x.n === n || w.every((q) => x.parts.includes(q))) || w.every((x) => firsts.has(x))) continue;
    add(n, p.id);
  }
  const names = [...keys.entries()].filter(([, v]) => v).sort((a, b) => b[0].length - a[0].length);
  // A gate verb starts a list only where a clause can start, never in the middle of one ("approve Ana skip Bo").
  const NB = '(?<![\\p{L}\\p{N}])';
  const NE = '(?![\\p{L}\\p{N}])';
  const STARTS = `(?<=(?:^|[,·&]|${NB}(?:${START_WORDS.join('|')})\\s|(?:^|[,·&]|${NB}and\\s)\\s*(?:${VERBS.join('|')})\\s)\\s*)`;
  const ENDS = `(?=(?::\\d+)?\\s*(?:$|[,.!&·]|${NB}(?:${[...END_WORDS, 'please', 'thanks', 'thank you', 'gracias'].join('|')})${NE}|as\\s+(?:${AS_ENDS.map((x) => x.replace(' ', '\\s+')).join('|')})${NE}))`;
  // "cap <company-slug> 4" is about a company, never a person: leave those clauses alone.
  return norm(text)
    .split(/(;|\n)/)
    .map((clause) =>
      /^\s*(cap|keep)(?![\p{L}\p{N}])/u.test(clause)
        ? clause
        : names.reduce(
            // A match that is itself an id (or holds one) is the user's own and stays as typed.
            (acc, [k, id]) =>
              acc.replace(new RegExp(`${STARTS}(?<![\\p{L}\\d-])(?:(?:${TITLES})\\.?\\s+)*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\.?')}(?![\\p{L}\\d-])${ENDS}`, 'gu'), (m) => {
                if (ID_WORD.test(m)) return m;
                readAs?.push({ said: m.trim(), ids: [id] });
                return id;
              }),
            clause
          )
    )
    .join('');
}

// The companies a skip answer names, by their whole name ("Ai" isn't in "said"). An answer made only of the words of
// the question ("skip companies", "skip all of them", "no, skip the news") names none, even with a company called News
// on the list. The part about the people ("people: top 5") is another question's.
// The words below lean to skipping everyone: read as "skip all", a word that was a company's name ("skip that", with a
// company called That) only skips more research, never starts any.
const QUESTION_WORDS = new Set(
  "skip no none nothing don't not leave out it them any all everything everyone everybody both each this that these those needed necessary required thank the of for and please pls thanks now today time yet later next company companies research news people".split(' ')
);
const PEOPLE_PART = /[\s,;.]*(?:and\s+)?\b(?:people|persons?|attendees)\b\W*(?:research\W*)?(?:all|top|none|no|skip)\b(?:\s*\d+)?(?=\s*(?:$|[,;.](?![\w-])|and\b))/gi;
// An answer the simple reading would get backwards ("skip all but Globex", "go but skip Acme", "skip nothing"): asked
// again, never read as a list.
export const unclearSkip = (t) => {
  const s = t.replace(PEOPLE_PART, ' ').replace(/\b(?:skip|no)\s+(?:the\s+)?people\b/gi, ' ').trim();
  if (/^(?:don'?t\s+skip|skip\s+(?:nothing|none)\b|no\b.*\b(?:go|ahead|yes)\b)/i.test(s)) return true;
  return /^(?:yes|y|go|ok|sure|research|look|refresh)\b/i.test(s) ? /\b(?:skip|except|but|not|without|leave\s+out)\b/i.test(s) : /\b(?:but|except|besides|other\s+than|apart\s+from|keep)\b/i.test(s);
};
// A company counts as named only as a whole item of the list right after "skip" (or "leave out", "not"): "skip Step,
// Acme" names two. After the name only words that leave it whole may follow ("skip Acme please", "for now", "too", a
// reason, a bracket), and before it "both", or "the" with "one" after ("skip the Acme one"). Anything else is unclear
// and asked again: a name inside other words ("skip this step", "skip Step research", with a company called Step), a
// name beside a refusal ("skip Step, not needed"), a name the answer reaches only through punctuation ("skip, later",
// with a company called Later), or other words beside a name. Unclear never starts research; a plain refusal ("skip
// companies", "skip this step" with no such company) skips them all.
const AFTER_NAME = /^(?:\s*\([^)]*\))?(?:\s+(?:please|pls|thanks|thank\s+you|too|also|as\s+well|for\s+now|for\s+the\s+moment|for\s+this\s+event|one|ones|people|person|guys|folks|team)\b)*(?:\s*\([^)]*\))?(?:\s+(?:because|since|as|they'?re|it'?s)\b[^,;/&+]*)?/u;
const ITEM_END = /^\s*(?:$|[,;&+/!]|\.(?![\p{L}\d])|\b(?:and|plus)\b)/u;
const AFTER_THE = /^\s+(?:one|ones|people|person|guys|folks|team)\b/;
// What may stand beside the companies named: "skip Globex, the rest is fine".
const REMARK_OK = new Set('is are fine ok okay good go ahead research look up please thanks thank you'.split(' '));
// A company named like the question's own words ("Step", "Later", "Research"): named alone it may be the question
// ("skip step"), so it's asked about, never read as that company.
const ORDINARY_NAMES = new Set('step steps later next now this that research web search all none news companies company everything them it both rest others'.split(' '));
export function skipNames(t, listed) {
  const low = t.replace(PEOPLE_PART, ' ').toLowerCase();
  const plainWords = (x) => x.split(/[^\p{L}\d']+/u).filter(Boolean);
  const generic = plainWords(low).every((w) => QUESTION_WORDS.has(w));
  const names = listed.map((co) => [String(co).trim().toLowerCase(), co]).filter(([k]) => k).sort((a, b) => b[0].length - a[0].length);
  const whole = (k, text) => new RegExp(`(?<![\\p{L}\\d.-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\.?[\\p{L}\\d-])`, 'u').test(text);
  const verb = /^\s*(?:skip|leave\s+out|not)\b/.exec(low);
  let rest = verb ? low.slice(verb[0].length).replace(/^\s+(?:only|just)(?![\p{L}\p{N}])/u, '') : low;
  // A name the answer reaches only through punctuation ("skip, later") isn't named after "skip".
  const punctuated = /^\s*[,.;:!?-]/.test(rest);
  const named = new Set();
  let unclear = false,
    refusal = false,
    other = false,
    first = true,
    laterHit = false;
  const hitAt = (r) => names.find(([k]) => r.startsWith(k) && !/^[\p{L}\d-]/u.test(r.slice(k.length)) && !/^\.[\p{L}\d]/u.test(r.slice(k.length)));
  while ((rest = rest.replace(/^(?:\s|[,;&+/:.!?-]|\b(?:and|plus|also)\b)+/u, ''))) {
    let r = rest.replace(/^both\s+/, '');
    const the = /^the\s+/.exec(r);
    let hit = hitAt(r);
    if (!hit && the) {
      const h = hitAt(r.slice(the[0].length));
      if (h && AFTER_THE.test(r.slice(the[0].length + h[0].length))) {
        r = r.slice(the[0].length);
        hit = h;
      }
    }
    if (hit) {
      const after = r.slice(hit[0].length);
      const trail = AFTER_NAME.exec(after)[0];
      // A listed name inside the words after it ("skip Acme as well as Globex", "skip Acme (and Globex)", a reason that
      // names Globex): which are meant is asked.
      if (names.some(([k]) => k !== hit[0] && whole(k, trail))) unclear = true;
      if (ITEM_END.test(after.slice(trail.length))) {
        named.add(hit[1]);
        if (!first || punctuated) laterHit = true;
        rest = after.slice(trail.length);
        first = false;
        continue;
      }
    }
    const item = /^.+?(?=\s*(?:[,;&+/]|\b(?:and|plus)\b|$))/su.exec(rest)?.[0] || rest;
    rest = rest.slice(item.length);
    const w = plainWords(item);
    if (names.some(([k]) => whole(k, item))) {
      unclear = true;
      if (!first || punctuated) laterHit = true;
    } else if (w.every((x) => QUESTION_WORDS.has(x))) refusal = true;
    else if (!w.every((x) => REMARK_OK.has(x))) other = true;
    first = false;
  }
  // Made only of the question's words ("skip companies", "skip all for now"), it skips everyone, unless a listed name
  // stands as a later item of it ("skip companies and News"): then which is meant is asked.
  if (generic) return { named: [], unclear: laterHit };
  if (!named.size) return { named: [], unclear };
  const ordinary = named.size === 1 && ORDINARY_NAMES.has(String([...named][0]).trim().toLowerCase());
  return { named: listed.filter((co) => named.has(co)), unclear: unclear || punctuated || refusal || other || ordinary };
}
export const namedCompanies = (t, listed) => {
  const r = skipNames(t, listed);
  return r.unclear ? [] : r.named;
};

// The owner a typed answer means: the same value, then the same ignoring case, then the one whose first and
// last name are both in the answer (with first: also a first name alone, when only one owner has it). An
// answer that could be two owners matches neither.
export function ownerMatch(said, owners, { first = false } = {}) {
  const t = String(said || '').trim();
  if (!t) return null;
  const exact = owners.find((o) => o === t);
  if (exact) return exact;
  const ci = owners.filter((o) => o.toLowerCase() === t.toLowerCase());
  if (ci.length === 1) return ci[0];
  const words = (x) =>
    x
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9@.'-]+/)
      .filter(Boolean);
  const mine = new Set(words(t));
  const full = owners.filter((o) => {
    const w = words(o);
    return w.length > 1 ? mine.has(w[0]) && mine.has(w[w.length - 1]) : w.length === 1 && w[0].includes('@') && mine.has(w[0]);
  });
  if (full.length === 1) return full[0];
  if (first && !full.length) {
    const byFirst = owners.filter((o) => mine.has(words(o)[0]));
    if (byFirst.length === 1) return byFirst[0];
  }
  return null;
}

// What an answer to "which CRM owner are you?" names, read against the owner values the CRM holds (every one of them,
// as the CRM writes them, in the order the question shows them). An owner is taken when nothing else is in the answer
// but that owner's name and words from OWNER_FILLERS ("that's me, Bram Janssens", "I'm Bram", "yep, Bram Janssens"), or
// its number. Nothing is refused for its wording: an answer that is no owner ("not Bram", "Bram is my boss") is the
// value to save, read back word for word. Returns one of:
//   { owner }                 the value to save: an owner as the CRM writes it, or the user's own words
//   { none: true }            not an owner ("none of these", "I'm not in the CRM", "none") or no CRM ("I don't use a CRM")
//   { ask }                   refused: empty, too long, a number that isn't on the list, or no name at all ("yes" with
//                             several owners, a bare "no")
// A value read from more than the answer's own words, or one that isn't plainly a name or an address (plainOwnerValue),
// carries read_back: why (the answer ends with a question mark; only one owner is listed, so "yes" or "it's just me"
// reads as that owner; the owner's name itself reads like an answer, "None Of These"; a name taken out of a sentence; a
// full name for an owner the CRM writes by first name alone, "Rosa Costa" for "Rosa", with first_of that owner; words
// that are no owner listed here; anything not plainly a name). The caller shows it back word for word and saves it only
// on the user's own yes. elsewhere: the owner is listed at another of the user's events, not here.
// owners: every owner value the question numbers. opts.listed: the question showed them, so "the second one", "2",
// "#2", "number one", "option 2" pick from the first 12. opts.saved: the user's own saved value, an answer with or
// without filler beside it. opts.confirmed: the value the user last saved through the question (on a yes when it was
// read back). opts.known: owners at the user's other events (and older exports here), accepted by name.
// opts.ownDomains: the user's own domains, for "Bram Janssens (bram.janssens@<own domain>)".
// The whole closed list of words that may stand beside an owner's name (a test holds it to a reviewed list, and holds
// every one of them clear of the words that negate or relate).
export const OWNER_FILLERS = Object.freeze([
  "that's me",
  'thats me',
  'that is me',
  "it's me",
  'its me',
  'it is me',
  'is me',
  "i'm",
  'im',
  'i am',
  "it's",
  'its',
  'it is',
  'me',
  'yes',
  'yep',
  'yeah',
  'yup',
  'yes please',
  'correct',
  'right',
  'sure',
  'ok',
  'okay',
  'thanks',
  'thank you',
  'my name is',
  'this is',
  'the name is',
  'just me',
  'only me',
  'ik ben',
  'ich bin',
  'je suis',
  "c'est moi",
  'cest moi',
  'soy',
  'soy yo',
  'yo soy'
]);
const FILLER_SEQ = OWNER_FILLERS.map((f) => f.split(' ')).sort((a, b) => b.length - a.length);
// Single words that are fillers on their own: a first name never stands alone when it is one of them.
const ONE_WORD_FILLERS = new Set(OWNER_FILLERS.filter((f) => !f.includes(' ')));
const OWNER_NOT_MINE =
  /\b(none of (these|them|those|the above)|none|not (an |a )?owner|not (in|on) (it|there|the crm|our crm|my crm|that list|the list|this list)|i'?m not (in|on) (it|there|the crm|our crm|my crm|the list|this list)|(i'?m )?not listed|i own nothing|i don'?t own any(thing)?|nobody|no one|neither)\b/;
const OWNER_NO_CRM = /\b(no crm|don'?t (have|use) (a |any )?crm|not using (a |any )?crm)\b/;
// "It's just me": no CRM when no owners are listed; with one owner listed it reads as that owner, with several it is
// asked which one.
const OWNER_ALONE = /\b((it'?s |its )?just me|only me|i work alone|on my own|by myself)\b/;
const ORDINAL_WORDS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10, eleventh: 11, '11th': 11, twelfth: 12, '12th': 12 };
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export const OWNERS_SHOWN = 12;
const ADDRESS = /[^\s<>()[\],;:"'`]+@[^\s<>()[\],;:"'`]+\.[^\s<>()[\],;:"'`.]+/gu;
const ownerFold = (x) => fold(String(x ?? '').replace(/[‘’ʼ`]/g, "'"));
const ownerTokens = (x) =>
  ownerFold(x)
    .split(/[^\p{L}\p{N}'#-]+/u)
    .map((w) => w.replace(/^['#-]+|['-]+$/g, ''))
    .filter(Boolean);
const fillerOnly = (toks) => {
  let i = 0;
  while (i < toks.length) {
    const f = FILLER_SEQ.find((seq) => seq.every((w, k) => toks[i + k] === w));
    if (!f) return false;
    i += f.length;
  }
  return true;
};
const indexOfSeq = (toks, seq) => {
  const out = [];
  for (let i = 0; i + seq.length <= toks.length; i++) if (seq.every((w, k) => toks[i + k] === w)) out.push(i);
  return out;
};
// The answer with seq taken out at one place, the rest only filler.
const aloneWith = (toks, seq) => indexOfSeq(toks, seq).some((i) => fillerOnly([...toks.slice(0, i), ...toks.slice(i + seq.length)]));

// Nothing but words like "yes", "that's me" or "thanks".
export const fillerOnlyAnswer = (t) => {
  const s = String(t ?? '');
  const w = ownerTokens(s.replace(ADDRESS, ' '));
  return w.length > 0 && !ADDRESS.test(ownerFold(s)) && fillerOnly(w);
};

// Lower-case words a name may hold ("Erik ten Hag", "José María de la Cruz Pérez", "Juan García y López").
const NAME_PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', 'la', 'le', 'les', 'du', 'des', 'da', 'das', 'do', 'dos', 'di', 'del', 'della', 'dei', 'y', 'e', 'bin', 'bint', 'ibn', 'al', 'el', 'zu', 'af', 'av', 'op', "d'", "o'"]);
const isParticle = (x) => x === x.toLowerCase() && NAME_PARTICLES.has(x);
// Words no name is made of, the one list the plain-name check reads: words that speak to an AI or to floorboss, the
// small words of a sentence, negations (in the languages the answer words cover), a relation or a doubt, and the orders
// floorboss reads (its gates' order words, and send in the languages the answer words cover). Kept short: a name that
// holds one ("Ask Hansen", "Tae-woo No", "Mark Hold") is only read back for a yes.
const NOT_NAME_WORDS = new Set(
  (
    'claude assistant ai agent bot chatbot model llm gpt chatgpt floorboss system prompt instruction instructions human user ' +
    'the is are am be it its this that these those them they me my mine your you i we us our and or to of for with ' +
    'all any every each everyone everybody everything anyone anything nobody none nothing now today here please ' +
    'not no never neither nor nope nah niet geen nee nicht kein keine nein pas non jamais nunca ni ' +
    'ask asked boss manager colleague coworker supervisor team lead yes maybe check later dunno unsure unknown ' +
    'approve approved send sent confirm save reply ignore cancel delete override bypass disable choose select pick triage guard checks ahead option answer number ' +
    'skip hold drop dropped remove release unblock rescue warm keep cut stop exclude proceed email book sudo sendall ' +
    'verstuur verzend stuur senden schicken envoyer envoie enviar envia alles tout todo todos'
  ).split(' ')
);
// A name word: letters with an apostrophe or a hyphen inside, or an initial or a title with its full stop ("J.", "Dr.").
const NAME_WORD_SHAPE = /^\p{L}[\p{L}\p{M}'’-]*\.?$/u;
// Plainly an email address, and nothing else.
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,6}$/;
// Plainly a name: one to four name words (a lower-case particle like "de" or "ten" between them aside), single spaces,
// "Last, First" too, letters of one script, nothing invisible, written in one case (all capitalised, or all lower case
// as some sheets write names: "definitely Bram Janssens" is a remark), and no word from NOT_NAME_WORDS.
function plainName(v) {
  let s = String(v ?? '');
  if (!s.trim() || s.length > 80 || suspicious(s) || /[^\S ]/u.test(s)) return false;
  s = s.trim().replace(/ {2,}/g, ' ');
  const comma = /^([^,]+),\s?([^,]+)$/.exec(s);
  if (comma) s = `${comma[2].trim()} ${comma[1].trim()}`;
  const words = s.split(' ');
  if (!words.every((x) => isParticle(x) || NAME_WORD_SHAPE.test(x))) return false;
  const named = words.filter((x) => !isParticle(x));
  if (named.length < 1 || named.length > 4) return false;
  const lower = named.filter((x) => /^\p{Ll}/u.test(x)).length;
  if (lower && lower < named.length) return false;
  return !named.some((x) => fold(x).replace(/\.$/, '').split(/['’-]+/).some((p) => NOT_NAME_WORDS.has(p)));
}
// An owner value that is plainly a name or plainly an email address ("Bram Janssens", "Janssens, Bram", "mark johnson",
// "sam.lee@ai.lanecraft.example"; several spellings "A|B" when each is, a team after " | " is not), saved at once. Anything
// else (a label, a tag, a remark, a negation, a word addressed to Claude or an assistant, an order, or anything this
// can't place) is read back word for word and saved only on the user's yes.
export function plainOwnerValue(v) {
  if (/\s\||\|\s/.test(String(v ?? ''))) return false;
  const parts = String(v ?? '').split('|');
  return parts.every((x) => PLAIN_ADDRESS.test(x.trim()) || plainName(x));
}
// An owner value as it is shown: control and invisible characters out, spaces made single, at most 80 characters (max;
// the read-back that asks to save it shows it whole), in double quotes (a quote mark inside it escaped), so it reads as
// data and nothing in it can pose as part of the text.
export function ownerQuoted(v, max = 80) {
  const s = [
    ...String(v ?? '')
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
      .replace(/[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  ];
  return JSON.stringify(s.length > max ? `${s.slice(0, max).join('')}…` : s.join(''));
}
// An owner named in a reason or a say-back: as written when it is plainly a name or an address, else quoted, as data.
export const ownerSaid = (v) => (plainOwnerValue(v) ? String(v).trim() : ownerQuoted(v));

// The name part of an owner cell, as a person reads it: an address in angle or round brackets ("Bram Janssens
// <bram.janssens@lanecraft.example>"), a nickname in quotes ('Robert "Bob" Smith'), a tag in square or round brackets
// ("Janssens, Bram [Sales]"), a label of up to three words before a colon ("EMEA: Bram Janssens") and a closing ! or ?
// taken out. It is read only to match an answer to the cell; the cell itself is what is offered, read back and saved.
export function ownerNamePart(o) {
  let s = String(o ?? '')
    .replace(/[<(]\s*[^<>()\s@]{1,64}@[^<>()\s]{1,190}\s*[>)]/gu, ' ')
    .replace(/["“”«»„]\s*\p{L}[\p{L}\p{M}'’.-]{0,24}(?:\s+\p{L}[\p{L}\p{M}'’.-]{0,24}){0,2}\s*["“”«»]/gu, ' ')
    .replace(/\[\s*[\p{L}\p{N}][\p{L}\p{M}\p{N}&/.'’ -]{0,30}\]|\(\s*[\p{L}\p{N}][\p{L}\p{M}\p{N}&/.'’ -]{0,30}\)/gu, ' ');
  const label = /^\s*([\p{L}\p{N}][\p{L}\p{M}\p{N}&/.'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{M}\p{N}&/.'’-]*){0,2})\s*:\s+(?=\p{L})/u.exec(s);
  if (label && label[1].length <= 32) s = s.slice(label[0].length);
  return s.replace(/[\s!?？]+$/u, '').replace(/\s+/g, ' ').trim();
}
// Words that make a saved value a sentence, not a name: a negation, a relation, a greeting, a doubt, a yes. Short words
// that are also people's names ("Ok", "Im", "My", "Ben") are not on it; the phrases below catch those sentences.
const SENTENCE_WORDS = new Set(
  'not no never nobody none neither boss manager ask asked with report reports colleague coworker co-worker assistant team dear hello hi think maybe probably guess perhaps yes yeah yep'.split(' ')
);
const SENTENCE_SEQ = [["that's"], ['thats'], ["it's"], ["i'm"], ['that', 'is'], ['it', 'is'], ['i', 'am'], ['my', 'name'], ['the', 'name'], ['this', 'is'], ['is', 'me'], ['just', 'me'], ['only', 'me'], ['me'], ['ik', 'ben'], ['ich', 'bin'], ['je', 'suis'], ["c'est"]];
// A value that reads as a sentence ("that's me, Bram Janssens", "yes that is me I think", "Bram is my boss"), never as
// a name: an address, "Janssens, Bram", "Erik ten Hag" or "Edit Kovács" is not one.
// "I" standing alone (not the initial "I."): a sentence about the user.
const PRONOUN_I = /(^|[\s,;:])i(?=[\s,;:!?]|$)/i;
export function sentenceLike(v) {
  const s = String(v ?? '');
  if (/[?？¿]/.test(s) || PRONOUN_I.test(s)) return true;
  const f = ownerFold(s);
  if (OWNER_NOT_MINE.test(f) || OWNER_NO_CRM.test(f) || OWNER_ALONE.test(f)) return true;
  const w = ownerTokens(s.replace(ADDRESS, ' '));
  return w.some((x) => SENTENCE_WORDS.has(x) || /n't$/.test(x)) || SENTENCE_SEQ.some((seq) => indexOfSeq(w, seq).length > 0);
}
// An owner literally named like an answer ("None Of These", "The First One", "Just Me"): taken only as the whole answer
// (or its number), and read back for a yes. phraseOwner: the whole cell is that phrase (a cell with more beside it is
// read back as any other that isn't plainly a name).
const phraseOwner = (o) => phraseLike(o) && ownerNamePart(o) === String(o ?? '').trim();
const phraseLike = (o) => {
  const f = ownerFold(ownerNamePart(o));
  const w = ownerTokens(ownerNamePart(o));
  return OWNER_NOT_MINE.test(f) || OWNER_NO_CRM.test(f) || OWNER_ALONE.test(f) || (w.length > 0 && w.every((x) => COMMAND_WORDS.has(x) || ONE_WORD_FILLERS.has(x) || x in ORDINAL_WORDS || x in NUMBER_WORDS || /^\d+$/.test(x)));
};
// A first name that never stands alone for an owner: a filler, a negation, a number.
const NOT_A_FIRST_NAME = new Set(['no', 'not', 'none', 'nobody', 'neither', 'nothing', 'nor', 'never', 'one', 'first', 'last', 'number', 'option']);
// An owner's name words without a title in front ("Dr. Anna-Lena Müller" is anna-lena müller).
const OWNER_TITLES = new Set(['dr', 'dra', 'ing', 'arq', 'lic', 'prof', 'mr', 'mrs', 'ms', 'mx', 'sr', 'sra', 'srta']);
const nameTokens = (o) => {
  const w = ownerTokens(ownerNamePart(o));
  let i = 0;
  while (i < w.length - 1 && OWNER_TITLES.has(w[i])) i++;
  return w.slice(i);
};
// An owner value that is an address and nothing else (as a CRM that writes owners by address has them).
const addrOnly = (o) => /@/.test(ownerNamePart(o)) && !/\s/.test(ownerNamePart(o));
// The address in an owner cell beside its name ("Bram Janssens <bram.janssens@lanecraft.example>"), folded, or null.
const cellAddress = (o) => (/<([^<>\s@]{1,64}@[^<>\s]{1,190})>/u.exec(String(o ?? '')) || [])[1]?.toLowerCase() || null;
// A bare no to "are you <owner>?" ("no", "nope", "no, that's not me", "not me").
const BARE_NO = /^(?:(?:no|nope|nah|nee|nein|non)(?:[\s,.!]+(?:(?:that'?s|it'?s|thats|its)\s+)?not\s+me)?|(?:(?:that'?s|it'?s|thats|its)\s+)?not\s+me)$/;

// The words of an answer around a name taken out of it: the filler phrases at its start and end.
const FILLER_EDGE = new RegExp(
  `^(?:(?:${OWNER_FILLERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]?").replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])[\\s,.;:!-]*)+`,
  'iu'
);
const stripFillers = (t) => {
  let s = String(t).trim().replace(/[\s.!?]+$/u, '');
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s.replace(FILLER_EDGE, '').trim();
    // At the end: the same words, read backwards one at a time ("Bram Janssens, thanks", "Bram Janssens, that's me").
    for (const f of [...OWNER_FILLERS].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`[\\s,.;:!-]+${f.replace(/'/g, "['’]?").replace(/ /g, '\\s+')}$`, 'iu');
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        break;
      }
    }
    if (s === before) break;
  }
  return s.replace(/[\s,.;:!-]+$/u, '').trim();
};

export function ownerFromAnswer(said, owners = [], opts = {}) {
  const t = String(said ?? '').trim();
  if (!t) return { ask: 'empty' };
  if (t.length > 200) return { ask: 'too_long' };
  const r = readOwner(t, owners, opts);
  if (r.ask) return r;
  // An answer that asks ("Bram Janssens?", "2?"): never saved as it stands, read back for a yes.
  if (/[?？¿]/.test(t)) r.read_back = 'question';
  // A value that isn't plainly a name or an address: read back word for word, saved only on the user's yes (unless the
  // user already said yes to exactly it: opts.confirmed).
  else if (r.owner != null && !r.read_back && !plainOwnerValue(r.owner) && r.owner !== opts.confirmed) r.read_back = 'doubtful';
  return r;
}
// The user's own words as the value to save, when they are no owner here: words like "that's me" at the edges taken out
// ("that's me, Bram Jansen", "Ask Hansen, that's me") when what is left holds letters and no digits, else the words as
// typed.
const asTyped = (t, why) => {
  const typed = t.replace(/[.!]+$/u, '').replace(/\s+/g, ' ').trim();
  const name = stripFillers(t).replace(/\s+/g, ' ').trim();
  if (name && name !== typed && /\p{L}/u.test(name) && !/\d/.test(name) && !fillerOnly(ownerTokens(name))) return { owner: name, read_back: why || 'taken_out' };
  return why ? { owner: typed, read_back: why } : { owner: typed };
};

function readOwner(t, owners, { listed = false, saved = null, known = [], ownDomains = [] } = {}) {
  const whole = ownerFold(t).replace(/[.!?？\s]+$/u, '').trim();
  const same = (o) => ownerFold(o).replace(/[.!?\s]+$/, '').trim() === whole;
  // The answer is exactly an owner's value (any case or accents); of several written alike, the one as typed.
  const exact = owners.filter(same);
  const exactOne = exact.length === 1 ? exact[0] : exact.find((o) => o.trim() === t);
  if (exactOne) return { owner: exactOne, ...(phraseOwner(exactOne) ? { read_back: 'phrase' } : {}) };
  if (exact.length > 1) return asTyped(t, 'several');
  const valueOk = (v) => typeof v === 'string' && !!v.trim() && !/^not an owner/.test(v) && v.split('|').every((x) => x.trim());
  // The user's own saved value, exactly.
  if (valueOk(saved) && same(saved)) return { owner: saved, kept: true };
  // An owner at another of the user's events, exactly.
  const elsewhere = [...new Set(known.filter((k) => valueOk(k) && same(k)))];
  if (elsewhere.length === 1) return { owner: elsewhere[0], elsewhere: true };
  // Several spellings of one name ("Bram Janssens|B. Janssens"), saved as written. With owners listed and none of them
  // among the spellings, read back. (Whether two of them are different owners, as triage reads names, the saver checks.)
  if (t.includes('|')) {
    const parts = t.split('|').map((x) => x.trim()).filter(Boolean);
    const listedPart = parts.some((x) => [...owners, ...known].some((o) => ownerFold(o) === ownerFold(x)));
    return owners.length && !listedPart ? { owner: parts.join('|'), read_back: 'not_listed' } : { owner: parts.join('|') };
  }
  const addresses = [...whole.matchAll(ADDRESS)].map((m) => m[0].replace(/[.]+$/, ''));
  const toks = ownerTokens(whole.replace(ADDRESS, ' '));
  // The user's own saved value, with nothing but filler beside it.
  if (valueOk(saved) && !sentenceLike(saved)) {
    if (/@/.test(saved) && !/\s/.test(saved.trim())) {
      if (addresses.length === 1 && addresses[0] === ownerFold(saved) && fillerOnly(toks)) return { owner: saved, kept: true };
    } else if (!addresses.length && aloneWith(toks, ownerTokens(saved))) return { owner: saved, kept: true };
  }
  const domains = ownDomains.map((d) => String(d).toLowerCase().replace(/^@/, '')).filter(Boolean);
  // An address beside the name: the owner's own (the owner value itself, or one at the user's own domain whose local
  // part is that owner's name).
  const addressIsTheirs = (a, o) => {
    if (ownerFold(o) === a || cellAddress(o) === a) return true;
    const m = /^([^@]+)@(.+)$/.exec(a);
    if (!m || !domains.some((d) => m[2] === d || m[2].endsWith(`.${d}`))) return false;
    const local = m[1].split(/[._+-]+/).filter(Boolean);
    const ow = nameTokens(o);
    return ow.length > 1 && local.length > 1 && local[0] === ow[0] && local[local.length - 1] === ow[ow.length - 1];
  };
  const firsts = owners.map((o) => nameTokens(o)[0]);
  const hasFiller = toks.some((w) => ONE_WORD_FILLERS.has(w)) || FILLER_SEQ.some((seq) => seq.length > 1 && indexOfSeq(toks, seq).length > 0);
  // A first name alone stands for an owner only when it is a name: two letters or more, not a filler, a negation or a
  // number, and no other owner with that first name. One that is also one of the gates' words ("Edit", "Mark", "Will")
  // needs a self-naming word beside it ("I'm Edit", "that's me, Will").
  const firstAlone = (o, ow) =>
    ow.length > 1 &&
    ow[0].length > 1 &&
    !ONE_WORD_FILLERS.has(ow[0]) &&
    !NOT_A_FIRST_NAME.has(ow[0]) &&
    (!COMMAND_WORDS.has(ow[0]) || hasFiller) &&
    !addrOnly(o) &&
    firsts.filter((f) => f === ow[0]).length === 1;
  // The ways a name is written that triage reads as the same owner: in full, first and last name of a longer one, the
  // two words swapped ("Janssens Bram", and "Bram Janssens" for "Janssens, Bram").
  const ways = (ow) => {
    const seqs = [ow];
    if (ow.length > 2) seqs.push([ow[0], ow[ow.length - 1]]);
    if (ow.length === 2) seqs.push([ow[1], ow[0]]);
    return seqs;
  };
  const matchIn = (list, { first = true } = {}) => {
    const matched = new Set();
    for (const o of list) {
      const ow = nameTokens(o);
      // An owner named like an answer is taken only as the whole answer (above), and read back.
      if (!ow.length || phraseLike(o)) continue;
      if (addrOnly(o)) {
        if (addresses.length === 1 && addresses[0] === ownerFold(ownerNamePart(o)) && fillerOnly(toks)) matched.add(o);
        continue;
      }
      // The address in the cell alone, as the answer ("bram.janssens@lanecraft.example" for "Bram Janssens <…>").
      if (addresses.length === 1 && cellAddress(o) === addresses[0] && fillerOnly(toks)) {
        matched.add(o);
        continue;
      }
      if (!addresses.every((a) => addressIsTheirs(a, o))) continue;
      const seqs = ways(ow);
      // A first name alone, when no other owner has it ("I'm Bram").
      if (first && firstAlone(o, ow)) seqs.push([ow[0]]);
      if (seqs.some((seq) => aloneWith(toks, seq))) matched.add(o);
    }
    // Several cells with this name ("Bram Janssens" and "Bram Janssens [Sales]"): the one that is the name alone.
    const bare = [...matched].filter((o) => ownerNamePart(o) === String(o).trim());
    return matched.size > 1 && bare.length === 1 ? bare : [...matched];
  };
  const matched = matchIn(owners);
  if (matched.length === 1) return { owner: matched[0] };
  if (matched.length > 1) return asTyped(t, 'several');
  // An owner at another of the user's events, by name.
  const there = matchIn(known.filter(valueOk), { first: false });
  if (there.length === 1) return { owner: there[0], elsewhere: true };
  // A CRM that writes an owner by first name alone ("Rosa"), answered with the full name ("Rosa Costa", "that's me, Rosa
  // Costa"): read as that owner when no other owner has that first name, and read back (another Rosa could be meant).
  // The full name is what is saved: triage reads that first name alone as it (crm-triage resolve.mjs ownerIsUserFor),
  // and the user's other events may write it in full.
  if (!addresses.length) {
    const full = stripFillers(t).replace(/\s+/g, ' ').trim();
    const fw = ownerTokens(full);
    const solo = owners.filter((o) => {
      const ow = nameTokens(o);
      return ow.length === 1 && !addrOnly(o) && !phraseLike(o) && ow[0] === fw[0] && firsts.filter((f) => f === ow[0]).length === 1;
    });
    if (
      solo.length === 1 &&
      fw.length >= 2 &&
      fw.length <= 4 &&
      plainOwnerValue(full) &&
      !sentenceLike(full) &&
      full.split(' ').every((x) => /^\p{Lu}/u.test(x) || isParticle(x)) &&
      fw[0].length > 1 &&
      !ONE_WORD_FILLERS.has(fw[0]) &&
      !NOT_A_FIRST_NAME.has(fw[0]) &&
      !COMMAND_WORDS.has(fw[0])
    ) {
      const r = { owner: full, read_back: 'first_name' };
      Object.defineProperty(r, 'first_of', { value: solo[0] });
      return r;
    }
  }
  // "the second one", "2", "#2", "number one", "option 2", "that's me, the 2nd": a number picks from the first 12 the
  // question listed; one that isn't on that list (or with no list shown) is refused.
  if (!addresses.length) {
    const words = toks.filter((w) => !['the', 'number', 'option', 'choice', 'nr'].includes(w));
    let i = 0;
    let rest = [];
    // A bare "me" beside a number is not read as one ("me 2" may be "me too").
    let bareMe = false;
    while (i < words.length) {
      const f = FILLER_SEQ.find((seq) => seq.every((w, k) => words[i + k] === w));
      if (f) {
        if (f.length === 1 && f[0] === 'me') bareMe = true;
        i += f.length;
      } else rest.push(words[i++]);
    }
    if (bareMe) rest = [];
    if (rest.length === 2 && rest[1] === 'one' && (rest[0] in ORDINAL_WORDS || rest[0] === 'last' || /^\d{1,3}(?:st|nd|rd|th)$/.test(rest[0]))) rest = [rest[0]];
    const w = rest.length === 1 ? rest[0] : null;
    if (w && (w === 'last' || w in ORDINAL_WORDS || w in NUMBER_WORDS || /^#?\d{1,3}(?:st|nd|rd|th)?$/.test(w))) {
      const shown = listed ? Math.min(owners.length, OWNERS_SHOWN) : 0;
      const n = w === 'last' ? (owners.length <= OWNERS_SHOWN ? shown : null) : ORDINAL_WORDS[w] ?? NUMBER_WORDS[w] ?? parseInt(w.replace('#', ''), 10);
      if (!n || n < 1 || n > shown) return { ask: 'not_on_list' };
      const r = { owner: owners[n - 1], ...(phraseOwner(owners[n - 1]) ? { read_back: 'phrase' } : {}) };
      // Read by its place in the list (the saver checks that list is the one the question showed).
      Object.defineProperty(r, 'by_number', { value: true });
      return r;
    }
  }
  // The owners the answer mentions at all (a full name, a first name only one owner has, a last name): "I'm not in the
  // CRM, Bram is my boss" is not read as no owner.
  const mentioned = owners.some((o) => {
    const ow = nameTokens(o);
    if (!ow.length) return false;
    if (addrOnly(o)) return addresses.includes(ownerFold(ownerNamePart(o)));
    return indexOfSeq(toks, ow).length > 0 || (ow.length > 1 && toks.includes(ow[ow.length - 1]) && ow[ow.length - 1].length > 2) || (toks.includes(ow[0]) && firsts.filter((f) => f === ow[0]).length === 1);
  });
  // Nothing but "yes", "that's me" or "it's just me": with one owner listed, that owner (read back); with several, it
  // names no one.
  const aloneOnly = toks.length > 0 && !addresses.length && (fillerOnly(toks) || ['i work alone', 'on my own', 'by myself'].some((p) => aloneWith(toks, p.split(' '))));
  if (aloneOnly && owners.length === 1) return { owner: owners[0], read_back: 'only_one' };
  if (OWNER_NOT_MINE.test(whole) || OWNER_NO_CRM.test(whole) || (!owners.length && OWNER_ALONE.test(whole))) return mentioned ? asTyped(t, owners.length ? 'not_listed' : null) : { none: true };
  if (aloneOnly) return { ask: 'no_name' };
  // A bare no ("no", "nope", "not me"): it says who the user isn't, and names no one.
  if (BARE_NO.test(whole.replace(/[\s,.!]+$/u, ''))) return { ask: 'no_name' };
  if (!owners.length && addresses.length === 1) {
    // No owners listed to check it against: an address alone (filler aside) is the value. A name with the user's own
    // address beside it ("Bram Janssens <bram.janssens@<own domain>>") is that name, read back.
    const a = addresses[0];
    // Saved as typed, not folded ("jürgen@müller.de" stays so, and one that isn't plainly an address is read back). A
    // closing mark is no part of it ("jürgen@müller.de!"). One that can't be found as typed is read back.
    const typed = [...t.matchAll(ADDRESS)].flatMap((m) => [m[0], m[0].replace(/[.!?？]+$/u, '')]).find((x) => ownerFold(x) === a);
    if (typed == null) return { owner: a, read_back: 'doubtful' };
    if (fillerOnly(toks)) return a === whole ? { owner: typed } : { owner: typed, read_back: 'taken_out' };
    const own = domains.some((d) => a.split('@')[1] === d || a.split('@')[1].endsWith(`.${d}`));
    const nameOnly = stripFillers(t.replace(ADDRESS, ' ').replace(/[<>()[\]]/g, ' ')).replace(/\s+/g, ' ').trim();
    const nw = ownerTokens(nameOnly);
    const local = a.split('@')[0].split(/[._+-]+/).filter(Boolean);
    if (own && plainOwnerValue(nameOnly) && nw.length > 1 && local.length > 1 && nw[0] === local[0] && nw[nw.length - 1] === local[local.length - 1])
      return { owner: nameOnly, read_back: 'taken_out' };
  }
  // Anything else is the user's own words: saved as typed when it is plainly a name and no owners are listed to check
  // it against, else read back word for word.
  return asTyped(t, owners.length ? 'not_listed' : null);
}

// The saved owner value as it is read. A name, an address, "Last, First", several spellings with "|", or anything else
// that isn't a sentence is the user's, as saved, whether or not this event's CRM lists it. A sentence saved before
// answers were matched ("that's me, Bram Janssens") is read as the one owner it names, or as no owner ("I'm not in the
// CRM"); one that names neither is flagged, so the question is asked again, unless the user's other events list it
// (listed: every owner value at any of their events). "not an owner in the CRM" (the user owns no records) is kept.
export const NOT_AN_OWNER = 'not an owner in the CRM';
// The mark kept (answers: crm_name_saved) that an owner value was saved through the question: the value itself, or for
// one longer than an answer keeps (300 characters), a hash of it, so a long value the user said yes to still matches.
export const ownerSavedMark = (v) => (typeof v === 'string' && v.length > 300 ? `sha256:${effectsHash(v)}` : v);
export function ownerSettingRead(value, owners = [], { listed = [] } = {}) {
  if (!value || typeof value !== 'string' || value === NOT_AN_OWNER || /^not an owner/.test(value)) return { value };
  if (owners.includes(value) || listed.includes(value) || !sentenceLike(value)) return { value };
  const r = ownerFromAnswer(value, owners);
  if (r.owner && !r.read_back && !r.kept && !r.elsewhere) return { value: r.owner, read_from: value };
  if (r.none && !r.read_back) return { value: NOT_AN_OWNER, read_from: value };
  return { value, unmatched: true };
}
