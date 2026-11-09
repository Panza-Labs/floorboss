// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Names in the user's answers turned into contact ids, for the gate and the approval answers, and into the
// CRM's owner values.

// People answer with names ("approve ana, drop Chloé Durand"): swap each name that fits one person on the
// list for their ID. people: [{id, name}]. Ambiguous names (two Annas) are left as written, so the gate asks.
export function namesToIds(text, people) {
  const norm = (s) =>
    String(s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
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
    'except'
  ]);
  // A typed id always means that person: a name (or its first word) shaped like an id is never read as a name, or a
  // list row named "c001 Jones" would turn the user's "except c001" into its own id.
  const ID_WORD = /(^|[^\p{L}\d])c\d+(?![\p{L}\d])/iu;
  const add = (k, id) => {
    if (!k || k.length < 2 || WORDS.has(k) || ID_WORD.test(k)) return;
    keys.set(k, keys.has(k) && keys.get(k) !== id ? null : id);
  };
  for (const p of people) {
    const n = norm(p.name).trim();
    if (ID_WORD.test(n)) continue;
    add(n, p.id);
    add(n.split(/\s+/)[0], p.id);
  }
  const names = [...keys.entries()].filter(([, v]) => v).sort((a, b) => b[0].length - a[0].length);
  // "cap <company-slug> 4" is about a company, never a person: leave those clauses alone.
  return norm(text)
    .split(/(;|\n)/)
    .map((clause) =>
      /^\s*(cap|keep)\b/.test(clause)
        ? clause
        : names.reduce(
            // A match that is itself an id (or holds one) is the user's own and stays as typed.
            (acc, [k, id]) =>
              acc.replace(new RegExp(`(?<![\\p{L}\\d-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d-])`, 'gu'), (m) => (ID_WORD.test(m) ? m : id)),
            clause
          )
    )
    .join('');
}

// The companies a skip answer names, by their whole name ("Ai" isn't in "said"). An answer made only of the words of
// the question ("skip companies", "skip all of them", "no, skip the news") names none, even with a company called News
// on the list. The part about the people ("people: top 5") is another question's.
const QUESTION_WORDS = new Set("skip no none nothing don't not leave out it them any all everything the of for and please pls thanks now today company companies research news people".split(' '));
const PEOPLE_PART = /[\s,;.]*(?:and\s+)?\b(?:people|persons?|attendees)\b\W*(?:research\W*)?(?:all|top|none|no|skip)\b(?:\s*\d+)?(?=\s*(?:$|[,;.](?![\w-])|and\b))/gi;
// An answer the simple reading would get backwards ("skip all but Globex", "go but skip Acme", "skip nothing"): asked
// again, never read as a list.
export const unclearSkip = (t) => {
  const s = t.replace(PEOPLE_PART, ' ').replace(/\b(?:skip|no)\s+(?:the\s+)?people\b/gi, ' ').trim();
  if (/^(?:don'?t\s+skip|skip\s+(?:nothing|none)\b|no\b.*\b(?:go|ahead|yes)\b)/i.test(s)) return true;
  return /^(?:yes|y|go|ok|sure|research|look|refresh)\b/i.test(s) ? /\b(?:skip|except|but|not|without|leave\s+out)\b/i.test(s) : /\b(?:but|except|besides|other\s+than|apart\s+from|keep)\b/i.test(s);
};
export const namedCompanies = (t, listed) => {
  const low = t.replace(PEOPLE_PART, ' ').toLowerCase();
  if (low.split(/[^\p{L}\d']+/u).every((w) => !w || QUESTION_WORDS.has(w))) return [];
  return listed.filter((co) => {
    const name = String(co).trim().toLowerCase();
    return name && new RegExp(`(?<![\\p{L}\\d.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\.?[\\p{L}\\d-])`, 'u').test(low);
  });
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
