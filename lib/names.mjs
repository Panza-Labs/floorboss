// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Names in the user's answers turned into contact ids, for the gate and the approval answers, and into the
// CRM's owner values.

import { fold, foldText, suspicious } from './reading.mjs';

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
